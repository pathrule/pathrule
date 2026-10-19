// SPDX-License-Identifier: Apache-2.0
/**
 * The one place USER knowledge lives on a machine.
 *
 * Deliberately NOT the LocalBackend: that store is opened per workspace (`openForWorkspace`), and a
 * belief about how a PERSON works must outlive any single workspace. So this is one file per user key
 * under the Pathrule home, written atomically at 0600, next to the identity snapshot and following the
 * same conventions. The host and the CLI both resolve the key the same way and read the
 * same file, which is what stops the two surfaces from growing separate opinions about the same person.
 *
 * The no-account local edition has no user id, so it gets the stable key "local". Signing in later
 * moves the person to their account key; the local file is left alone rather than silently merged,
 * because quietly attributing one person's beliefs to another account is worse than starting fresh.
 *
 * A corrupt or unreadable file degrades to "no user knowledge", never to a crash. This layer is
 * advisory by construction, so its absence must cost nothing: deterministic behaviour and workspace
 * knowledge do not depend on it.
 */
import { createHash } from "node:crypto";
import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../storage/atomic-write.js";
import { PATHRULE_FILE_MODE, hashUserIdForPath, pathruleHome } from "../storage/paths.js";
import {
  isUserKnowledgeDeliverable,
  userKnowledgeApplies,
  type UserKnowledgeAtom,
  type UserKnowledgeWhere,
} from "./user-knowledge.js";
import {
  pageAfter,
  requireStampedUserKnowledge,
  retiredUserKnowledge,
  type UserKnowledgeRecord,
  type UserKnowledgeRevision,
  type UserKnowledgeStore,
  type UserKnowledgeWrite,
  type UserKnowledgeWriteOptions,
} from "./user-knowledge-persistence.js";

/** The key for the no-account local edition. Hashed like any other key, so the layout is uniform. */
export const LOCAL_USER_KEY = "local";

export interface UserKnowledgeFile {
  schema_version: 1;
  user_key: string;
  atoms: UserKnowledgeAtom[];
  updated_at: string;
}

export function userKnowledgePath(userKey: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(pathruleHome(env), "user-intelligence", `${hashUserIdForPath(userKey)}.json`);
}

/** Signed-in id when there is one, else the local edition key. Both surfaces must call exactly this. */
export function resolveUserKey(userId: string | null | undefined): string {
  const id = (userId ?? "").trim();
  return id === "" ? LOCAL_USER_KEY : id;
}

function parseFile(raw: unknown, userKey: string): UserKnowledgeFile | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o["schema_version"] !== 1) return null;
  const atoms = Array.isArray(o["atoms"]) ? o["atoms"] : [];
  // Defensive: a malformed atom is skipped, never fatal to the whole file.
  const kept: UserKnowledgeAtom[] = [];
  for (const a of atoms) {
    if (!a || typeof a !== "object") continue;
    const r = a as Record<string, unknown>;
    if (r["kind"] !== "user_knowledge" || typeof r["id"] !== "string" || typeof r["claim"] !== "string") continue;
    // The stored status is read as written.
    kept.push(a as UserKnowledgeAtom);
  }
  return {
    schema_version: 1,
    user_key: typeof o["user_key"] === "string" ? o["user_key"] : userKey,
    atoms: kept,
    updated_at: typeof o["updated_at"] === "string" ? o["updated_at"] : "",
  };
}

/** The atoms as stored, before today's rules are applied: what a store version is computed over. */
async function readStoredAtoms(
  userKey: string,
  env: NodeJS.ProcessEnv,
): Promise<UserKnowledgeAtom[]> {
  try {
    const raw = await readFile(userKnowledgePath(userKey, env), "utf8");
    return parseFile(JSON.parse(raw), userKey)?.atoms ?? [];
  } catch {
    return [];
  }
}

/** Every stored atom for this person, including candidates and retired ones (the inspect surface wants them). */
export async function readUserKnowledge(userKey: string, env: NodeJS.ProcessEnv = process.env): Promise<UserKnowledgeAtom[]> {
  try {
    const raw = await readFile(userKnowledgePath(userKey, env), "utf8");
    return parseFile(JSON.parse(raw), userKey)?.atoms ?? [];
  } catch {
    return [];
  }
}

/**
 * One read-modify-write at a time per store file inside this process. Words (the observer queue) and
 * behaviour (turn boundaries) now both write here, and two interleaved read-modify-writes would silently
 * drop whichever landed first.
 */
const writeQueues = new Map<string, Promise<unknown>>();
function serializedWrite<T>(userKey: string, env: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  const path = userKnowledgePath(userKey, env);
  const prev = writeQueues.get(path) ?? Promise.resolve();
  const next = prev.then(run, run);
  writeQueues.set(path, next.catch(() => {}));
  return next;
}

