// SPDX-License-Identifier: Apache-2.0
// Runtime events in Pathrule Local: what an application sends through the host (`signals.ingest`),
// grouped the way Pathrule Cloud groups it, read back by MCP and the CLI, and verified per group
// against later releases. Over LocalBackend's SQLite handle, so the class delegates here in one
// line per method.
//
// Nothing here leaves the machine. Every field an application sent is untrusted and is stored as
// data: readers render it through `untrustedText`.

import type Database from "better-sqlite3";
import {
  advanceRuntimeVerification,
  initialRuntimeVerification,
  normalizeRuntimePath,
  RUNTIME_CORRECTION_MAX_REFS,
  RUNTIME_INDICATOR_PATH,
  RUNTIME_CORRECTION_NOTE_MAX,
  RUNTIME_EVENTS_DEFAULT_LIMIT,
  RUNTIME_EVENTS_MAX_LIMIT,
  type RuntimeCorrection,
  type RuntimeCorrectionInput,
  type RuntimeCorrectionResult,
  type RuntimeEventGroup,
  type RuntimeEventHistoryEntry,
  type RuntimeEventIndicator,
  type RuntimeEventsPage,
  type RuntimeEventsQuery,
  type RuntimeEventsStatus,
  type RuntimeGroupStatus,
  type RuntimeIndicatorSnapshot,
  type RuntimeIngestResult,
  type RuntimeVerification,
  type RuntimeVerificationObservation,
  type RuntimeVerificationState,
} from "@pathrule/protocol/runtime-events.js";
import {
  declarationFingerprint,
  MAX_RELEASE_LENGTH,
  normalizeEnvelope,
  type SignalEnvelope,
  type SignalEnvironment,
  type SignalItem,
} from "@pathrule/protocol/runtime-events-wire.js";

type Db = InstanceType<typeof Database>;

const DAY = 86_400_000;
/** The most groups one workspace keeps; a new group past it is not stored. */
export const MAX_LOCAL_RUNTIME_GROUPS = 5_000;
/** How long an envelope id is remembered: longer than the SDK's whole retry schedule. */
const RECEIPT_TTL_MS = 2 * DAY;
/** Resolved groups, release coverage and history are kept this long after they last changed. */
const ARCHIVE_TTL_MS = 90 * DAY;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

/**
 * When an unresolved group stops being current, as Pathrule Cloud decides it: a declaration after
 * 30 days without a refresh, a production group after 14 days without an occurrence, a development
 * or preview group after 7. Reads skip it at once; pruning deletes it later.
 */
function expiredSql(nowIso: string): string {
  const before = (days: number) => `'${new Date(Date.parse(nowIso) - days * DAY).toISOString()}'`;
  return `(g.status = 'declared' AND g.last_seen < ${before(30)}
    OR g.status = 'active' AND g.environment = 'production' AND g.last_seen < ${before(14)}
    OR g.status = 'active' AND g.environment IN ('development', 'preview') AND g.last_seen < ${before(7)})`;
}

/** A group still under a correction attempt stays visible while its verification runs. */
function hiddenSql(nowIso: string): string {
  return `(${expiredSql(nowIso)} AND g.correction IS NULL)`;
}

interface GroupRow {
  workspace_id: string;
  id: string;
  environment: string;
  kind: string;
  fingerprint: string;
  status: string;
  node_path: string | null;
  label: string | null;
  flow: string | null;
  release: string | null;
  message: string | null;
  metadata: string | null;
  occurrence_count: number;
  release_occurrence_count: number;
  first_seen: string;
  last_seen: string;
  revision: number;
  verification: string;
  correction: string | null;
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function toGroup(row: GroupRow): RuntimeEventGroup {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    environment: row.environment as SignalEnvironment,
    kind: row.kind === "event" ? "event" : "error",
    fingerprint: row.fingerprint,
    status: row.status as RuntimeGroupStatus,
    nodePath: row.node_path,
    label: row.label,
    flow: row.flow,
    release: row.release,
    message: row.message,
    metadata: parseJson(row.metadata, null),
    occurrenceCount: row.occurrence_count,
    releaseOccurrenceCount: row.release_occurrence_count,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    revision: row.revision,
    verification: parseJson(row.verification, initialRuntimeVerification()),
    correction: parseJson(row.correction, null),
  };
}

