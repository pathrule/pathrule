// SPDX-License-Identifier: Apache-2.0
/**
 * Where a person's beliefs are kept, as a seam: the local file is one implementation
 * (`createFileUserKnowledgeStore` in user-knowledge-store.ts), a managed account store is another.
 *
 * The store keeps atoms; it decides nothing about them. Stamping, merging evidence, judging status,
 * detecting a change of mind and delivery stay with the engine that reads, decides, and
 * writes back with the version it read. A conflict means somebody else wrote in between: the caller
 * reads again and decides again, it never forces a write. A store never infers, upgrades or merges.
 *
 * Provider-neutral on purpose: a version is an opaque string to compare, a cursor an opaque string to
 * hand back. No revision numbers, table names or provider identifiers reach this contract.
 *
 * Identity is the store's binding, not an argument: the host opens a store for one person (the
 * no-account key, or an account it authenticated). Nothing here moves beliefs between two stores, so a
 * local belief reaches an account only through an explicit, authorized mapping, never by this seam.
 *
 * Browser-safe: no Node import, so a renderer may take the types.
 */
import {
  USER_KNOWLEDGE_STATUSES,
  USER_PRIMITIVES,
  USER_SOURCE_TYPES,
  type UserKnowledgeAtom,
} from "./user-knowledge.js";

/** One stored atom and the version a write must name to replace it. */
export interface UserKnowledgeRecord {
  atom: UserKnowledgeAtom;
  /** Opaque: compare for equality, never parse. */
  version: string;
}

export interface UserKnowledgePage<T> {
  items: T[];
  /** Hand back to read the next page; null after the last one. */
  next: string | null;
}

/** One applied change, kept so "why did this change" stays answerable. */
export interface UserKnowledgeRevision {
  atomId: string;
  kind: "put" | "retire";
  version: string;
  /** The version this one replaced; null when the atom was new. */
  previousVersion: string | null;
  operationId: string;
  at: string;
  /** The atom as this revision stored it. */
  atom: UserKnowledgeAtom;
}

export type UserKnowledgeWrite =
  /** `replayed`: this operation id was applied before, and this is that result, not a second write. */
  | { status: "written"; record: UserKnowledgeRecord; replayed: boolean }
  /** The expected version did not match. `current` is what is stored now (null: nothing is). */
  | { status: "conflict"; current: UserKnowledgeRecord | null };

export interface UserKnowledgeWriteOptions {
  /** The version read before deciding; null to require that the atom does not exist yet. */
  expectedVersion: string | null;
  /**
   * Names the change, so a retried call (a lost response, a re-run) is applied once. Reusing an id
   * for a different change is an error. A conflict consumes nothing: retry with the same id.
   */
  operationId: string;
  now: string;
}

export interface UserKnowledgeStore {
  /** Every stored atom (candidates, retired and rejected included), ordered by id, one page at a time. */
  list(opts?: {
    cursor?: string | null;
    limit?: number;
  }): Promise<UserKnowledgePage<UserKnowledgeRecord>>;
  get(id: string): Promise<UserKnowledgeRecord | null>;
  /** Store an atom exactly as given. It must already be stamped (see `requireStampedUserKnowledge`). */
  put(atom: UserKnowledgeAtom, opts: UserKnowledgeWriteOptions): Promise<UserKnowledgeWrite>;
  /**
   * Retire an atom: superseded by `replacementId` when given (a change of mind), else retired
   * outright. The atom is kept, so the same evidence does not propose it again. A missing atom is a
   * conflict with `current: null`.
   */
  retire(
    id: string,
    opts: UserKnowledgeWriteOptions & { expectedVersion: string; replacementId?: string | null },
  ): Promise<UserKnowledgeWrite>;
  /** An atom's applied revisions, newest first. A store may keep a bounded number of them. */
  history(
    id: string,
    opts?: { cursor?: string | null; limit?: number },
  ): Promise<UserKnowledgePage<UserKnowledgeRevision>>;
}

export const USER_KNOWLEDGE_PAGE_LIMIT = 100;
export const USER_KNOWLEDGE_PAGE_MAX = 500;

export function userKnowledgePageLimit(limit: number | undefined): number {
  return Number.isFinite(limit)
    ? Math.max(1, Math.min(USER_KNOWLEDGE_PAGE_MAX, Math.floor(limit!)))
    : USER_KNOWLEDGE_PAGE_LIMIT;
}

const CONFIDENCES = new Set(["low", "medium", "high"]);

/**
 * The atom a store accepts: fully stamped, as the judgment writes it. A store holds
 * decisions, it does not make them, so an input that still needs stamping is refused here rather
 * than defaulted into something nobody decided.
 */
export function requireStampedUserKnowledge(raw: unknown): UserKnowledgeAtom {
  const a = raw as Partial<UserKnowledgeAtom> | null;
  const fail = (field: string): never => {
    throw new Error(`Not a stamped user knowledge atom: ${field}`);
  };
  if (!a || typeof a !== "object") return fail("value");
  if (a.kind !== "user_knowledge") fail("kind");
  if (a.scope !== "user") fail("scope");
  if (typeof a.id !== "string" || a.id.length === 0 || a.id.length > 200) fail("id");
  if (typeof a.fingerprint !== "string" || a.fingerprint.length === 0) fail("fingerprint");
  if (!USER_PRIMITIVES.includes(a.primitive as never)) fail("primitive");
  if (!USER_KNOWLEDGE_STATUSES.includes(a.status as never)) fail("status");
  if (!USER_SOURCE_TYPES.includes(a.source_type as never)) fail("source_type");
  if (!CONFIDENCES.has(a.confidence as string)) fail("confidence");
  if (typeof a.claim !== "string" || a.claim.trim().length === 0) fail("claim");
  if (!Array.isArray(a.evidence) || a.evidence.length === 0) fail("evidence");
  if (!Array.isArray(a.claim_evidence) || !Array.isArray(a.trigger_evidence)) fail("spans");
  for (const field of ["created_at", "updated_at", "last_observed_at"] as const) {
    if (typeof a[field] !== "string") fail(field);
  }
  for (const field of ["superseded_by", "applies_to_workspace_id", "applies_to_path"] as const) {
    if (a[field] !== null && typeof a[field] !== "string") fail(field);
  }
  return a as UserKnowledgeAtom;
}

