// SPDX-License-Identifier: Apache-2.0
// The local hook-index writer, shared by the CLI (`pathrule sync` / init) and the
// local MCP runtime. It assembles the hook payload from a KnowledgeBackend (hosted
// service or local SQLite) and writes it to `<PATHRULE_HOME>/cache/<wsId>/hook-index.json`
// — the exact file `pathrule-hook.js` reads on PreToolUse/PostToolUse/UserPromptSubmit.
// This is what makes path-scoped context injection work OFFLINE: no daemon, no network,
// just the local store.
//
// Backend-agnostic by construction (takes KnowledgeBackend), so the hosted path is
// unchanged — it's the same assembly used in either edition.

import type { AffinityPayload, EmbeddingsPayload, KnowledgeBackend, Warehouse } from "@pathrule/core";
// Value import, and safe here: this module is Node-only (it writes files), so
// pulling in the node:crypto-backed assembler cannot reach a browser bundle.
import { assembleWarehouse } from "@pathrule/core/backend/hook-index.js";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildCodeMap } from "./code-map.js";
import { readDriftTree } from "./path-drift-tree.js";
import { detectPathDrift, pathDriftReason, pathDriftStubs, renderPathDriftDigest, type PathDrift } from "@pathrule/core/knowledge-map/path-drift.js";
import { localRuntimePaths } from "@pathrule/core/storage/paths.js";
import { isCloudWorkspaceId, type FolderMode } from "@pathrule/core/workspace/folder-mode.js";
import type {
  HookIndex,
  HookIntelligenceProfiles,
  KnowledgeGapStub,
} from "@pathrule/protocol/hook-index.js";
import type { IntelligenceProfileDelivery } from "@pathrule/protocol/intelligence-delivery.js";
import type { GuidanceEntry } from "@pathrule/protocol/guidance-types.js";
import type { LocalAtomStoreReader, OpenLocalAtomStore } from "@pathrule/protocol/local-atom-store.js";
import { isArchivedKnowledgePath } from "@pathrule/protocol/knowledge-archive.js";
import { CAPTURE_REMINDER, SKILL_GATE, renderHookOnlyProtocol } from "../pathrule-protocol.js";

const EPISODE_REFRESH_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const EPISODE_REFRESH_MIN_INTERVAL_MS = 60_000;
const lastEpisodeRefreshAt = new Map<string, number>();

/** One compiled preference line, in the shape the hook reads. */
type PreferenceIndexEntry = NonNullable<HookIndex["user_preferences"]>[number];

export interface HookIndexSyncResult {
  ok: boolean;
  path: string | null;
  refreshed_episodes: boolean;
  schema_version: number | null;
  error?: string;
}