const lastPrune = new WeakMap<Db, number>();

/**
 * Applies one envelope: the shape every collector reads (`normalizeEnvelope`, without an ingest
 * key), once per envelope id, in one transaction. `bytes` is the body's size when the caller knows
 * it.
 */
export function ingestRuntimeEventRows(
  db: Db,
  workspaceId: string,
  raw: unknown,
  options: { bytes?: number; now: string; genId: () => string },
): RuntimeIngestResult {
  const read = normalizeEnvelope(raw, { requireKey: false, bytes: options.bytes });
  if (!read.ok) return { status: "rejected", accepted: 0, declared: 0, error: read.error };
  const { envelope } = read;
  const now = options.now;

  const result = db.transaction((): RuntimeIngestResult => {
    if (envelope.id) {
      const inserted = db
        .prepare(
          "INSERT OR IGNORE INTO runtime_event_receipts (workspace_id, envelope_id, received_at) VALUES (?, ?, ?)",
        )
        .run(workspaceId, envelope.id, now);
      if (inserted.changes === 0) return { status: "duplicate", accepted: 0, declared: 0 };
    }

    db.prepare(
      `INSERT INTO runtime_event_releases (workspace_id, environment, release, envelopes, first_seen, last_seen)
       VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT (workspace_id, environment, release) DO UPDATE SET envelopes = envelopes + 1, last_seen = excluded.last_seen`,
    ).run(workspaceId, envelope.environment, envelope.release ?? "", now, now);

    let groupCount = (
      db
        .prepare("SELECT count(*) AS n FROM runtime_event_groups WHERE workspace_id = ?")
        .get(workspaceId) as {
        n: number;
      }
    ).n;
    const findGroup = db.prepare(
      "SELECT * FROM runtime_event_groups WHERE workspace_id = ? AND environment = ? AND kind = ? AND fingerprint = ?",
    );
    const touched = new Map<string, { row: GroupRow; count: number }>();
    let accepted = 0;
    let declared = 0;

    for (const item of envelope.items) {
      if (item.type === "declaration") {
        const fingerprint = declarationFingerprint(item);
        const existing = findGroup.get(
          workspaceId,
          envelope.environment,
          item.kind,
          fingerprint,
        ) as GroupRow | undefined;
        if (existing) {
          db.prepare(
            "UPDATE runtime_event_groups SET last_seen = ?, node_path = ? WHERE workspace_id = ? AND id = ? AND status = 'declared'",
          ).run(now, item.node ? normalizeRuntimePath(item.node) : null, workspaceId, existing.id);
        } else if (groupCount < MAX_LOCAL_RUNTIME_GROUPS) {
          insertGroup(db, workspaceId, options.genId(), envelope.environment, "declared", now, {
            kind: item.kind,
            fingerprint,
            node: item.node,
            flow: item.flow,
            label: item.label,
            release: envelope.release,
            message: null,
            metadata: null,
            count: 0,
          });
          groupCount += 1;
        } else {
          continue;
        }
        declared += 1;
        continue;
      }

      const existing = findGroup.get(
        workspaceId,
        envelope.environment,
        item.kind,
        item.fingerprint,
      ) as GroupRow | undefined;
      let row: GroupRow;
      if (existing) {
        const sameRelease = (existing.release ?? null) === envelope.release;
        db.prepare(
          `UPDATE runtime_event_groups SET
             occurrence_count = min(occurrence_count + ?, 9007199254740991),
             release_occurrence_count = ?,
             release = ?, message = ?, metadata = ?, last_seen = ?,
             node_path = coalesce(?, node_path), label = coalesce(?, label), flow = coalesce(?, flow)
           WHERE workspace_id = ? AND id = ?`,
        ).run(
          item.countDelta,
          sameRelease ? existing.release_occurrence_count + item.countDelta : item.countDelta,
          envelope.release,
          item.message,
          item.metadata ? JSON.stringify(item.metadata) : null,
          now,
          item.node ? normalizeRuntimePath(item.node) : null,
          item.label,
          item.flow,
          workspaceId,
          existing.id,
        );
        row = db
          .prepare("SELECT * FROM runtime_event_groups WHERE workspace_id = ? AND id = ?")
          .get(workspaceId, existing.id) as GroupRow;
      } else if (groupCount < MAX_LOCAL_RUNTIME_GROUPS) {
        row = insertGroup(db, workspaceId, options.genId(), envelope.environment, "active", now, {
          kind: item.kind,
          fingerprint: item.fingerprint,
          node: item.node,
          flow: item.flow,
          label: item.label,
          release: envelope.release,
          message: item.message,
          metadata: item.metadata,
          count: item.countDelta,
        });
        groupCount += 1;
      } else {
        continue;
      }
      accepted += 1;
      const prior = touched.get(row.id);
      touched.set(row.id, { row, count: (prior?.count ?? 0) + item.countDelta });
    }

    advanceCorrections(db, workspaceId, envelope, now, touched, options.genId);
    return { status: "accepted", accepted, declared };
  })();

  if (Date.parse(now) - (lastPrune.get(db) ?? 0) >= PRUNE_EVERY_MS) {
    lastPrune.set(db, Date.parse(now));
    pruneRuntimeEventRows(db, workspaceId, now);
  }
  return result;
}