async function writeAll(userKey: string, atoms: UserKnowledgeAtom[], now: string, env: NodeJS.ProcessEnv): Promise<void> {
  const target = userKnowledgePath(userKey, env);
  const file: UserKnowledgeFile = { schema_version: 1, user_key: userKey, atoms, updated_at: now };
  await atomicWrite(target, JSON.stringify(file, null, 2));
  try { await chmod(target, PATHRULE_FILE_MODE); } catch { /* best effort, same as the identity snapshot */ }
}

/**
 * One atomic read-modify-write of this person's store: `run` sees every stored atom and returns the
 * next list. Serialized per file in this process, like every other write here, so two interleaved
 * writers cannot drop each other's change.
 */
export async function modifyUserKnowledge<T>(
  userKey: string,
  run: (atoms: UserKnowledgeAtom[]) => { atoms: UserKnowledgeAtom[]; result: T },
  opts: { now: string; env?: NodeJS.ProcessEnv },
): Promise<T> {
  const env = opts.env ?? process.env;
  return serializedWrite(userKey, env, async () => {
    const { atoms, result } = run(await readUserKnowledge(userKey, env));
    await writeAll(userKey, atoms, opts.now, env);
    return result;
  });
}

/**
 * Store a belief exactly as given: replace the atom with the same id, or append it.
 *
 * For beliefs whose confidence is DERIVED elsewhere (behavioural beliefs carry a rate over counted
 * episodes). `upsertUserKnowledge` would instead merge through `addUserEvidence`, which re-derives
 * confidence from distinct quoted occasions and would overwrite the rate with a count.
 */
export async function putUserKnowledge(
  userKey: string,
  atom: UserKnowledgeAtom,
  opts: { now: string; env?: NodeJS.ProcessEnv },
): Promise<UserKnowledgeAtom> {
  const env = opts.env ?? process.env;
  return serializedWrite(userKey, env, async () => {
    const all = await readUserKnowledge(userKey, env);
    const idx = all.findIndex((a) => a.id === atom.id);
    const next = idx === -1 ? [...all, atom] : all.map((a, i) => (i === idx ? atom : a));
    await writeAll(userKey, next, opts.now, env);
    return atom;
  });
}

/** Replace one atom wholesale (status change, scope narrowing, supersede). No-op when it is absent. */
export async function updateUserKnowledge(
  userKey: string,
  id: string,
  update: (atom: UserKnowledgeAtom) => UserKnowledgeAtom,
  opts: { now: string; env?: NodeJS.ProcessEnv },
): Promise<UserKnowledgeAtom | null> {
  const env = opts.env ?? process.env;
  return serializedWrite(userKey, env, async () => {
    const all = await readUserKnowledge(userKey, env);
    const idx = all.findIndex((a) => a.id === id);
    if (idx === -1) return null;
    const updated = update(all[idx]!);
    const next = [...all];
    next[idx] = updated;
    await writeAll(userKey, next, opts.now, env);
    return updated;
  });
}

/**
 * Hard delete, for a person who wants a belief gone rather than retired. Gone means gone: the copies
 * its revisions kept in the ledger go with it.
 */
export async function deleteUserKnowledge(
  userKey: string,
  id: string,
  opts: { now: string; env?: NodeJS.ProcessEnv },
): Promise<boolean> {
  const env = opts.env ?? process.env;
  return serializedWrite(userKey, env, async () => {
    const all = await readUserKnowledge(userKey, env);
    const next = all.filter((a) => a.id !== id);
    if (next.length === all.length) return false;
    await writeAll(userKey, next, opts.now, env);
    const ledger = await readLedger(userKey, env);
    if (ledger.some((r) => r.atomId === id)) {
      await writeLedger(
        userKey,
        ledger.filter((r) => r.atomId !== id),
        env,
      );
    }
    return true;
  });
}

// ── The file as a UserKnowledgeStore ──────────────────────────────────────────────────────────────

/** Revisions kept per person, oldest dropped first. Enough for "why did this change", not an archive. */
export const USER_KNOWLEDGE_LEDGER_MAX = 500;

interface UserKnowledgeLedgerFile {
  schema_version: 1;
  revisions: UserKnowledgeRevision[];
}

/**
 * Next to the beliefs, not inside them: the beliefs file is read on every turn and stays small, and
 * builds that predate the ledger keep reading and writing it unchanged.
 */
export function userKnowledgeLedgerPath(
  userKey: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(pathruleHome(env), "user-intelligence", `${hashUserIdForPath(userKey)}.ledger.json`);
}

async function readLedger(
  userKey: string,
  env: NodeJS.ProcessEnv,
): Promise<UserKnowledgeRevision[]> {
  try {
    const raw = JSON.parse(
      await readFile(userKnowledgeLedgerPath(userKey, env), "utf8"),
    ) as Partial<UserKnowledgeLedgerFile>;
    return raw.schema_version === 1 && Array.isArray(raw.revisions) ? raw.revisions : [];
  } catch {
    return [];
  }
}

