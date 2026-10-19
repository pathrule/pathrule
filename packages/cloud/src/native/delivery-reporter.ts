// SPDX-License-Identifier: Apache-2.0
// Reports a Cloud workspace's knowledge deliveries to Pathrule Cloud, from this machine's session
// ledgers, so the Cloud console's Overview counts them (the Cloud service's knowledge deliveries).
//
// What leaves the machine: per UTC day, each item's kind, id and how many sessions received it.
// Never a session id, a path, a person or content. Each session counts an item once (the protocol's
// delivery-stats.ts); what was already reported is kept per workspace in
// `<home>/cache/<ws>/deliveries-reported.json`. A report is written down before it is sent and
// resent with the same id until the Cloud answers, which applies it once.
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { pathruleHome } from "@pathrule/core/storage/paths.js";
import { readWorkspaceSessionDeliveries } from "@pathrule/integrations/native/delivery-ledger.js";
import {
  countDeliveriesByDay,
  type DeliveryCount,
  type KnowledgeDelivery,
} from "@pathrule/protocol/delivery-stats.js";

/** Entries one report carries; the rest waits for the next run (the Cloud accepts 200). */
export const REPORT_MAX_ENTRIES = 200;
/** How far back unreported deliveries are still sent: inside what the Cloud keeps. */
const REPORT_HORIZON_MS = 170 * 86_400_000;
/** A lock older than this belonged to a process that died mid-report. */
const LOCK_STALE_MS = 60_000;
/** The most often one process reports. */
export const REPORT_INTERVAL_MS = 5 * 60_000;

type Request = <T>(path: string, body?: unknown) => Promise<T>;

interface PendingReport {
  report: string;
  deliveries: DeliveryCount[];
  /** Per session, the item keys this report covers. */
  keys: Record<string, string[]>;
}

interface ReporterState {
  v: 1;
  /** Per session ledger, the item keys (`kind:id`) already reported. */
  sessions: Record<string, string[]>;
  pending: PendingReport | null;
}

function stateFiles(workspaceId: string, env: NodeJS.ProcessEnv) {
  const dir = join(pathruleHome(env), "cache", workspaceId);
  return {
    dir,
    state: join(dir, "deliveries-reported.json"),
    lock: join(dir, "deliveries-reported.lock"),
  };
}

async function readState(path: string): Promise<ReporterState> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<ReporterState>;
    if (value.v === 1 && value.sessions && typeof value.sessions === "object") {
      return { v: 1, sessions: value.sessions, pending: value.pending ?? null };
    }
  } catch {
    // missing or unreadable: start over; the Cloud ignores nothing it already applied twice
  }
  return { v: 1, sessions: {}, pending: null };
}

async function writeState(path: string, state: ReporterState): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
  await rename(temp, path);
}

/**
 * What this machine has reported for a workspace: the item-sessions the Cloud now holds from here,
 * and whether a report still waits for the Cloud's answer. The doctor reads it (./delivery-doctor.ts).
 */
export async function readReportedDeliveries(
  workspaceId: string,
  env: NodeJS.ProcessEnv,
): Promise<{ items: number; pending: boolean }> {
  const state = await readState(stateFiles(workspaceId, env).state);
  return {
    items: Object.values(state.sessions).reduce((sum, keys) => sum + keys.length, 0),
    pending: state.pending !== null,
  };
}

/** Takes the workspace's report lock, or null when another live process holds it. */
async function lock(path: string, now: number): Promise<(() => Promise<void>) | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx");
      await handle.close();
      return () => rm(path, { force: true });
    } catch {
      const age = await stat(path).then(
        (info) => now - info.mtimeMs,
        () => 0,
      );
      if (age < LOCK_STALE_MS) return null;
      await rm(path, { force: true });
    }
  }
  return null;
}