function insertGroup(
  db: Db,
  workspaceId: string,
  id: string,
  environment: SignalEnvironment,
  status: RuntimeGroupStatus,
  now: string,
  item: {
    kind: SignalItem["kind"];
    fingerprint: string;
    node: string | null;
    flow: string | null;
    label: string | null;
    release: string | null;
    message: string | null;
    metadata: SignalItem["metadata"];
    count: number;
  },
): GroupRow {
  db.prepare(
    `INSERT INTO runtime_event_groups (workspace_id, id, environment, kind, fingerprint, status, node_path, label, flow,
       release, message, metadata, occurrence_count, release_occurrence_count, first_seen, last_seen, revision,
       verification, correction)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL)`,
  ).run(
    workspaceId,
    id,
    environment,
    item.kind,
    item.fingerprint,
    status,
    item.node ? normalizeRuntimePath(item.node) : null,
    item.label,
    item.flow,
    item.release,
    item.message,
    item.metadata ? JSON.stringify(item.metadata) : null,
    item.count,
    item.count,
    now,
    now,
    JSON.stringify(initialRuntimeVerification()),
  );
  return db
    .prepare("SELECT * FROM runtime_event_groups WHERE workspace_id = ? AND id = ?")
    .get(workspaceId, id) as GroupRow;
}

/**
 * What this envelope proves about every correction under way in its environment: the release sent
 * (coverage), its flows succeeded, and its groups happened again. Evidence counts from the moment
 * observation of a release started, so envelopes sent before a correction was recorded never count.
 */