async function writeLedger(
  userKey: string,
  revisions: UserKnowledgeRevision[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const target = userKnowledgeLedgerPath(userKey, env);
  const file: UserKnowledgeLedgerFile = {
    schema_version: 1,
    revisions: revisions.slice(-USER_KNOWLEDGE_LEDGER_MAX),
  };
  await atomicWrite(target, JSON.stringify(file));
  try {
    await chmod(target, PATHRULE_FILE_MODE);
  } catch {
    /* best effort */
  }
}

/** The version of an atom as stored: opaque, a digest of its stored form. */
export function userKnowledgeVersion(atom: UserKnowledgeAtom): string {
  return createHash("sha256").update(JSON.stringify(atom), "utf8").digest("hex").slice(0, 32);
}

const recordOf = (stored: UserKnowledgeAtom): UserKnowledgeRecord => ({
  atom: stored,
  version: userKnowledgeVersion(stored),
});

/** The store a call works against: the one the host opened, else this person's local file. */
export function userKnowledgeStoreFor(cfg: {
  userKnowledge?: UserKnowledgeStore;
  userId?: string | null;
  env?: NodeJS.ProcessEnv;
}): UserKnowledgeStore {
  return (
    cfg.userKnowledge ??
    createFileUserKnowledgeStore(resolveUserKey(cfg.userId), cfg.env ?? process.env)
  );
}

/**
 * This person's local file, as a store. The default every surface uses; the file format does not
 * change, and the free functions above keep working on the same file under the same write queue.
 *
 * The beliefs file is written before the ledger: a crash between them loses a revision record (a
 * retried operation then meets a version conflict and is decided again), never a belief.
 */
export function createFileUserKnowledgeStore(
  userKey: string,
  env: NodeJS.ProcessEnv = process.env,
): UserKnowledgeStore {
  const write = (
    atomId: string,
    kind: UserKnowledgeRevision["kind"],
    o: UserKnowledgeWriteOptions,
    next: (current: UserKnowledgeAtom | null) => UserKnowledgeAtom | null,
  ): Promise<UserKnowledgeWrite> =>
    serializedWrite(userKey, env, async () => {
      const ledger = await readLedger(userKey, env);
      const prior = ledger.find((r) => r.operationId === o.operationId);
      if (prior) {
        if (prior.atomId !== atomId || prior.kind !== kind) {
          throw new Error(`Operation id ${o.operationId} was already used for a different change`);
        }
        return {
          status: "written",
          record: { atom: prior.atom, version: prior.version },
          replayed: true,
        };
      }
      const all = await readStoredAtoms(userKey, env);
      const idx = all.findIndex((a) => a.id === atomId);
      const current = idx === -1 ? null : all[idx]!;
      const currentVersion = current ? userKnowledgeVersion(current) : null;
      if (currentVersion !== o.expectedVersion) {
        return { status: "conflict", current: current ? recordOf(current) : null };
      }
      const atom = next(current);
      if (!atom) return { status: "conflict", current: null };
      await writeAll(
        userKey,
        idx === -1 ? [...all, atom] : all.map((a, i) => (i === idx ? atom : a)),
        o.now,
        env,
      );
      const version = userKnowledgeVersion(atom);
      await writeLedger(
        userKey,
        [
          ...ledger,
          {
            atomId,
            kind,
            version,
            previousVersion: currentVersion,
            operationId: o.operationId,
            at: o.now,
            atom,
          },
        ],
        env,
      );
      return { status: "written", record: { atom, version }, replayed: false };
    });

  return {
    async list(o) {
      const all = (await readStoredAtoms(userKey, env)).sort((a, b) => (a.id < b.id ? -1 : 1));
      return pageAfter(all.map(recordOf), (r) => r.atom.id, o);
    },
    async get(id) {
      const stored = (await readStoredAtoms(userKey, env)).find((a) => a.id === id);
      return stored ? recordOf(stored) : null;
    },
    // async, so a refused atom rejects like every other failure instead of throwing at the call.
    async put(raw, o) {
      const atom = requireStampedUserKnowledge(raw);
      return write(atom.id, "put", o, () => atom);
    },
    async retire(id, o) {
      return write(id, "retire", o, (current) =>
        current ? retiredUserKnowledge(current, o.replacementId, o.now) : null,
      );
    },
    async history(id, o) {
      const newestFirst = (await readLedger(userKey, env))
        .filter((r) => r.atomId === id)
        .reverse()
        .map((r, i) => ({ r, key: String(i).padStart(8, "0") }));
      const page = pageAfter(newestFirst, (x) => x.key, o);
      return { items: page.items.map((x) => x.r), next: page.next };
    },
  };
}

/**
 * What an agent could see right now, before task relevance narrows it further.
 *
 * Two filters and nothing clever: deliverable (active, not superseded, not a low-confidence guess) and
 * applicable to where the work is happening. Relevance to the specific task is a separate decision made
 * later, because "could apply" and "is worth spending tokens on" are different questions.
 */
export async function deliverableUserKnowledge(
  userKey: string,
  where: UserKnowledgeWhere,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UserKnowledgeAtom[]> {
  const all = await readUserKnowledge(userKey, env);
  return all.filter((a) => isUserKnowledgeDeliverable(a) && userKnowledgeApplies(a, where));
}