/** The next report: unreported deliveries, at most REPORT_MAX_ENTRIES day-and-item entries. */
export function nextReport(
  sessions: ReadonlyArray<{ session: string; deliveries: readonly KnowledgeDelivery[] }>,
  reported: Readonly<Record<string, readonly string[]>>,
): PendingReport | null {
  const fresh: Array<{ session: string; delivery: KnowledgeDelivery }> = [];
  for (const { session, deliveries } of sessions) {
    const done = new Set(reported[session] ?? []);
    for (const delivery of deliveries)
      if (!done.has(`${delivery.kind}:${delivery.id}`)) fresh.push({ session, delivery });
  }
  fresh.sort((a, b) => Date.parse(a.delivery.at) - Date.parse(b.delivery.at));
  const entries = new Set<string>();
  const taken: typeof fresh = [];
  for (const entry of fresh) {
    const key = `${entry.delivery.at.slice(0, 10)}|${entry.delivery.kind}:${entry.delivery.id}`;
    if (!entries.has(key) && entries.size >= REPORT_MAX_ENTRIES) continue;
    entries.add(key);
    taken.push(entry);
  }
  if (taken.length === 0) return null;
  const keys: Record<string, string[]> = {};
  for (const { session, delivery } of taken)
    (keys[session] ??= []).push(`${delivery.kind}:${delivery.id}`);
  return {
    report: randomUUID().replace(/-/g, ""),
    deliveries: countDeliveriesByDay(taken.map((entry) => entry.delivery)),
    keys,
  };
}

/**
 * Sends this workspace's unreported deliveries, one report per call: a pending one first, then the
 * next. Answers how many deliveries the Cloud now holds from this call, or null when another
 * process is reporting or the Cloud did not answer (it is retried next time).
 */
export async function reportWorkspaceDeliveries(
  workspaceId: string,
  request: Request,
  env: NodeJS.ProcessEnv,
  now = Date.now(),
): Promise<number | null> {
  const files = stateFiles(workspaceId, env);
  await mkdir(files.dir, { recursive: true });
  const release = await lock(files.lock, now);
  if (!release) return null;
  try {
    const state = await readState(files.state);
    const sessions = await readWorkspaceSessionDeliveries(
      workspaceId,
      now - REPORT_HORIZON_MS,
      env,
    );
    // Forget sessions whose ledger fell out of the horizon: they can no longer add anything.
    const live = new Set(sessions.map((entry) => entry.session));
    for (const session of Object.keys(state.sessions))
      if (!live.has(session)) delete state.sessions[session];
    const report = state.pending ?? nextReport(sessions, state.sessions);
    if (!report) {
      await writeState(files.state, state);
      return 0;
    }
    state.pending = report;
    await writeState(files.state, state);
    try {
      await request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/deliveries`, {
        report: report.report,
        deliveries: report.deliveries,
      });
    } catch {
      return null;
    }
    for (const [session, keys] of Object.entries(report.keys))
      state.sessions[session] = [...new Set([...(state.sessions[session] ?? []), ...keys])];
    state.pending = null;
    await writeState(files.state, state);
    return report.deliveries.reduce((sum, entry) => sum + entry.count, 0);
  } finally {
    await release();
  }
}

let lastRun = 0;
let running = false;

/**
 * Reports every attached Cloud workspace's deliveries, at most every REPORT_INTERVAL_MS per process
 * and never two runs at once. Fire and forget: a failure waits for the next run.
 */
export function scheduleDeliveryReports(
  run: () => Promise<{ request: Request; workspaceIds: readonly string[] } | null>,
  env: NodeJS.ProcessEnv,
  now = Date.now(),
): void {
  if (running || now - lastRun < REPORT_INTERVAL_MS) return;
  lastRun = now;
  running = true;
  void (async () => {
    const target = await run();
    if (!target) return;
    for (const workspaceId of target.workspaceIds)
      await reportWorkspaceDeliveries(workspaceId, target.request, env).catch(() => null);
  })()
    .catch(() => undefined)
    .finally(() => {
      running = false;
    });
}