function advanceCorrections(
  db: Db,
  workspaceId: string,
  { environment, release, items }: SignalEnvelope,
  now: string,
  touched: Map<string, { row: GroupRow; count: number }>,
  genId: () => string,
): void {
  const corrected = db
    .prepare(
      "SELECT * FROM runtime_event_groups WHERE workspace_id = ? AND environment = ? AND correction IS NOT NULL",
    )
    .all(workspaceId, environment) as GroupRow[];
  if (corrected.length === 0) return;

  const successes = new Map<string, number>();
  for (const item of items) {
    if (item.type === "signal" && item.flow && item.metadata?.outcome === "success") {
      successes.set(item.flow, (successes.get(item.flow) ?? 0) + item.countDelta);
    }
  }

  for (const row of corrected) {
    const correction = parseJson<RuntimeCorrection | null>(row.correction, null);
    const before = parseJson(row.verification, initialRuntimeVerification());
    let v = before;
    const step = (observation: RuntimeVerificationObservation) => {
      v = advanceRuntimeVerification(v, correction, row.flow, observation);
    };
    const sameCandidate = () => v.candidateRelease === release;
    step({
      type: "release",
      release,
      at: now,
      envelopes: (sameCandidate() ? v.evidence.candidateEnvelopes : 0) + 1,
    });
    const succeeded = row.flow ? successes.get(row.flow) : undefined;
    if (succeeded && row.flow) {
      step({
        type: "success",
        release,
        flow: row.flow,
        at: now,
        successes: (sameCandidate() ? v.evidence.successes : 0) + succeeded,
      });
    }
    const hit = touched.get(row.id);
    if (hit) step({ type: "occurrence", release, at: now, count: hit.count });

    if (JSON.stringify(v) === JSON.stringify(before)) continue;
    const changedState = v.state !== before.state;
    const status: RuntimeGroupStatus =
      v.state === "verified"
        ? "resolved"
        : v.state === "recurred"
          ? "active"
          : (row.status as RuntimeGroupStatus);
    db.prepare(
      "UPDATE runtime_event_groups SET verification = ?, status = ?, revision = revision + ? WHERE workspace_id = ? AND id = ?",
    ).run(JSON.stringify(v), status, changedState ? 1 : 0, workspaceId, row.id);
    if (changedState) {
      insertHistory(db, workspaceId, genId(), {
        groupId: row.id,
        event: "transition",
        attemptId: correction?.attemptId ?? null,
        from: before.state,
        to: v.state,
        release,
        revision: row.revision + 1,
        at: now,
        payload: { evidence: v.evidence, candidateRelease: v.candidateRelease },
      });
    }
  }
}