export async function syncHookIndex(args: {
  backend: KnowledgeBackend;
  workspaceId: string;
  workspaceRoot: string;
  env: NodeJS.ProcessEnv;
  refreshEpisodes?: boolean;
  /**
   * Pathrule Cloud's semantic endpoint to stamp into the index, so the hook can rank bodies over
   * Cloud's own index instead of falling back to keyword overlap. Pass it ONLY for a Cloud
   * workspace: absence is what keeps the local edition on its BYO-key path.
   */
  cloud?: { url: string; native: true };
  /**
   * Rendered agent protocol, stamped onto the index so the hook delivers it once
   * per session instead of the companion files carrying it.
   *
   * Never decided here: the caller passes it only when
   * `resolveProtocolChannel(...).protocolOnIndex` is true, so the file half and
   * the index half of that decision cannot disagree. Blank or omitted leaves the
   * field off the index, which is what keeps the hook silent about it.
   */
  protocol?: string;
  /**
   * Compiled USER preference entries: how the PERSON works, already decided by the user-intelligence
   * layer (eligible, in scope, rendered, with the terms that make each relevant).
   *
   * Passed in rather than read here for the same reason `protocol` is: the caller owns the decision,
   * and the index is only the channel. The hook may not import anything, so nothing about this layer
   * can live there; it matches terms against the prompt and carries the line, and that is all.
   *
   * Omitted means "not this caller's decision" and keeps the entries already on the index; an empty
   * array means "there are none" and clears them. See `personalEntriesOnDisk`.
   */
  userPreferences?: PreferenceIndexEntry[];
  /**
   * Oversight and expertise-lease entries (`turn-guidance.ts`), passed in for the same reason: the
   * caller owns the decision. Each is a rendered line under its own heading, matched by risk terms.
   * Omitted keeps the entries already on the index, exactly like `userPreferences`.
   */
  guidance?: GuidanceEntry[];
  /**
   * Whose store compiled `userPreferences` and `guidance` (`personalIndexEntries` returns it, so a
   * writer that spreads those entries passes it along): an account id, or null / omitted for the
   * accountless local file. Stamped as `personal_owner`; the hook then delivers the entries only
   * while that account is signed in. Entries already on the index are carried only for the same
   * owner, so one person's lines are never relabelled as another's.
   */
  personalOwner?: string | null;
  /**
   * Rendered team context block, travelling with the protocol for the same
   * reason: in signature mode the compiled file that used to carry it is not
   * written, so the hook is its only remaining channel. Same discipline as
   * `protocol` — the caller passes it only alongside a signature-mode decision,
   * and omitting it leaves the field off the index.
   */
  teamContext?: string;
  /**
   * The signed-in person's team and personal profiles, already selected and ranked by the account's
   * provider and rendered (`hookIndexProfiles`). Only an account writer can know them, so the
   * discipline is the personal entries': omitted keeps what the index carries, `null` clears it
   * (nothing deliverable), an entry replaces it. The hook delivers it only while its owner is signed in.
   */
  intelligenceProfiles?: HookIntelligenceProfiles | null;
  /** Explicit gap stubs (tests); omitted, the writer computes them when delivery is on. */
  knowledgeGaps?: KnowledgeGapStub[];
  /**
   * Opens a Local workspace's atom store, for a backend that cannot hold the approved atoms itself
   * (see `localAdvisoriesFor`); never used for a Cloud index. The caller supplies it because the
   * writer never names a storage implementation. Omitted, the index carries the advisories its own
   * backend built, and none from the local store.
   */
  openLocalAtomStore?: OpenLocalAtomStore;
  /**
   * The edition this index serves (core workspace/folder-mode.ts), stamped as `mode` so the hook
   * picks one edition per folder. Omitted, a Cloud workspace attached on this machine is `cloud`
   * and anything else `local`, so a writer that names none is still stamped.
   */
  mode?: FolderMode;
}): Promise<HookIndexSyncResult> {
  const target = hookIndexPath(args.env, args.workspaceId);
  const mode: FolderMode = args.mode ?? (isCloudWorkspaceId(args.workspaceId, args.env) ? "cloud" : "local");
  let refreshedEpisodes = false;

  // Refresh via the backend (hosted: managed service; local: SQLite assembly).
  if (args.refreshEpisodes !== false && shouldRefreshEpisodes(args.workspaceId)) {
    const now = Date.now();
    try {
      const r = await args.backend.refreshWorkEpisodes(
        args.workspaceId,
        new Date(now - EPISODE_REFRESH_WINDOW_MS).toISOString(),
      );
      refreshedEpisodes = r.ok;
    } catch {
      refreshedEpisodes = false;
    }
  }

  let data: HookIndex | null;
  try {
    data = await args.backend.buildHookIndexPayload(args.workspaceId);
  } catch (err) {
    return {
      ok: false,
      path: target,
      refreshed_episodes: refreshedEpisodes,
      schema_version: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!data || typeof data !== "object") {
    return {
      ok: false,
      path: target,
      refreshed_episodes: refreshedEpisodes,
      schema_version: null,
      error: "empty_hook_index_payload",
    };
  }

  const index: HookIndex = {
    ...data,
    workspace_root: args.workspaceRoot,
    mode,
  };

  // Approved knowledge of a workspace whose backend cannot hold it (see localAdvisoriesFor). The
  // server-built index wins if it ever carries advisories of its own.
  const atoms = await localAdvisoriesFor(args.backend, args.workspaceId, args.env, mode, args.openLocalAtomStore);
  if (atoms.path_advisories && !index.path_advisories) index.path_advisories = atoms.path_advisories;
  if (atoms.project_advisories && !index.project_advisories) index.project_advisories = atoms.project_advisories;

  // Only stamped for a Cloud workspace, and only with a URL: a half-written endpoint would make the
  // hook spawn a request that cannot succeed, and its failure looks exactly like "no key".
  if (args.cloud?.url) index.cloud_semantic = { url: args.cloud.url, kind: "native" };

  // The space of the vectors written to embeddings.json below, so the hook never ranks a prompt
  // vector of one model against another's. Read from the store, no network; absent leaves the
  // hook on keywords for any local prompt vector.
  try {
    const embeddingSpace = await args.backend.embeddingSpace?.(args.workspaceId);
    if (embeddingSpace) index.embedding_space = embeddingSpace;
  } catch {
    /* no stamp: the hook ranks a local prompt vector by keywords instead */
  }

  if (typeof args.protocol === "string" && args.protocol.trim().length > 0) {
    // The skill/pattern gate is paid on every model step of every session, so it rides only an index
    // whose workspace holds a skill; the channel renders the protocol without it.
    const hasSkills = Object.values(index.path_skills ?? {}).some((list) => list.length > 0);
    index.protocol = hasSkills ? `${args.protocol.trimEnd()}\n${(args.protocol.match(/^\d+\. /gm) ?? []).length + 1}. ${SKILL_GATE}\n` : args.protocol;
    // Its twin for a session with no Pathrule MCP server; the hook picks one per session.
    index.protocol_without_mcp = renderHookOnlyProtocol();
  }
  // Every index, whatever its protocol channel: the hook shows it only to a session with the MCP server.
  index.capture_reminder = CAPTURE_REMINDER;

  // Omitted entirely when there is nothing to carry, so a person with no learned preferences costs the
  // hook nothing and the index stays byte-identical to what it was before this layer existed.
  const carried =
    args.userPreferences === undefined ||
    args.guidance === undefined ||
    args.intelligenceProfiles === undefined
      ? await personalEntriesOnDisk(target, args.workspaceId)
      : {};
  // The person's entries carry their owner. A caller that writes either half decides the owner;
  // the other half is carried only when it already belongs to that owner.
  const writesPersonal = args.userPreferences !== undefined || args.guidance !== undefined;
  const personalOwner = writesPersonal ? ownerOf(args.personalOwner) : (carried.personalOwner ?? null);
  const carryPersonal = (carried.personalOwner ?? null) === personalOwner;
  const userPreferences = args.userPreferences ?? (carryPersonal ? carried.userPreferences : undefined);
  const guidance = args.guidance ?? (carryPersonal ? carried.guidance : undefined);
  if (Array.isArray(userPreferences) && userPreferences.length > 0) {
    index.user_preferences = userPreferences;
  }

  if (Array.isArray(guidance) && guidance.length > 0) {
    index.guidance = guidance;
  }
  if (personalOwner !== null && (index.user_preferences || index.guidance)) {
    index.personal_owner = personalOwner;
  }

  // Same channel, same condition: present only when the workspace's companion
  // files are in signature mode, because that is exactly when the compiled file
  // that used to carry this block is no longer written.
  if (typeof args.teamContext === "string" && args.teamContext.trim().length > 0) {
    index.team_context = args.teamContext;
  }

  const intelligenceProfiles =
    args.intelligenceProfiles === undefined
      ? carried.intelligenceProfiles
      : args.intelligenceProfiles;
  if (intelligenceProfiles && isProfilesEntry(intelligenceProfiles)) {
    index.intelligence_profiles = intelligenceProfiles;
  }

  // Knowledge gaps a caller names; the field stays absent when there are none.
  const knowledgeGaps = args.knowledgeGaps ?? [];
  // Knowledge naming a file the checkout moved away from: the session digest says so on every session's
  // first prompt, and the gap channel warns the edit that writes the old file. Read from the checkout, so
  // a failure costs only these.
  const drift = args.workspaceRoot ? await pathDriftFor(args.backend, args.workspaceId, args.workspaceRoot, index, dirname(target)).catch(() => []) : [];
  const gaps = [...knowledgeGaps, ...pathDriftStubs(drift)];
  if (gaps.length > 0) index.knowledge_gaps = gaps;
  const driftDigest = renderPathDriftDigest(drift);
  if (driftDigest) index.session_digest = index.session_digest ? `${index.session_digest}\n${driftDigest}` : driftDigest;

  // Where things are defined in the checkout, for routing an agent to code instead of letting it grep.
  // Built from the local tree, names and lines only; a failure leaves the field out, never the sync.
  const codeMap = args.workspaceRoot ? await buildCodeMap(args.workspaceRoot, dirname(target)).catch(() => null) : null;
  if (codeMap && codeMap.symbols.length > 0) index.code_map = codeMap;

  // Native Knowledge Compilation: when the backend can compile knowledge into
  // native instruction files, mark the index so the hook stops carrying memory
  // content on PreToolUse (turn-zero files own that now) and knows which
  // memory ids are already delivered.
  if (typeof args.backend.buildKnowledgePayload === "function") {
    try {
      // FULL payload drives compiled_memory_ids (unchanged): clients whose file
      // carries bodies (codex/cursor/...) skip these in delta injection exactly
      // as before. SLIM payload drives the router ids for clients with a
      // prompt-time body channel (Claude): title-indexed memories are eligible
      // for hook top-k, and rule bodies already sit in the slim file.
      const [knowledge, slim, binding] = await Promise.all([
        args.backend.buildKnowledgePayload(args.workspaceId),
        args.backend.buildKnowledgePayload(args.workspaceId, "slim"),
        args.backend.buildKnowledgePayload(args.workspaceId, "binding"),
      ]);
      // What Claude's path-scoped rules should carry; the hook skips one only while the files on disk do.
      const instruction = Object.fromEntries((binding ?? []).flatMap((n) => Object.entries(n.memory_hashes ?? {})).sort((a, z) => a[0].localeCompare(z[0])));
      if (Object.keys(instruction).length > 0) index.instruction_memory_hashes = instruction;
      if (knowledge && knowledge.length > 0) {
        index.knowledge_compiled = true;
        index.compiled_memory_ids = [...new Set(knowledge.flatMap((n) => n.memory_ids))].sort();
      }
      if (slim && slim.length > 0) {
        index.indexed_memory_ids = [
          ...new Set(slim.flatMap((n) => n.indexed_memory_ids ?? [])),
        ].sort();
        index.compiled_rule_ids = [...new Set(slim.flatMap((n) => n.rule_ids))].sort();
      }
    } catch {
      /* knowledge compilation is non-fatal for hook-index sync */
    }
  }

  const archived = dropArchivedKnowledge(index);
  // Vectors of another space must never sit beside an index that names this one: when the space
  // changes, the old file goes before the new index lands, and the new vectors follow below.
  if ((await indexedEmbeddingSpace(target)) !== (index.embedding_space ?? null)) {
    await rm(embeddingsPath(args.env, args.workspaceId), { force: true }).catch(() => {});
  }
  await writeHookIndex(args.env, index);

  // Persist the full-body warehouse next to the index. Best-effort — the
  // index write already succeeded, and warehouse is an optimization the hook
  // reads selectively by id for delta delivery.
  //
  // Two producers, because not every backend can run the assembler. LocalBackend and
  // in-memory implement buildWarehousePayload directly; a backend that cannot import
  // node:crypto (where the assembler lives) returns the raw input via
  // buildHookInputPayload and we assemble here — this module is Node-only.
  try {
    let warehouse: Warehouse | null = null;
    if (typeof args.backend.buildWarehousePayload === "function") {
      warehouse = await args.backend.buildWarehousePayload(args.workspaceId);
    } else if (typeof args.backend.buildHookInputPayload === "function") {
      warehouse = assembleWarehouse(await args.backend.buildHookInputPayload(args.workspaceId));
    }
    if (warehouse) {
      await writeWarehouse(args.env, args.workspaceId, withoutIds(warehouse, archived));
    }
  } catch {
    /* warehouse is non-fatal */
  }

  // Persist precomputed embedding vectors next to the warehouse. Best-effort
  // — absent (no key/store) ⇒ the hook ranks lexically. Never blocks the sync.
  if (typeof args.backend.buildEmbeddingsPayload === "function") {
    try {
      const embeddings = await args.backend.buildEmbeddingsPayload(args.workspaceId);
      // Written only when the space held while they were built (skills are embedded meanwhile).
      const space = (await args.backend.embeddingSpace?.(args.workspaceId)) ?? null;
      if (embeddings && space === (index.embedding_space ?? null)) {
        await writeEmbeddings(args.env, args.workspaceId, withoutIds(embeddings, archived));
      }
    } catch {
      /* embeddings are a ranking optimization, never load-bearing */
    }
  }

  // Learned affinity weights, same discipline as embeddings: a ranking optimization the
  // hook can live without. Written separately from embeddings.json so a workspace with
  // vectors but no affinity history (or the reverse) still gets what it has.
  if (typeof args.backend.buildAffinityPayload === "function") {
    try {
      const affinity = await args.backend.buildAffinityPayload(args.workspaceId);
      if (affinity) await writeAffinity(args.env, args.workspaceId, withoutIds(affinity, archived));
    } catch {
      /* affinity only reorders candidates; never load-bearing */
    }
  }

  return {
    ok: true,
    path: target,
    refreshed_episodes: refreshedEpisodes,
    schema_version: index.schema_version,
  };
}

/**
 * Knowledge under an `_archive` node is history, not context (`knowledge-archive.ts`), so it leaves
 * the index here: every backend's hook payload passes through this writer. Returns the ids it
 * removed, so their bodies, vectors and weights stay out of the files beside the index too. An
 * explicit read by id or of the archive node does not go through the hook and still reaches them.
 */
export function dropArchivedKnowledge(index: HookIndex): Set<string> {
  const removed = new Set<string>();
  const dropFrom = <T extends { id: string; node_path?: string | null }>(
    map?: Record<string, T[]>,
  ) => {
    if (!map) return;
    for (const key of Object.keys(map)) {
      const bucket = map[key] ?? [];
      const kept = bucket.filter(
        (item) => !isArchivedKnowledgePath(key) && !isArchivedKnowledgePath(item.node_path),
      );
      for (const item of bucket) if (!kept.includes(item)) removed.add(item.id);
      if (kept.length > 0) map[key] = kept;
      else delete map[key];
    }
  };
  dropFrom(index.path_memories);
  dropFrom(index.path_rules);
  dropFrom(index.path_skills);
  index.project_rules = (index.project_rules ?? []).filter((rule) => {
    if (!isArchivedKnowledgePath(rule.node_path)) return true;
    removed.add(rule.id);
    return false;
  });
  if (removed.size === 0) return removed;
  const keep = (ids?: string[]) => ids?.filter((id) => !removed.has(id));
  for (const key of ["compiled_memory_ids", "indexed_memory_ids", "compiled_rule_ids"] as const) {
    const ids = keep(index[key]);
    if (ids) index[key] = ids;
  }
  if (index.filename_index) {
    for (const token of Object.keys(index.filename_index)) {
      const ids = keep(index.filename_index[token]) ?? [];
      if (ids.length > 0) index.filename_index[token] = ids;
      else delete index.filename_index[token];
    }
  }
  return removed;
}

/**
 * Memories naming a file the checkout has moved away from (core/knowledge-map/path-drift.ts). Each also
 * gets a refresh request, idempotent per memory, so the person and the next agent see it in the queue;
 * one opened now counts on this index at once rather than a sync later.
 */
async function pathDriftFor(backend: KnowledgeBackend, workspaceId: string, root: string, index: HookIndex, cacheDir: string): Promise<PathDrift[]> {
  const tree = readDriftTree(root, cacheDir);
  if (!tree) return [];
  const nodeOf = new Map<string, string>();
  for (const stubs of Object.values(index.path_memories ?? {})) for (const s of stubs) nodeOf.set(s.id, s.node_path);
  const memories = (await backend.listMemories({ workspaceId, status: "active" })).map((m) => ({
    id: m.id,
    title: m.title,
    content: m.content,
    node_path: nodeOf.get(m.id) ?? "",
  }));
  const drifts = detectPathDrift(memories, tree);
  for (const memoryId of new Set(drifts.map((d) => d.memoryId))) {
    const d = drifts.find((x) => x.memoryId === memoryId)!;
    const r = await backend.requestRefresh({ subjectType: "memory", subjectId: memoryId, reason: pathDriftReason(d), kind: "drift" }).catch(() => null);
    if (r && !r.alreadyPending) index.pending_refresh_count = (index.pending_refresh_count ?? 0) + 1;
  }
  return drifts;
}

function withoutIds<T>(byId: Record<string, T>, ids: Set<string>): Record<string, T> {
  if (ids.size === 0) return byId;
  return Object.fromEntries(Object.entries(byId).filter(([id]) => !ids.has(id)));
}

function warehousePath(env: NodeJS.ProcessEnv, workspaceId: string): string {
  return join(localRuntimePaths(env).home, "cache", workspaceId, "warehouse.json");
}

async function writeWarehouse(
  env: NodeJS.ProcessEnv,
  workspaceId: string,
  warehouse: Warehouse,
): Promise<void> {
  const target = warehousePath(env, workspaceId);
  await mkdir(join(localRuntimePaths(env).home, "cache", workspaceId), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(warehouse, null, 2), "utf8");
  await chmod(tmp, 0o600);
  await rename(tmp, target);
}

/** The space the index on disk names, null when it names none or there is no readable index. */
async function indexedEmbeddingSpace(indexPath: string): Promise<string | null> {
  try {
    const previous = JSON.parse(await readFile(indexPath, "utf8")) as { embedding_space?: unknown };
    return typeof previous.embedding_space === "string" ? previous.embedding_space : null;
  } catch {
    return null;
  }
}

function embeddingsPath(env: NodeJS.ProcessEnv, workspaceId: string): string {
  return join(localRuntimePaths(env).home, "cache", workspaceId, "embeddings.json");
}

async function writeEmbeddings(
  env: NodeJS.ProcessEnv,
  workspaceId: string,
  embeddings: EmbeddingsPayload,
): Promise<void> {
  const target = embeddingsPath(env, workspaceId);
  await mkdir(join(localRuntimePaths(env).home, "cache", workspaceId), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(embeddings), "utf8");
  await chmod(tmp, 0o600);
  await rename(tmp, target);
}

function affinityPath(env: NodeJS.ProcessEnv, workspaceId: string): string {
  return join(localRuntimePaths(env).home, "cache", workspaceId, "affinity.json");
}

async function writeAffinity(
  env: NodeJS.ProcessEnv,
  workspaceId: string,
  affinity: AffinityPayload,
): Promise<void> {
  const target = affinityPath(env, workspaceId);
  await mkdir(join(localRuntimePaths(env).home, "cache", workspaceId), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(affinity), "utf8");
  await chmod(tmp, 0o600);
  await rename(tmp, target);
}

function shouldRefreshEpisodes(workspaceId: string): boolean {
  const now = Date.now();
  const last = lastEpisodeRefreshAt.get(workspaceId) ?? 0;
  if (now - last < EPISODE_REFRESH_MIN_INTERVAL_MS) return false;
  lastEpisodeRefreshAt.set(workspaceId, now);
  return true;
}

type AdvisoryFields = Pick<HookIndex, "path_advisories" | "project_advisories">;

/**
 * Approved knowledge atoms of a Local workspace whose backend does not hold them, read from its
 * local store.
 *
 * Never for a Cloud index: a Cloud folder is never served from a Local store, so nothing a Local
 * store holds reaches its index, whatever store exists under its id (a copy left from before each
 * folder had one edition).
 *
 * The store is opened only when it already exists, so no store is created just to find it empty, and
 * only through the caller's opener.
 * The lines are delivered as additive advisories, without the compiled-body grouping: the backend's
 * memory stubs are hashed from the text as written, and a compiled body here would disagree with
 * those hashes. Any failure delivers nothing, never a partial set.
 */
async function localAdvisoriesFor(
  backend: KnowledgeBackend,
  workspaceId: string,
  env: NodeJS.ProcessEnv,
  mode: FolderMode,
  openLocalAtomStore: OpenLocalAtomStore | undefined,
): Promise<AdvisoryFields> {
  if (mode === "cloud") return {};
  // A backend that can compile deliveries holds its own atoms; its payload already has them.
  if (typeof backend.compiledMemoryDeliveries === "function") return {};
  if (!openLocalAtomStore) return {};
  if (!existsSync(join(localRuntimePaths(env).home, workspaceId, "pathrule.db"))) return {};
  let store: LocalAtomStoreReader | undefined;
  try {
    store = await openLocalAtomStore(workspaceId, env);
    const local = await store.buildHookIndexPayload(workspaceId);
    const additive = (stubs: NonNullable<HookIndex["project_advisories"]>) => stubs.map(({ ref, line }) => ({ ref, line }));
    const out: AdvisoryFields = {};
    const paths = Object.entries(local?.path_advisories ?? {}).filter(([, stubs]) => stubs.length > 0);
    if (paths.length > 0) out.path_advisories = Object.fromEntries(paths.map(([scope, stubs]) => [scope, additive(stubs)]));
    if (local?.project_advisories?.length) out.project_advisories = additive(local.project_advisories);
    return out;
  } catch {
    return {};
  } finally {
    await Promise.resolve(store?.close()).catch(() => {});
  }
}

function hookIndexPath(env: NodeJS.ProcessEnv, workspaceId: string): string {
  return join(localRuntimePaths(env).home, "cache", workspaceId, "hook-index.json");
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

function isPreferenceEntry(value: unknown): value is PreferenceIndexEntry {
  const entry = value as Partial<PreferenceIndexEntry> | null;
  return (
    typeof entry === "object" &&
    entry !== null &&
    typeof entry.id === "string" &&
    typeof entry.line === "string" &&
    isStringArray(entry.terms) &&
    typeof entry.always === "boolean"
  );
}

function isGuidanceEntry(value: unknown): value is GuidanceEntry {
  const entry = value as Partial<GuidanceEntry> | null;
  return (
    typeof entry === "object" &&
    entry !== null &&
    typeof entry.id === "string" &&
    typeof entry.heading === "string" &&
    typeof entry.line === "string" &&
    isStringArray(entry.terms)
  );
}

function isProfilesEntry(value: unknown): value is HookIntelligenceProfiles {
  const entry = value as Partial<HookIntelligenceProfiles> | null;
  return (
    typeof entry === "object" &&
    entry !== null &&
    typeof entry.owner === "string" &&
    entry.owner !== "" &&
    typeof entry.version === "string" &&
    typeof entry.block === "string" &&
    entry.block.trim() !== "" &&
    isStringArray(entry.ids)
  );
}

/**
 * A profile delivery as the index carries it: undefined when the provider was unavailable (keep what
 * the index has), null when there is nothing to deliver (clear it), otherwise the entry.
 */
export function hookIndexProfiles(
  delivery: IntelligenceProfileDelivery | null,
): HookIntelligenceProfiles | null | undefined {
  if (!delivery) return undefined;
  if (!delivery.block.trim() || !delivery.owner) return null;
  return {
    owner: delivery.owner,
    version: delivery.version,
    block: delivery.block,
    ids: delivery.ids,
  };
}

/**
 * The profile entries the hook delivers from this workspace's index to `owner`'s sessions, so
 * `get_context` can leave them out for a client the hook serves. Empty when the index carries none,
 * carries another person's, or cannot be read.
 */
export async function hookDeliveredProfileIds(
  env: NodeJS.ProcessEnv,
  workspaceId: string,
  owner: string,
): Promise<string[]> {
  try {
    const index = JSON.parse(
      await readFile(hookIndexPath(env, workspaceId), "utf8"),
    ) as Partial<HookIndex>;
    const profiles = index?.intelligence_profiles;
    return index?.workspace_id === workspaceId &&
      isProfilesEntry(profiles) &&
      profiles.owner === owner
      ? profiles.ids
      : [];
  } catch {
    return [];
  }
}

/**
 * The person's entries already on the index, for a writer that does not compute them: learned
 * preferences, guidance and the account's profiles.
 *
 * Several writers rewrite this file, and only some of them own the user-intelligence decision:
 * The host, MCP get_context and `pathrule me` compute it, while `pathrule sync` and the local
 * edition's init and sync do not. Before this, every sync from the second group erased what the
 * first group had written, and the hook delivered no preferences until one of them ran again.
 * A missing, unreadable or foreign file carries nothing, and malformed entries are dropped rather
 * than handed to the hook.
 */
async function personalEntriesOnDisk(
  path: string,
  workspaceId: string,
): Promise<{
  userPreferences?: PreferenceIndexEntry[];
  guidance?: GuidanceEntry[];
  personalOwner?: string | null;
  intelligenceProfiles?: HookIntelligenceProfiles;
}> {
  let previous: {
    workspace_id?: unknown;
    user_preferences?: unknown;
    guidance?: unknown;
    personal_owner?: unknown;
    intelligence_profiles?: unknown;
  };
  try {
    previous = JSON.parse(await readFile(path, "utf8")) as typeof previous;
  } catch {
    return {};
  }
  if (previous === null || typeof previous !== "object" || previous.workspace_id !== workspaceId) return {};
  return {
    userPreferences: Array.isArray(previous.user_preferences)
      ? previous.user_preferences.filter(isPreferenceEntry)
      : undefined,
    guidance: Array.isArray(previous.guidance) ? previous.guidance.filter(isGuidanceEntry) : undefined,
    personalOwner: ownerOf(previous.personal_owner),
    intelligenceProfiles: isProfilesEntry(previous.intelligence_profiles)
      ? previous.intelligence_profiles
      : undefined,
  };
}

/** An account id, or null for the accountless local person (absent, empty or not a string). */
function ownerOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

async function writeHookIndex(env: NodeJS.ProcessEnv, index: HookIndex): Promise<void> {
  const target = hookIndexPath(env, index.workspace_id);
  await mkdir(join(localRuntimePaths(env).home, "cache", index.workspace_id), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(index, null, 2), "utf8");
  await chmod(tmp, 0o600);
  await rename(tmp, target);
}