/** The retirement a store applies: the lifecycle's own transitions, so stores cannot drift. */
export function retiredUserKnowledge(
  atom: UserKnowledgeAtom,
  replacementId: string | null | undefined,
  now: string,
): UserKnowledgeAtom {
  return replacementId
    ? { ...atom, status: "retired", superseded_by: replacementId, updated_at: now }
    : { ...atom, status: "retired", updated_at: now };
}

/** Every record, page by page. A reader takes whole stores; a person holds dozens. */
export async function listAllUserKnowledge(
  store: UserKnowledgeStore,
): Promise<UserKnowledgeRecord[]> {
  const out: UserKnowledgeRecord[] = [];
  let cursor: string | null = null;
  do {
    const page: UserKnowledgePage<UserKnowledgeRecord> = await store.list({
      cursor,
      limit: USER_KNOWLEDGE_PAGE_MAX,
    });
    out.push(...page.items);
    cursor = page.next;
  } while (cursor !== null);
  return out;
}

/** The record holding this fingerprint, if any: the identity the learning path merges on. */
export async function findUserKnowledgeByFingerprint(
  store: UserKnowledgeStore,
  fingerprint: string,
): Promise<UserKnowledgeRecord | null> {
  return (
    (await listAllUserKnowledge(store)).find((r) => r.atom.fingerprint === fingerprint) ?? null
  );
}

/** A page of `items` (already ordered) after `cursor`, keyed by `keyOf`. */
export function pageAfter<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  opts: { cursor?: string | null; limit?: number } | undefined,
): UserKnowledgePage<T> {
  const limit = userKnowledgePageLimit(opts?.limit);
  const start = opts?.cursor ? items.findIndex((item) => keyOf(item) > opts.cursor!) : 0;
  const from = start === -1 ? items.length : start;
  const slice = items.slice(from, from + limit);
  const more = from + limit < items.length;
  return { items: slice, next: more && slice.length > 0 ? keyOf(slice[slice.length - 1]!) : null };
}

/**
 * The reference store, in memory: the contract's executable definition, and a test double. Versions
 * are a counter, which is as opaque as any other scheme.
 */
export function createMemoryUserKnowledgeStore(
  opts: { maxRevisions?: number } = {},
): UserKnowledgeStore {
  const atoms = new Map<string, UserKnowledgeRecord>();
  const revisions: UserKnowledgeRevision[] = [];
  const maxRevisions = opts.maxRevisions ?? 500;
  let seq = 0;

  const replay = (
    operationId: string,
    atomId: string,
    kind: UserKnowledgeRevision["kind"],
  ): UserKnowledgeWrite | null => {
    const prior = revisions.find((r) => r.operationId === operationId);
    if (!prior) return null;
    if (prior.atomId !== atomId || prior.kind !== kind) {
      throw new Error(`Operation id ${operationId} was already used for a different change`);
    }
    return {
      status: "written",
      record: { atom: prior.atom, version: prior.version },
      replayed: true,
    };
  };

  const apply = (
    atom: UserKnowledgeAtom,
    kind: UserKnowledgeRevision["kind"],
    o: UserKnowledgeWriteOptions,
  ): UserKnowledgeWrite => {
    const current = atoms.get(atom.id) ?? null;
    if ((current?.version ?? null) !== o.expectedVersion) return { status: "conflict", current };
    const record = { atom, version: `v${(seq += 1)}` };
    atoms.set(atom.id, record);
    revisions.push({
      atomId: atom.id,
      kind,
      version: record.version,
      previousVersion: current?.version ?? null,
      operationId: o.operationId,
      at: o.now,
      atom,
    });
    if (revisions.length > maxRevisions) revisions.splice(0, revisions.length - maxRevisions);
    return { status: "written", record, replayed: false };
  };

  return {
    async list(o) {
      return pageAfter(
        [...atoms.values()].sort((a, b) => (a.atom.id < b.atom.id ? -1 : 1)),
        (r) => r.atom.id,
        o,
      );
    },
    async get(id) {
      return atoms.get(id) ?? null;
    },
    async put(raw, o) {
      const atom = requireStampedUserKnowledge(raw);
      return replay(o.operationId, atom.id, "put") ?? apply(atom, "put", o);
    },
    async retire(id, o) {
      const done = replay(o.operationId, id, "retire");
      if (done) return done;
      const current = atoms.get(id) ?? null;
      if (!current) return { status: "conflict", current: null };
      return apply(retiredUserKnowledge(current.atom, o.replacementId, o.now), "retire", o);
    },
    async history(id, o) {
      const newestFirst = revisions
        .filter((r) => r.atomId === id)
        .reverse()
        .map((r, i) => ({ r, key: String(i).padStart(8, "0") }));
      const page = pageAfter(newestFirst, (x) => x.key, o);
      return { items: page.items.map((x) => x.r), next: page.next };
    },
  };
}