function insertHistory(
  db: Db,
  workspaceId: string,
  id: string,
  entry: RuntimeEventHistoryEntry & { payload: unknown },
): void {
  db.prepare(
    `INSERT INTO runtime_event_history (workspace_id, id, group_id, event, attempt_id, from_state, to_state, release,
       revision, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    workspaceId,
    id,
    entry.groupId,
    entry.event,
    entry.attemptId,
    entry.from,
    entry.to,
    entry.release,
    entry.revision,
    JSON.stringify(entry.payload),
    entry.at,
  );
}

function encodeCursor(row: { last_seen: string; id: string }): string {
  return Buffer.from(JSON.stringify([1, row.last_seen, row.id])).toString("base64url");
}

function decodeCursor(cursor: string): { lastSeen: string; id: string } | null {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      value[0] === 1 &&
      typeof value[1] === "string" &&
      typeof value[2] === "string"
    ) {
      return { lastSeen: value[1], id: value[2] };
    }
  } catch {
    // Not a cursor this store wrote.
  }
  return null;
}

/** A path filter: the path itself or anything under it, matched literally (no LIKE wildcards). */
function pathFilter(path: string | undefined): { sql: string; args: string[] } {
  if (!path || path === "/") return { sql: "1", args: [] };
  return {
    sql: "(g.node_path = ? OR substr(g.node_path, 1, length(?) + 1) = ? || '/')",
    args: [path, path, path],
  };
}

/**
 * A declared point stops being listed once it fired: an active group of the same kind and flow at
 * the same path (and, for an event, the same label) in the environment. As Pathrule Cloud reads it.
 */
const FIRED_SQL = `(g.status = 'declared' AND EXISTS (SELECT 1 FROM runtime_event_groups f
  WHERE f.workspace_id = g.workspace_id AND f.environment = g.environment AND f.status = 'active'
    AND f.kind = g.kind AND f.flow IS g.flow AND f.node_path IS g.node_path
    AND (g.kind = 'error' OR f.label IS g.label)))`;

export function listRuntimeEventRows(
  db: Db,
  workspaceId: string,
  query: RuntimeEventsQuery,
  now: string,
): RuntimeEventsPage | { error: string } {
  const limit = Math.min(
    Math.max(query.limit ?? RUNTIME_EVENTS_DEFAULT_LIMIT, 1),
    RUNTIME_EVENTS_MAX_LIMIT,
  );
  const where: string[] = ["g.workspace_id = ?", `NOT ${hiddenSql(now)}`, `NOT ${FIRED_SQL}`];
  const args: unknown[] = [workspaceId];
  if (query.groupId) {
    where.push("g.id = ?");
    args.push(query.groupId);
  }
  const path = pathFilter(query.path ? normalizeRuntimePath(query.path) : undefined);
  where.push(path.sql);
  args.push(...path.args);
  if (query.kind) {
    where.push("g.kind = ?");
    args.push(query.kind);
  }
  if (query.environment) {
    where.push("g.environment = ?");
    args.push(query.environment);
  }
  if (query.status) {
    where.push("g.status = ?");
    args.push(query.status);
  }
  if (query.verification) {
    where.push("json_extract(g.verification, '$.state') = ?");
    args.push(query.verification);
  }
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    if (!cursor) return { error: "invalid_cursor" };
    where.push("(g.last_seen < ? OR (g.last_seen = ? AND g.id < ?))");
    args.push(cursor.lastSeen, cursor.lastSeen, cursor.id);
  }
  const rows = db
    .prepare(
      `SELECT g.* FROM runtime_event_groups g WHERE ${where.join(" AND ")} ORDER BY g.last_seen DESC, g.id DESC LIMIT ?`,
    )
    .all(...args, limit + 1) as GroupRow[];
  const page: RuntimeEventsPage = {
    source: "local",
    items: rows.slice(0, limit).map(toGroup),
    nextCursor: rows.length > limit ? encodeCursor(rows[limit - 1]!) : null,
  };
  if (query.groupId) page.history = historyRows(db, workspaceId, query.groupId);
  return page;
}

function historyRows(db: Db, workspaceId: string, groupId: string): RuntimeEventHistoryEntry[] {
  const rows = db
    .prepare(
      `SELECT group_id, event, attempt_id, from_state, to_state, release, revision, created_at
       FROM runtime_event_history WHERE workspace_id = ? AND group_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50`,
    )
    .all(workspaceId, groupId) as Array<{
    group_id: string;
    event: "correction" | "transition";
    attempt_id: string | null;
    from_state: RuntimeVerificationState | null;
    to_state: RuntimeVerificationState;
    release: string | null;
    revision: number;
    created_at: string;
  }>;
  return rows.map((r) => ({
    groupId: r.group_id,
    event: r.event,
    at: r.created_at,
    attemptId: r.attempt_id,
    from: r.from_state,
    to: r.to_state,
    release: r.release,
    revision: r.revision,
  }));
}

/**
 * The context line's numbers for a path: current error groups under it, and how many of them came
 * back after a correction. Null when there are none, so nothing is shown.
 */
export function runtimeEventIndicatorRow(
  db: Db,
  workspaceId: string,
  path: string | undefined,
  now: string,
): RuntimeEventIndicator | null {
  const normalized = path ? normalizeRuntimePath(path) : "/";
  const filter = pathFilter(normalized);
  const row = db
    .prepare(
      `SELECT count(*) AS active,
         sum(json_extract(g.verification, '$.state') = 'recurred') AS recurred,
         max(g.last_seen) AS last_seen
       FROM runtime_event_groups g
       WHERE g.workspace_id = ? AND g.status = 'active' AND g.kind = 'error' AND NOT ${hiddenSql(now)} AND ${filter.sql}`,
    )
    .get(workspaceId, ...filter.args) as {
    active: number;
    recurred: number | null;
    last_seen: string | null;
  };
  if (!row.active) return null;
  return {
    path: normalized,
    active: row.active,
    recurred: row.recurred ?? 0,
    lastSeen: row.last_seen,
  };
}

/** Current error groups per path, for the hook's file (`RuntimeIndicatorSnapshot`). Bounded. */
export function runtimeIndicatorSnapshotRow(
  db: Db,
  workspaceId: string,
  now: string,
): RuntimeIndicatorSnapshot {
  const rows = db
    .prepare(
      `SELECT g.node_path AS path, count(*) AS active,
         sum(json_extract(g.verification, '$.state') = 'recurred') AS recurred, max(g.last_seen) AS last_seen
       FROM runtime_event_groups g
       WHERE g.workspace_id = ? AND g.status = 'active' AND g.kind = 'error' AND g.node_path IS NOT NULL
         AND NOT ${hiddenSql(now)}
       GROUP BY g.node_path ORDER BY last_seen DESC LIMIT 500`,
    )
    .all(workspaceId) as Array<{ path: string; active: number; recurred: number | null }>;
  const paths: RuntimeIndicatorSnapshot["paths"] = [];
  for (const row of rows) {
    const path = row.path.replace(/^\/+/, "");
    if (!RUNTIME_INDICATOR_PATH.test(path)) continue;
    paths.push({ path, active: row.active, recurred: row.recurred ?? 0 });
  }
  return { v: 1, generatedAt: now, paths };
}

export function runtimeEventStatusRow(
  db: Db,
  workspaceId: string,
  now: string,
): RuntimeEventsStatus {
  const counts = db
    .prepare(
      `SELECT sum(g.status = 'active') AS active, sum(g.status = 'declared' AND NOT ${FIRED_SQL}) AS declared,
         count(*) AS total
       FROM runtime_event_groups g WHERE g.workspace_id = ? AND NOT ${hiddenSql(now)}`,
    )
    .get(workspaceId) as { active: number | null; declared: number | null; total: number };
  const releases = db
    .prepare(
      `SELECT environment, release, envelopes, first_seen, last_seen FROM runtime_event_releases
       WHERE workspace_id = ? ORDER BY last_seen DESC LIMIT 20`,
    )
    .all(workspaceId) as Array<{
    environment: SignalEnvironment;
    release: string;
    envelopes: number;
    first_seen: string;
    last_seen: string;
  }>;
  return {
    source: "local",
    connected: releases.length > 0,
    lastSeen: releases[0]?.last_seen ?? null,
    activeCount: counts.active ?? 0,
    declaredCount: counts.declared ?? 0,
    groupCount: counts.total,
    releases: releases.map((r) => ({
      environment: r.environment,
      release: r.release === "" ? null : r.release,
      envelopes: r.envelopes,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
    })),
  };
}

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * Records a correction attempt on a group: compare-and-set on its revision, once per idempotency
 * key. The fix is measured against `baselineRelease` (the group's latest release when not given):
 * a group without one cannot be verified, and says so.
 */
export function recordRuntimeCorrectionRow(
  db: Db,
  workspaceId: string,
  input: RuntimeCorrectionInput,
  options: { now: string; genId: () => string },
): RuntimeCorrectionResult {
  const { now, genId } = options;
  if (
    !input ||
    typeof input.groupId !== "string" ||
    !ID_PATTERN.test(input.groupId) ||
    typeof input.idempotencyKey !== "string" ||
    !ID_PATTERN.test(input.idempotencyKey) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    (input.baselineRelease != null &&
      (typeof input.baselineRelease !== "string" ||
        input.baselineRelease.length > MAX_RELEASE_LENGTH)) ||
    (input.knowledgeRefs !== undefined && !Array.isArray(input.knowledgeRefs))
  ) {
    return { status: "refused", reason: "invalid", group: null };
  }
  const read = () =>
    db
      .prepare("SELECT * FROM runtime_event_groups WHERE workspace_id = ? AND id = ?")
      .get(workspaceId, input.groupId) as GroupRow | undefined;

  return db.transaction((): RuntimeCorrectionResult => {
    const replay = db
      .prepare(
        "SELECT 1 FROM runtime_event_history WHERE workspace_id = ? AND group_id = ? AND event = 'correction' AND attempt_id = ?",
      )
      .get(workspaceId, input.groupId, input.idempotencyKey);
    const row = read();
    if (!row) return { status: "refused", reason: "not_found", group: null };
    if (replay) return { status: "replayed", group: toGroup(row) };
    if (row.status === "declared")
      return { status: "refused", reason: "declared", group: toGroup(row) };
    if (row.revision !== input.expectedRevision) {
      return { status: "refused", reason: "revision_conflict", group: toGroup(row) };
    }
    const baseline = boundedText(input.baselineRelease, MAX_RELEASE_LENGTH) ?? row.release;
    const correction: RuntimeCorrection = {
      attemptId: input.idempotencyKey,
      recordedAt: now,
      baselineRelease: baseline,
      note: boundedText(input.note, RUNTIME_CORRECTION_NOTE_MAX),
      knowledgeRefs: (input.knowledgeRefs ?? [])
        .filter((ref): ref is string => typeof ref === "string" && ID_PATTERN.test(ref))
        .slice(0, RUNTIME_CORRECTION_MAX_REFS),
      actor: boundedText(input.actor, 128),
    };
    const previous = parseJson(row.verification, initialRuntimeVerification());
    const verification: RuntimeVerification = {
      ...initialRuntimeVerification(),
      updatedAt: now,
      blockedReason: baseline ? null : "no_release",
    };
    db.prepare(
      `UPDATE runtime_event_groups SET correction = ?, verification = ?, status = 'active', revision = revision + 1
       WHERE workspace_id = ? AND id = ?`,
    ).run(JSON.stringify(correction), JSON.stringify(verification), workspaceId, row.id);
    insertHistory(db, workspaceId, genId(), {
      groupId: row.id,
      event: "correction",
      attemptId: correction.attemptId,
      from: previous.state,
      to: verification.state,
      release: baseline,
      revision: row.revision + 1,
      at: now,
      payload: { correction, previous },
    });
    return { status: "recorded", group: toGroup(read()!) };
  })();
}

/**
 * Deletes what retention no longer keeps: expired groups with no correction under way, resolved
 * groups and their history after 90 days, old receipts and release coverage. Local data only.
 */
export function pruneRuntimeEventRows(
  db: Db,
  workspaceId: string,
  now: string,
): { deleted: number } {
  const cutoff = new Date(Date.parse(now) - ARCHIVE_TTL_MS).toISOString();
  const receipts = new Date(Date.parse(now) - RECEIPT_TTL_MS).toISOString();
  return db.transaction(() => {
    const groups = db
      .prepare(
        `DELETE FROM runtime_event_groups AS g WHERE g.workspace_id = ? AND (
           (${expiredSql(now)} AND (g.correction IS NULL OR json_extract(g.correction, '$.recordedAt') < ?))
           OR (g.status = 'resolved' AND coalesce(json_extract(g.verification, '$.updatedAt'), g.last_seen) < ?))`,
      )
      .run(workspaceId, cutoff, cutoff).changes;
    db.prepare(
      `DELETE FROM runtime_event_history WHERE workspace_id = ? AND (created_at < ? OR group_id NOT IN
         (SELECT id FROM runtime_event_groups WHERE workspace_id = ?))`,
    ).run(workspaceId, new Date(Date.parse(now) - 4 * ARCHIVE_TTL_MS).toISOString(), workspaceId);
    db.prepare("DELETE FROM runtime_event_receipts WHERE workspace_id = ? AND received_at < ?").run(
      workspaceId,
      receipts,
    );
    db.prepare("DELETE FROM runtime_event_releases WHERE workspace_id = ? AND last_seen < ?").run(
      workspaceId,
      cutoff,
    );
    return { deleted: groups };
  })();
}
