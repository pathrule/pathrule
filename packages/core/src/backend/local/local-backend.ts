// SPDX-License-Identifier: Apache-2.0
/**
 * LocalBackend — the OSS edition's authoritative store: embedded SQLite.
 *
 * This is not a cache of a remote service — it is the source of truth for a single developer
 * running Pathrule with no login. Pass a file path (e.g. ~/.pathrule/<ws>/pathrule.db) or
 * ":memory:" (tests). Implements the KnowledgeBackend CRUD + tree + activity + refresh slice
 * faithfully; the context/intelligence formulas are reference-level implementations here.
 *
 * better-sqlite3 is synchronous; methods wrap results in Promise to satisfy the async contract.
 */
import type {
  LearningClaim,
  LearningClaimRevision,
} from "../../project-learning/claims.js";
import type { ActivityLeadSource } from "../../activity/activity-leads.js";
import { insertActivityRow, learningActivityRows, recentActivityRows } from "./activity-store.js";
import {
  listLearningClaimRows,
  putLearningClaimRow,
  retiredLearningClaimRows,
  reviseLearningClaimRow,
} from "./learning-store.js";
import {
  ingestRuntimeEventRows,
  listRuntimeEventRows,
  pruneRuntimeEventRows,
  recordRuntimeCorrectionRow,
  runtimeEventIndicatorRow,
  runtimeEventStatusRow,
  runtimeIndicatorSnapshotRow,
} from "./runtime-events-store.js";
import type {
  RuntimeCorrectionInput,
  RuntimeCorrectionResult,
  RuntimeEventIndicator,
  RuntimeEventsPage,
  RuntimeEventsQuery,
  RuntimeEventsStatus,
  RuntimeIndicatorSnapshot,
  RuntimeIngestResult,
} from "@pathrule/protocol/runtime-events.js";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

import {
  canonicalizePath,
  discoverWorkspaceStoreForCwd,
  listLocalWorkspaceStores,
  MIRROR_MARKER,
  normalizePathTail,
  type LocalWorkspaceListing,
} from "./workspace-stores.js";
export type { LocalWorkspaceListing } from "./workspace-stores.js";
import {
  pathruleHome,
  PATHRULE_DIR_MODE,
  PATHRULE_FILE_MODE,
} from "../../storage/paths.js";
import type { Memory, Rule, Skill } from "@pathrule/protocol/content-types.js";
import type { HookIndex } from "@pathrule/protocol/hook-index.js";
import type {
  ProjectMapSearchResult,
  HotPath,
  PriorSolution,
  NodeBrief,
  WorkEpisodeBrief,
  ResearchBriefing,
  AssembleBriefingInput,
  RecentActivityForRouter,
} from "@pathrule/protocol/intelligence-types.js";
import type { TreeNode } from "@pathrule/protocol/node-types.js";
import type {
  SubtreeMemoryIndexResult,
  RouteIntentInput,
  RoutingResult,
} from "@pathrule/protocol/routing-types.js";
import type { DedupCheckArgs, DedupCheckResult } from "@pathrule/protocol/dedup-types.js";
import type { MaterialisedNode } from "../../tools/node-path.js";
import type { WorkspaceOverviewNode } from "../../tools/overview.js";
import type {
  RefreshRow,
  RefreshStatus,
  PendingRefreshSummary,
  RequestRefreshResult,
} from "@pathrule/protocol/refresh-types.js";
import { pathsEqual, pathStartsWith } from "@pathrule/protocol/path-compare.js";
import { normalizeNodePath, guessLeafType } from "../../tools/node-path.js";
import { buildWorkspaceOverview } from "../../tools/overview.js";
import { outcomeObserver } from "./outcome-observer.js";
import { observableLiterals } from "@pathrule/agent-ir/verification/observable-literals.js";
import { drainHookDeliveries } from "./delivery-ledger-drain.js";
import { drainAutoActivity } from "./auto-activity-drain.js";
import { DELIVERABLE_ADVISORY_AUTHORITIES as TRUSTED, groundedNow } from "./grounded-delivery.js";
import { ADVISORY_TRUSTED, HUMAN_ONLY, rowToAtom } from "./atom-rows.js";
import { retireFailedGroundedAtoms, storeGroundedAtom, type GroundedStoreResult } from "./grounded-store.js";
import type { CapturedAtom } from "@pathrule/agent-ir/atoms/grounded-capture.js";
import type { BackendCapabilities } from "../capabilities.js";
import type { LocalKnowledgeBackend } from "../knowledge-backend.js";
import type { Activity, ActivityRecord, ContextScope, DeleteContentInput, DeleteContentResult, ListMemoriesQuery, ListRulesQuery, ListSkillsQuery, LogActivityInput, RecentActivitiesOptions, NodeDetailRecord, NodeRef, NodeContent, InvocationSkill, RelevantMemoryRow, RestoreContentResult, RequestRefreshInput, SemanticQuery, SemanticCandidatesResult, WorkspaceMatch, ClosestNode, UpdateMemoryInput, UpdateRuleInput, UpdateSkillInput, WriteMemoryInput, WriteRuleInput, WriteSkillInput, EmbeddingsPayload, Warehouse } from "../inputs.js";
import { MIGRATIONS } from "./schema.js";
import { localKnowledgeMapFingerprint, localKnowledgeMapInput } from "./knowledge-map-store.js";
import { parseRuleAtoms } from "@pathrule/agent-ir/atoms/atoms.js";
import {
  approveRemedy,
  isRemedyDeliverable,
  parseRemedyAtom,
  rejectRemedy,
  type RemedyAtom,
} from "@pathrule/agent-ir/atoms/remedy.js";
import { projectRemedyToAdvisory, projectSelectionToAdvisory, projectProcedureToAdvisory, projectContextToAdvisory, projectRationaleToAdvisory, type RemedyAdvisory, type SelectionAdvisory, type ProcedureAdvisory, type ContextAdvisory, type RationaleAdvisory, normalizeScope } from "@pathrule/agent-ir/delivery/agent-ir.js";
import { parseSelectionAtom, approveSelection, rejectSelection, isSelectionDeliverable, type SelectionAtom } from "@pathrule/agent-ir/atoms/selection.js";
import { parseProcedureAtom, approveProcedure, rejectProcedure, isProcedureDeliverable, type ProcedureAtom } from "@pathrule/agent-ir/atoms/procedure.js";
import { parseContextAtom, approveContext, rejectContext, isContextDeliverable, type ContextAtom } from "@pathrule/agent-ir/atoms/context.js";
import { parseRationaleAtom, approveRationale, rejectRationale, isRationaleDeliverable, type RationaleAtom } from "@pathrule/agent-ir/atoms/rationale.js";
import { parsePrecedenceAtom, approvePrecedence, rejectPrecedence, isPrecedenceActive, type PrecedenceAtom } from "@pathrule/agent-ir/atoms/precedence.js";
import { resolveConflicts, type ConflictCandidate, type PrecedenceEdge } from "@pathrule/agent-ir/delivery/conflict.js";
import type { DeliveredAdvisory, ObservedEvent, UsageAttribution } from "@pathrule/protocol/outcome-types.js";
import {
  localEntryToRefreshRow,
  localEntryToSummary,
  type LocalRefreshEntry,
  type RefreshSubjectSnapshot,
} from "../in-memory-backend.js";
import { rankProjectMap, type ProjectMapCandidate } from "../project-map-rank.js";
import { activityTouchedPaths, rankCoupledPaths } from "../co-change-rank.js";
import { searchEpisodes, clusterEpisodes, type EpisodeActivity } from "../work-episodes.js";
import { assembleBriefingLocal } from "../briefing.js";
import { assembleHookIndex, assembleWarehouse, compiledDeliveryPlan, type HookIndexInput, type HookRuleInput } from "../hook-index.js";
import { nextRelatedPaths } from "../memory-links.js";
import type { CompiledMemoryDelivery } from "@pathrule/agent-ir/delivery/compiled-delivery.js";
import {
  assembleKnowledgeNodes,
  type CompiledKnowledgeNode,
  type KnowledgeRenderMode,
} from "../knowledge-compiler.js";
import type { KnowledgeMapInput } from "../knowledge-map-input.js";
import { resolveLocalPrincipal } from "./identity.js";
import { configuredEmbeddingSpace, embedTextBYO, hasEmbeddingKey, type EmbedFn, type EmbeddingSpaceFamily } from "../embedding-adapter.js";
import { addSkillVectors, composeEmbeddingText, semanticCandidatesOverVectors } from "../semantic-rank.js";
import { embeddingCoverage, memoryVectors, memoryVectorsInSpace, reindexMemoryEmbeddings, storeMemoryEmbedding, workspaceEmbeddingSpace, type EmbeddingCoverage, type ReindexOptions, type ReindexProgress } from "./embedding-store.js";

type Db = InstanceType<typeof Database>;

/** Safely parse a JSON text column into a string[] (empty on null/garbage). */
function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/** Re-hydrate a stored files_touched JSON string into its object shape. */
function parseFilesTouchedJson(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export interface LocalBackendOptions {
  genId?: () => string;
  now?: () => string;
  /** Identity stamped on created_by/last_edited_by. Defaults to the resolved local principal. */
  principal?: string;
  /**
   * Injectable embedding seam (tests pass a deterministic stub).
   * Defaults to the bring-your-own provider adapter. When provided, semantic search is
   * enabled regardless of env keys; otherwise it follows hasEmbeddingKey().
   */
  embed?: EmbedFn;
  /** The space `embed` writes, short of its dimension. Unset with a custom `embed`: read from its vectors. */
  embeddingSpace?: () => EmbeddingSpaceFamily | null;
  /** Where the default adapter reads its configuration (env, then that home's files). Default process.env. */
  embeddingEnv?: NodeJS.ProcessEnv;
}

interface MemoryRow {
  id: string;
  workspace_id: string;
  node_id: string;
  title: string;
  content: string;
  source: string;
  version_id: string;
  version_number: number;
  created_by: string | null;
  last_edited_by: string | null;
  last_edited_at: string;
  created_at: string;
  updated_at: string;
}
interface RuleRow {
  id: string;
  workspace_id: string;
  name: string;
  content: string;
  scope_type: string;
  priority: string;
  version_id: string;
  version_number: number;
  created_by: string | null;
  last_edited_by: string | null;
  last_edited_at: string;
  created_at: string;
  updated_at: string;  /** JSON array of RuleConstraint, stored as TEXT. Parsed defensively on read. */
  constraints: string;
}
interface SkillRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  content: string;
  source: string;
  github_url: string | null;
  version: string;
  tags: string;
  version_id: string;
  version_number: number;
  created_by: string | null;
  last_edited_by: string | null;
  last_edited_at: string;
  created_at: string;
  updated_at: string;
  content_fetched_at: string | null;
}

export class LocalBackend implements LocalKnowledgeBackend {
  private readonly db: Db;
  private readonly genId: () => string;
  private readonly now: () => string;
  private readonly principal: string;
  private readonly embed: EmbedFn;
  /** True when semantic search is wired (injected embed or a BYO key). */
  private readonly semanticEnabled: boolean;
  /** The configured space family, short of the dimension; null when none is known up front. */
  private readonly embeddingFamily: () => EmbeddingSpaceFamily | null;
  /** A custom seam with no declared space: its vectors say which space is current. */
  private readonly spaceFromVectors: boolean;

  constructor(path = ":memory:", options: LocalBackendOptions = {}) {
    this.db = new Database(path);
    if (path !== ":memory:") {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("busy_timeout = 5000");
    }
    this.runMigrations();
    this.genId = options.genId ?? (() => randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
    this.principal = options.principal ?? resolveLocalPrincipal();
    const env = options.embeddingEnv ?? process.env;
    this.embed = options.embed ?? ((text, opts) => embedTextBYO(text, opts, { env }));
    this.semanticEnabled = options.embed !== undefined || hasEmbeddingKey(env);
    this.embeddingFamily =
      options.embeddingSpace ?? (options.embed ? () => null : () => configuredEmbeddingSpace(env));
    this.spaceFromVectors = options.embed !== undefined && options.embeddingSpace === undefined;
  }

  /**
   * Open the canonical OSS store at `~/.pathrule/<workspaceId>/pathrule.db` (honoring
   * `PATHRULE_HOME`), creating the directory (0700) and tightening the db file to 0600.
   * This is the source of truth for a single developer — not a cache of a remote service.
   */
  static openForWorkspace(
    workspaceId: string,
    env: NodeJS.ProcessEnv = process.env,
    options: LocalBackendOptions = {},
  ): LocalBackend {
    const dir = join(pathruleHome(env), workspaceId);
    mkdirSync(dir, { recursive: true, mode: PATHRULE_DIR_MODE });
    const dbPath = join(dir, "pathrule.db");
    const backend = new LocalBackend(dbPath, { embeddingEnv: env, ...options });
    try {
      chmodSync(dbPath, PATHRULE_FILE_MODE);
    } catch {
      // Best-effort on platforms without POSIX perms (e.g. Windows).
    }
    return backend;
  }

  /**
   * Mark a store as a MIRROR of a hosted workspace rather than a workspace in its own
   * right.
   *
   * Both kinds of store look identical on disk: same path shape, same schema, a
   * `local_root_path` pointing at the same folder. But they mean opposite things. A
   * workspace store is the authority for its content; a mirror is a local copy of an
   * authority that lives elsewhere, and treating one as the other silently swaps which
   * copy of a user's knowledge is in charge.
   *
   * The marker is a FILE, because the question is asked at launch by a process that has
   * opened nothing yet, and an in-memory flag would be gone exactly then.
   */
  static markAsMirror(workspaceId: string, env: NodeJS.ProcessEnv = process.env): void {
    const dir = join(pathruleHome(env), workspaceId);
    try {
      mkdirSync(dir, { recursive: true, mode: PATHRULE_DIR_MODE });
      writeFileSync(join(dir, MIRROR_MARKER), "", { mode: PATHRULE_FILE_MODE });
    } catch {
      // Best-effort. A missing marker degrades to the previous behaviour (the store looks
      // like a workspace), so it must not fail the write that triggered it.
    }
  }

  /** True if this store is a mirror of a hosted workspace. */
  static isMirror(workspaceId: string, env: NodeJS.ProcessEnv = process.env): boolean {
    return existsSync(join(pathruleHome(env), workspaceId, MIRROR_MARKER));
  }

  /**
   * Discover which local workspace store serves a cwd, WITHOUT opening
   * a writable backend first. Scans `~/.pathrule/<id>/pathrule.db` (honoring
   * `PATHRULE_HOME`), reads each store's `workspaces.local_root_path` (read-only,
   * no migration), and longest-prefix-matches the cwd — the same rule as
   * resolveWorkspaceFromCwd, but across the per-workspace stores.
   * Returns null when no local workspace covers the path (caller → `pathrule init`).
   * This is the OSS CLI's entry primitive: pick the workspace, then
   * `openForWorkspace(match.workspaceId)`.
   */
  static discoverWorkspaceForCwd(
    cwd: string,
    env: NodeJS.ProcessEnv = process.env,
    options: { includeMirrors?: boolean } = {},
  ): WorkspaceMatch | null {
    return discoverWorkspaceStoreForCwd(cwd, env, options);
  }

  /**
   * Every local workspace of a Pathrule home, read the way `discoverWorkspaceForCwd` reads:
   * each `~/.pathrule/<id>/pathrule.db` (honoring `PATHRULE_HOME`) opened read-only, no
   * migration, its `workspaces` row with a `local_root_path`. Mirrors of hosted workspaces
   * are never listed: they are copies of an authority that lives elsewhere, not workspaces.
   * An unreadable or pre-schema store is skipped. Sorted by name, then root.
   */
  static listLocalWorkspaces(env: NodeJS.ProcessEnv = process.env): LocalWorkspaceListing[] {
    return listLocalWorkspaceStores(env);
  }

  /** Apply append-only migrations gated on PRAGMA user_version. Idempotent + transactional. */
  private runMigrations(): void {
    const current = this.db.pragma("user_version", { simple: true }) as number;
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      const apply = this.db.transaction(() => {
        this.db.exec(migration.sql);
        this.db.pragma(`user_version = ${migration.version}`);
      });
      apply();
    }
  }

  /** Release the SQLite handle. */
  close(): void {
    this.db.close();
  }

  sessionIsCurrent(): Promise<boolean> {
    return Promise.resolve(true);
  }

  // ── workspace resolution ──────────────────────────────────────────────────
  /**
   * Register/refresh a local workspace's root path (idempotent). The OSS runtime
   * (`pathrule init`) calls this so resolveWorkspaceFromCwd can map a
   * cwd back to this workspace. Not on the cross-edition interface — the hosted
   * edition creates workspaces via onboarding, not this path.
   */
  registerWorkspace(input: { workspaceId: string; name?: string; localRootPath: string }): void {
    this.db
      .prepare(
        `INSERT INTO workspaces (id, name, local_root_path, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           local_root_path = excluded.local_root_path,
           name = COALESCE(excluded.name, workspaces.name)`,
      )
      .run(
        input.workspaceId,
        input.name ?? input.workspaceId,
        canonicalizePath(input.localRootPath),
        this.now(),
      );
  }

  /**
   * Display name registered for a local workspace, used to title the rendered
   * companion files. Local-only convenience getter — not on the cross-edition
   * interface (Pathrule Cloud reads its workspace's name itself).
   * Falls back to `null` when the workspace is unknown.
   */
  getWorkspaceName(workspaceId: string): string | null {
    const row = this.db
      .prepare("SELECT name FROM workspaces WHERE id = ? LIMIT 1")
      .get(workspaceId) as { name: string | null } | undefined;
    return row?.name ?? null;
  }

  /**
   * Register an extra local checkout (a git worktree) that resolves to a
   * workspace. `registerWorkspace` above owns the ONE canonical clone; an isolated
   * agent session runs in another directory entirely, and without a row here it
   * resolves to no workspace and loses all of its path-scoped knowledge.
   * Local-only seam, like registerWorkspace: Pathrule Cloud keeps its own
   * folder attachments.
   */
  registerWorktreePath(input: {
    workspaceId: string;
    localRootPath: string;
    branch?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO workspace_worktree_paths (local_root_path, workspace_id, branch, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(local_root_path) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           branch = COALESCE(excluded.branch, workspace_worktree_paths.branch)`,
      )
      .run(
        canonicalizePath(input.localRootPath),
        input.workspaceId,
        input.branch ?? null,
        this.now(),
      );
  }

  /** Forget a worktree binding (the checkout was removed). */
  unregisterWorktreePath(localRootPath: string): void {
    this.db
      .prepare("DELETE FROM workspace_worktree_paths WHERE local_root_path = ?")
      .run(canonicalizePath(localRootPath));
  }

  /** The worktree bindings known to this store. */
  listWorktreePaths(): Array<{ workspaceId: string; localRootPath: string; branch: string | null }> {
    const rows = this.db
      .prepare(
        "SELECT local_root_path, workspace_id, branch FROM workspace_worktree_paths ORDER BY created_at DESC",
      )
      .all() as Array<{ local_root_path: string; workspace_id: string; branch: string | null }>;
    return rows.map((r) => ({
      workspaceId: r.workspace_id,
      localRootPath: r.local_root_path,
      branch: r.branch,
    }));
  }

  resolveWorkspaceFromCwd(cwd: string): Promise<WorkspaceMatch | null> {
    const normalizedCwd = canonicalizePath(cwd);
    const rows = this.db
      .prepare("SELECT id, local_root_path FROM workspaces WHERE local_root_path IS NOT NULL")
      .all() as Array<{ id: string; local_root_path: string }>;
    // Worktree roots are candidates too, and they compete under the SAME
    // longest-prefix rule: a canonical root deeper than a worktree root still wins,
    // so a nested workspace is never shadowed by an outer worktree.
    const worktreeRows = this.db
      .prepare("SELECT workspace_id, local_root_path FROM workspace_worktree_paths")
      .all() as Array<{ workspace_id: string; local_root_path: string }>;
    const best = [
      ...rows.map((r) => ({ wid: r.id, root: normalizePathTail(r.local_root_path) })),
      ...worktreeRows.map((r) => ({
        wid: r.workspace_id,
        root: normalizePathTail(r.local_root_path),
      })),
    ]
      .filter((r) => pathsEqual(normalizedCwd, r.root) || pathStartsWith(normalizedCwd, r.root))
      .sort((a, b) => b.root.length - a.root.length)[0];
    if (!best) return Promise.resolve(null);
    const relativePath = pathsEqual(normalizedCwd, best.root)
      ? ""
      : normalizedCwd.slice(best.root.length);
    return Promise.resolve({
      workspaceId: best.wid,
      localRootPath: best.root,
      relativePath,
    });
  }

  closestNode(workspaceId: string, relativePath: string): Promise<ClosestNode | null> {
    const candidates: string[] = [];
    let cur = relativePath;
    while (cur.length > 0) {
      candidates.push(cur);
      const idx = cur.lastIndexOf("/");
      if (idx <= 0) break;
      cur = cur.slice(0, idx);
    }
    candidates.push(""); // workspace root last
    const rows = this.db
      .prepare(
        `SELECT id, relative_path FROM nodes
          WHERE workspace_id = ? AND relative_path IN (${candidates.map(() => "?").join(",")})`,
      )
      .all(workspaceId, ...candidates) as Array<{ id: string; relative_path: string }>;
    const byPath = new Map(rows.map((r) => [r.relative_path, r.id]));
    for (const candidate of candidates) {
      const id = byPath.get(candidate);
      if (id) return Promise.resolve({ id, relativePath: candidate });
    }
    return Promise.resolve(null);
  }

  // ── memory CRUD ──────────────────────────────────────────────────────────
  private toMemory(r: MemoryRow): Memory {
    return {
      id: r.id,
      workspaceId: r.workspace_id,
      nodeId: r.node_id,
      title: r.title,
      content: r.content,
      source: r.source as Memory["source"],
      versionId: r.version_id,
      versionNumber: r.version_number,
      createdBy: r.created_by,
      lastEditedBy: r.last_edited_by,
      lastEditedAt: r.last_edited_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  readMemory(id: string): Promise<Memory | null> {
    const row = this.db
      .prepare("SELECT * FROM memories WHERE id = ? AND status = 'active'")
      .get(id) as MemoryRow | undefined;
    return Promise.resolve(row ? this.toMemory(row) : null);
  }

  /**
   * Best-effort embed + upsert for one memory. No-op when semantic is unwired;
   * swallows provider/network failures (the write already succeeded — a missing
   * embedding just means that memory won't surface in semantic search yet).
   */
  private async embedAndStore(
    memoryId: string,
    workspaceId: string,
    title: string,
    content: string,
  ): Promise<void> {
    if (!this.semanticEnabled) return;
    try {
      const result = await this.embed(composeEmbeddingText(title, content), {
        inputType: "document",
      });
      if (result) storeMemoryEmbedding(this.db, memoryId, workspaceId, result, this.now());
    } catch {
      // Best-effort: a failed embedding never fails the memory write.
    }
  }

  /** The workspace path of the node that owns a memory; null when it has none. */
  private memoryOwnerPath(nodeId: string | null | undefined): string | null {
    if (!nodeId) return null;
    const row = this.db.prepare("SELECT relative_path FROM nodes WHERE id = ?").get(nodeId) as
      | { relative_path: string }
      | undefined;
    return row?.relative_path ?? null;
  }

  private memoryRelatedPaths(memoryId: string): string[] {
    return (
      this.db
        .prepare("SELECT path FROM memory_related_paths WHERE memory_id = ? ORDER BY path")
        .all(memoryId) as Array<{ path: string }>
    ).map((r) => r.path);
  }

  /** Replace a memory's links. Call inside the transaction that writes the memory row. */
  private replaceMemoryRelatedPaths(memoryId: string, links: readonly string[]): void {
    this.db.prepare("DELETE FROM memory_related_paths WHERE memory_id = ?").run(memoryId);
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO memory_related_paths (memory_id, path) VALUES (?, ?)",
    );
    for (const path of links) insert.run(memoryId, path);
  }

  async writeMemory(input: WriteMemoryInput): Promise<Memory> {
    const ts = this.now();
    // Validated before anything is stored, so a rejected link list writes nothing.
    const links =
      input.relatedPaths === undefined
        ? undefined
        : nextRelatedPaths([], input.relatedPaths, this.memoryOwnerPath(input.nodeId));
    const row: MemoryRow = {
      // A client-supplied id keeps the local mirror row and its eventual cloud row the
      // SAME record; without it a queued write becomes two.
      id: input.id ?? this.genId(),
      workspace_id: input.workspaceId,
      node_id: input.nodeId ?? "",
      title: input.title,
      content: input.content,
      source: input.source ?? "claude",
      version_id: this.genId(),
      version_number: 1,
      created_by: this.principal,
      last_edited_by: this.principal,
      last_edited_at: ts,
      created_at: ts,
      updated_at: ts,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO memories (id, workspace_id, node_id, title, content, source, version_id,
            version_number, created_by, last_edited_by, last_edited_at, created_at, updated_at)
           VALUES (@id, @workspace_id, @node_id, @title, @content, @source, @version_id,
            @version_number, @created_by, @last_edited_by, @last_edited_at, @created_at, @updated_at)
           -- A caller-supplied id promises an IDEMPOTENT write, and that promise has to hold
           -- here too: re-writing the same record (a queued write replayed, an author saving
           -- twice) must land the newer body instead of failing on the unique index. A
           -- generated id can never conflict, so this only ever fires for a supplied one.
           ON CONFLICT(id) DO UPDATE SET
             node_id = excluded.node_id,
             title = excluded.title,
             content = excluded.content,
             source = excluded.source,
             version_id = excluded.version_id,
             version_number = memories.version_number + 1,
             last_edited_by = excluded.last_edited_by,
             last_edited_at = excluded.last_edited_at,
             updated_at = excluded.updated_at`,
        )
        .run(row);
      if (links !== undefined) this.replaceMemoryRelatedPaths(row.id, links);
    })();
    await this.embedAndStore(row.id, row.workspace_id, row.title, row.content);
    return this.toMemory(row);
  }

  async updateMemory(input: UpdateMemoryInput): Promise<Memory> {
    const existing = await this.readMemory(input.id);
    if (!existing) throw new Error(`memory ${input.id} not found`);
    if (input.expectedVersionId && input.expectedVersionId !== existing.versionId) {
      throw new Error("content_version_conflict");
    }
    // Owner, body and links change together: validate the links before anything moves.
    const links = nextRelatedPaths(
      this.memoryRelatedPaths(input.id),
      input.relatedPaths,
      this.memoryOwnerPath(input.nodeId ?? existing.nodeId),
    );
    const ts = this.now();
    const nextVersionId = this.genId();
    this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE memories SET title = ?, content = ?, node_id = ?, version_id = ?, version_number = ?,
            last_edited_by = ?, last_edited_at = ?, updated_at = ?
            WHERE id = ? AND version_id = ?`,
        )
        .run(
          input.title ?? existing.title,
          input.content ?? existing.content,
          input.nodeId ?? existing.nodeId,
          nextVersionId,
          existing.versionNumber + 1,
          this.principal,
          ts,
          ts,
          input.id,
          input.expectedVersionId ?? existing.versionId,
        );
      // Throwing inside the transaction rolls the link change back with the row.
      if (result.changes !== 1) throw new Error("content_version_conflict");
      this.replaceMemoryRelatedPaths(input.id, links);
    })();
    const updated = await this.readMemory(input.id);
    if (!updated) throw new Error(`memory ${input.id} vanished after update`);
    // Re-embed only when the embedded text actually changed. A node-only re-home
    // (move_to_path) leaves title+content untouched, and embedAndStore is a paid
    // network round-trip — skip it when nothing the vector depends on moved.
    const textChanged = updated.title !== existing.title || updated.content !== existing.content;
    if (textChanged) {
      await this.embedAndStore(updated.id, updated.workspaceId, updated.title, updated.content);
    }
    return updated;
  }

  /**
   * Soft/hard delete shared by the memory, rule, and skill delete methods. The three
   * differ only in data: which table, which child-link rows to purge on a hard delete,
   * and whether a node id is carried back. Behavior is identical — not-found and
   * optimistic-version-conflict are checked the same way, and a soft delete just flips
   * the row to `archived` (restore re-includes it). There are no FK cascades in the
   * schema, so a hard delete purges child rows explicitly (children first, then the row).
   */
  private async deleteContent(
    input: DeleteContentInput,
    spec: {
      read: (id: string) => Promise<{
        id: string;
        workspaceId: string;
        versionId: string;
        nodeId?: string | null;
      } | null>;
      table: "memories" | "rules" | "skills";
      /** Link/derived tables to purge on a hard delete (none on a soft delete). */
      childTables: ReadonlyArray<{ table: string; column: string }>;
    },
  ): Promise<DeleteContentResult> {
    const existing = await spec.read(input.id);
    if (!existing) return { status: "rejected", reason: "not_found" };
    if (input.expectedVersionId && existing.versionId !== input.expectedVersionId) {
      return { status: "conflict", currentVersionId: existing.versionId };
    }
    if (input.hard) {
      for (const child of spec.childTables) {
        this.db.prepare(`DELETE FROM ${child.table} WHERE ${child.column} = ?`).run(input.id);
      }
      this.db.prepare(`DELETE FROM ${spec.table} WHERE id = ?`).run(input.id);
    } else {
      this.db.prepare(`UPDATE ${spec.table} SET status = 'archived' WHERE id = ?`).run(input.id);
    }
    return {
      status: "deleted",
      id: existing.id,
      workspaceId: existing.workspaceId,
      nodeId: existing.nodeId ?? null,
    };
  }

  deleteMemory(input: DeleteContentInput): Promise<DeleteContentResult> {
    // Hard delete also purges the embedding + context-path rows (no FK cascade);
    // a soft delete leaves them — semanticCandidates joins only active memories,
    // so archived rows never surface, and restore re-includes them.
    return this.deleteContent(input, {
      read: (id) => this.readMemory(id),
      table: "memories",
      childTables: [
        { table: "memory_embeddings", column: "memory_id" },
        { table: "memory_context_paths", column: "memory_id" },
        { table: "memory_related_paths", column: "memory_id" },
      ],
    });
  }

  /** Flip an archived row back to active. Shared by the three restore methods. */
  private restoreContent(
    table: "memories" | "rules" | "skills",
    id: string,
    withNode: boolean,
  ): RestoreContentResult {
    const row = this.db
      .prepare(
        `SELECT id, workspace_id, status${withNode ? ", node_id" : ""} FROM ${table} WHERE id = ?`,
      )
      .get(id) as
      | { id: string; workspace_id: string; status: string; node_id?: string }
      | undefined;
    if (!row) return { status: "rejected", reason: "not_found" };
    if (row.status !== "archived") return { status: "rejected", reason: "not_deleted" };
    this.db.prepare(`UPDATE ${table} SET status = 'active' WHERE id = ?`).run(id);
    return {
      status: "restored",
      id: row.id,
      workspaceId: row.workspace_id,
      nodeId: row.node_id ?? null,
    };
  }

  restoreMemory(id: string): Promise<RestoreContentResult> {
    return Promise.resolve(this.restoreContent("memories", id, true));
  }

  listMemories(query: ListMemoriesQuery): Promise<Memory[]> {
    const status = query.status ?? "active";
    const rows = (
      query.nodeId === undefined
        ? this.db
            .prepare(
              "SELECT * FROM memories WHERE workspace_id = ? AND status = ? ORDER BY created_at",
            )
            .all(query.workspaceId, status)
        : this.db
            .prepare(
              "SELECT * FROM memories WHERE workspace_id = ? AND node_id = ? AND status = ? ORDER BY created_at",
            )
            .all(query.workspaceId, query.nodeId, status)
    ) as MemoryRow[];
    return Promise.resolve(rows.map((r) => this.toMemory(r)));
  }

  // ── rule CRUD ──────────────────────────────────────────────────────────────
  private toRule(r: RuleRow): Rule {
    const constraints = parseRuleAtoms(r.constraints);
    return {
      id: r.id,
      workspaceId: r.workspace_id,
      name: r.name,
      content: r.content,
      scopeType: r.scope_type as Rule["scopeType"],
      priority: r.priority as Rule["priority"],
      versionId: r.version_id,
      versionNumber: r.version_number,
      createdBy: r.created_by,
      lastEditedBy: r.last_edited_by,
      lastEditedAt: r.last_edited_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      ...(constraints.length > 0 ? { constraints } : {}),
    };
  }

  readRule(id: string): Promise<Rule | null> {
    const row = this.db
      .prepare("SELECT * FROM rules WHERE id = ? AND status = 'active'")
      .get(id) as RuleRow | undefined;
    return Promise.resolve(row ? this.toRule(row) : null);
  }

  writeRule(input: WriteRuleInput): Promise<Rule> {
    const ts = this.now();
    const row: RuleRow = {
      // A client-supplied id keeps the local mirror row and its eventual cloud row the
      // SAME record; without it a queued write becomes two.
      id: input.id ?? this.genId(),
      workspace_id: input.workspaceId,
      name: input.name,
      content: input.content,
      scope_type: input.scopeType,
      priority: input.priority ?? "medium",
      version_id: this.genId(),
      version_number: 1,
      created_by: this.principal,
      last_edited_by: this.principal,
      last_edited_at: ts,
      created_at: ts,
      updated_at: ts,
      constraints: JSON.stringify(input.constraints ?? []),
    };
    this.db
      .prepare(
        `INSERT INTO rules (id, workspace_id, name, content, scope_type, priority, version_id,
          version_number, created_by, last_edited_by, last_edited_at, created_at, updated_at,
          constraints)
         VALUES (@id, @workspace_id, @name, @content, @scope_type, @priority, @version_id,
          @version_number, @created_by, @last_edited_by, @last_edited_at, @created_at, @updated_at,
          @constraints)`,
      )
      .run(row);
    if (input.nodeId) {
      this.db
        .prepare("INSERT OR IGNORE INTO node_rules (node_id, rule_id) VALUES (?, ?)")
        .run(input.nodeId, row.id);
    }
    return Promise.resolve(this.toRule(row));
  }

  async updateRule(input: UpdateRuleInput): Promise<Rule> {
    const existing = await this.readRule(input.id);
    if (!existing) throw new Error(`rule ${input.id} not found`);
    if (input.expectedVersionId && input.expectedVersionId !== existing.versionId) {
      throw new Error("content_version_conflict");
    }
    const ts = this.now();
    const nextVersionId = this.genId();
    const result = this.db
      .prepare(
        `UPDATE rules SET name = ?, content = ?, scope_type = ?, priority = ?, constraints = ?,
          version_id = ?,
          version_number = ?, last_edited_by = ?, last_edited_at = ?, updated_at = ?
          WHERE id = ? AND version_id = ?`,
      )
      .run(
        input.name ?? existing.name,
        input.content ?? existing.content,
        input.scopeType ?? existing.scopeType,
        input.priority ?? existing.priority,
        JSON.stringify(input.constraints ?? existing.constraints ?? []),
        nextVersionId,
        existing.versionNumber + 1,
        this.principal,
        ts,
        ts,
        input.id,
        input.expectedVersionId ?? existing.versionId,
      );
    if (result.changes !== 1) throw new Error("content_version_conflict");
    if (input.nodeId) {
      // Re-home: replace any existing attachments with one pointing at the new node.
      this.db.prepare("DELETE FROM node_rules WHERE rule_id = ?").run(input.id);
      this.db
        .prepare("INSERT OR IGNORE INTO node_rules (node_id, rule_id) VALUES (?, ?)")
        .run(input.nodeId, input.id);
    }
    const updated = await this.readRule(input.id);
    if (!updated) throw new Error(`rule ${input.id} vanished after update`);
    return updated;
  }

  deleteRule(input: DeleteContentInput): Promise<DeleteContentResult> {
    return this.deleteContent(input, {
      read: (id) => this.readRule(id),
      table: "rules",
      childTables: [{ table: "node_rules", column: "rule_id" }],
    });
  }

  restoreRule(id: string): Promise<RestoreContentResult> {
    return Promise.resolve(this.restoreContent("rules", id, false));
  }

  listRules(query: ListRulesQuery): Promise<Rule[]> {
    const rows = this.db
      .prepare("SELECT * FROM rules WHERE workspace_id = ? AND status = ?")
      .all(query.workspaceId, query.status ?? "active") as RuleRow[];
    return Promise.resolve(rows.map((r) => this.toRule(r)));
  }

  // ── skill CRUD ───────────────────────────────────────────────────────────────
  private toSkill(r: SkillRow): Skill {
    return {
      id: r.id,
      workspaceId: r.workspace_id,
      name: r.name,
      description: r.description,
      content: r.content,
      source: r.source as Skill["source"],
      githubUrl: r.github_url,
      version: r.version,
      tags: parseJsonArray(r.tags),
      versionId: r.version_id,
      versionNumber: r.version_number,
      createdBy: r.created_by,
      lastEditedBy: r.last_edited_by,
      lastEditedAt: r.last_edited_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      contentFetchedAt: r.content_fetched_at,
    };
  }

  readSkill(id: string): Promise<Skill | null> {
    const row = this.db
      .prepare("SELECT * FROM skills WHERE id = ? AND status = 'active'")
      .get(id) as SkillRow | undefined;
    return Promise.resolve(row ? this.toSkill(row) : null);
  }

  writeSkill(input: WriteSkillInput): Promise<Skill> {
    const ts = this.now();
    const source = input.source ?? "manual";
    const row: SkillRow = {
      id: input.id ?? this.genId(),
      workspace_id: input.workspaceId,
      name: input.name,
      description: input.description ?? null,
      content: input.content,
      source,
      github_url: input.githubUrl ?? null,
      version: "1.0.0",
      tags: JSON.stringify(input.tags ?? []),
      version_id: this.genId(),
      version_number: 1,
      created_by: this.principal,
      last_edited_by: this.principal,
      last_edited_at: ts,
      created_at: ts,
      updated_at: ts,
      content_fetched_at: source === "github_ref" ? ts : null,
    };
    this.db
      .prepare(
        `INSERT INTO skills (id, workspace_id, name, description, content, source, github_url,
          version, tags, version_id, version_number, created_by, last_edited_by, last_edited_at,
          created_at, updated_at, content_fetched_at)
         VALUES (@id, @workspace_id, @name, @description, @content, @source, @github_url,
          @version, @tags, @version_id, @version_number, @created_by, @last_edited_by, @last_edited_at,
          @created_at, @updated_at, @content_fetched_at)`,
      )
      .run(row);
    if (input.nodeId) {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO node_skills (node_id, skill_id, is_active) VALUES (?, ?, 1)",
        )
        .run(input.nodeId, row.id);
    }
    return Promise.resolve(this.toSkill(row));
  }

  async updateSkill(input: UpdateSkillInput): Promise<Skill> {
    const existing = await this.readSkill(input.id);
    if (!existing) throw new Error(`skill ${input.id} not found`);
    if (input.expectedVersionId && input.expectedVersionId !== existing.versionId) {
      throw new Error("content_version_conflict");
    }
    const ts = this.now();
    // Patch only supplied fields (null clears description/github_url; never reorder).
    const sets = [
      "version_id = ?",
      "version_number = ?",
      "last_edited_by = ?",
      "last_edited_at = ?",
      "updated_at = ?",
    ];
    const vals: unknown[] = [this.genId(), existing.versionNumber + 1, this.principal, ts, ts];
    if (input.name !== undefined) (sets.push("name = ?"), vals.push(input.name));
    if (input.content !== undefined) (sets.push("content = ?"), vals.push(input.content));
    if (input.description !== undefined)
      (sets.push("description = ?"), vals.push(input.description));
    if (input.source !== undefined) (sets.push("source = ?"), vals.push(input.source));
    if (input.githubUrl !== undefined) (sets.push("github_url = ?"), vals.push(input.githubUrl));
    if (input.tags !== undefined) (sets.push("tags = ?"), vals.push(JSON.stringify(input.tags)));
    const effectiveSource = input.source ?? existing.source;
    if (input.content !== undefined && effectiveSource === "github_ref") {
      sets.push("content_fetched_at = ?");
      vals.push(ts);
    }
    vals.push(input.id, input.expectedVersionId ?? existing.versionId);
    const result = this.db
      .prepare(`UPDATE skills SET ${sets.join(", ")} WHERE id = ? AND version_id = ?`)
      .run(...vals);
    if (result.changes !== 1) throw new Error("content_version_conflict");
    if (input.nodeId) {
      this.db.prepare("DELETE FROM node_skills WHERE skill_id = ?").run(input.id);
      this.db
        .prepare(
          "INSERT OR IGNORE INTO node_skills (node_id, skill_id, is_active) VALUES (?, ?, 1)",
        )
        .run(input.nodeId, input.id);
    }
    const updated = await this.readSkill(input.id);
    if (!updated) throw new Error(`skill ${input.id} vanished after update`);
    return updated;
  }

  deleteSkill(input: DeleteContentInput): Promise<DeleteContentResult> {
    return this.deleteContent(input, {
      read: (id) => this.readSkill(id),
      table: "skills",
      childTables: [{ table: "node_skills", column: "skill_id" }],
    });
  }

  restoreSkill(id: string): Promise<RestoreContentResult> {
    return Promise.resolve(this.restoreContent("skills", id, false));
  }

  listSkills(query: ListSkillsQuery): Promise<Skill[]> {
    const rows = this.db
      .prepare("SELECT * FROM skills WHERE workspace_id = ? AND status = ?")
      .all(query.workspaceId, query.status ?? "active") as SkillRow[];
    return Promise.resolve(rows.map((r) => this.toSkill(r)));
  }

  // ── tree ─────────────────────────────────────────────────────────────────────
  private toTreeNode(r: Record<string, unknown>): TreeNode {
    return {
      id: r["id"] as string,
      workspaceId: r["workspace_id"] as string,
      parentId: (r["parent_id"] as string | null) ?? null,
      name: r["name"] as string,
      type: r["type"] as TreeNode["type"],
      relativePath: r["relative_path"] as string,
      orderIndex: r["order_index"] as number,
      status: r["status"] as TreeNode["status"],
      orphanedAt: (r["orphaned_at"] as string | null) ?? null,
      originalPath: (r["original_path"] as string | null) ?? null,
      createdAt: r["created_at"] as string,
      updatedAt: r["updated_at"] as string,
    };
  }

  getTree(workspaceId: string): Promise<TreeNode[]> {
    const rows = this.db
      .prepare("SELECT * FROM nodes WHERE workspace_id = ? ORDER BY order_index")
      .all(workspaceId) as Array<Record<string, unknown>>;
    return Promise.resolve(rows.map((r) => this.toTreeNode(r)));
  }

  getNode(nodeId: string): Promise<TreeNode | null> {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(nodeId) as
      | Record<string, unknown>
      | undefined;
    return Promise.resolve(row ? this.toTreeNode(row) : null);
  }

  getNodeDetail(nodeId: string): Promise<NodeDetailRecord | null> {
    const node = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(nodeId) as
      | Record<string, unknown>
      | undefined;
    if (!node) return Promise.resolve(null);
    const memoryIds = (
      this.db
        .prepare("SELECT id FROM memories WHERE node_id = ? AND status = 'active'")
        .all(nodeId) as Array<{ id: string }>
    ).map((r) => r.id);
    const ruleIds = (
      this.db.prepare("SELECT rule_id FROM node_rules WHERE node_id = ?").all(nodeId) as Array<{
        rule_id: string;
      }>
    ).map((r) => r.rule_id);
    const skillIds = (
      this.db
        .prepare("SELECT skill_id FROM node_skills WHERE node_id = ? AND is_active = 1")
        .all(nodeId) as Array<{ skill_id: string }>
    ).map((r) => r.skill_id);
    return Promise.resolve({
      id: node["id"] as string,
      workspaceId: node["workspace_id"] as string,
      parentId: (node["parent_id"] as string | null) ?? null,
      name: node["name"] as string,
      type: node["type"] as string,
      relativePath: node["relative_path"] as string,
      memoryIds,
      ruleIds,
      skillIds,
    });
  }

  workspaceOverview(workspaceId: string, excludeNodeId?: string): Promise<WorkspaceOverviewNode[]> {
    const nodes = (
      this.db
        .prepare("SELECT id, relative_path FROM nodes WHERE workspace_id = ? AND status = 'active'")
        .all(workspaceId) as Array<{ id: string; relative_path: string }>
    ).map((n) => ({ id: n.id, relativePath: n.relative_path }));
    const memories = (
      this.db
        .prepare(
          "SELECT id, title, node_id FROM memories WHERE workspace_id = ? AND status = 'active' ORDER BY created_at ASC",
        )
        .all(workspaceId) as Array<{ id: string; title: string; node_id: string }>
    ).map((m) => ({ id: m.id, title: m.title, nodeId: m.node_id }));
    const rules = (
      this.db
        .prepare(
          `SELECT nr.node_id AS node_id, r.id AS id, r.name AS name, r.content AS content,
            r.scope_type AS scope_type, r.priority AS priority
           FROM node_rules nr JOIN rules r ON r.id = nr.rule_id
           WHERE r.workspace_id = ? AND r.status = 'active'`,
        )
        .all(workspaceId) as Array<{
        node_id: string;
        id: string;
        name: string;
        content: string;
        scope_type: string;
        priority: string;
      }>
    ).map((r) => ({
      nodeId: r.node_id,
      id: r.id,
      name: r.name,
      content: r.content,
      scopeType: r.scope_type,
      priority: r.priority,
    }));
    const skills = (
      this.db
        .prepare(
          `SELECT ns.node_id AS node_id, s.id AS id, s.name AS name, s.description AS description,
            s.source AS source, s.tags AS tags
           FROM node_skills ns JOIN skills s ON s.id = ns.skill_id
           WHERE ns.is_active = 1 AND s.workspace_id = ? AND s.status = 'active'`,
        )
        .all(workspaceId) as Array<{
        node_id: string;
        id: string;
        name: string;
        description: string | null;
        source: string;
        tags: string | null;
      }>
    ).map((s) => ({
      nodeId: s.node_id,
      id: s.id,
      name: s.name,
      description: s.description,
      source: s.source,
      tags: parseJsonArray(s.tags),
    }));
    return Promise.resolve(
      buildWorkspaceOverview({ nodes, memories, rules, skills, excludeNodeId }),
    );
  }

  findNodeByPath(workspaceId: string, relativePath: string): Promise<NodeRef | null> {
    const row = this.db
      .prepare(
        "SELECT id, name, relative_path FROM nodes WHERE workspace_id = ? AND relative_path = ? LIMIT 1",
      )
      .get(workspaceId, relativePath) as
      | { id: string; name: string; relative_path: string }
      | undefined;
    return Promise.resolve(
      row ? { id: row.id, name: row.name, relativePath: row.relative_path } : null,
    );
  }

  getNodeContent(nodeId: string): Promise<NodeContent> {
    const memories = (
      this.db
        .prepare(
          "SELECT id, title, content FROM memories WHERE node_id = ? AND status = 'active' ORDER BY created_at ASC",
        )
        .all(nodeId) as Array<{ id: string; title: string; content: string }>
    ).map((m) => ({ id: m.id, title: m.title, content: m.content }));
    const rules = (
      this.db
        .prepare(
          `SELECT r.id AS id, r.name AS name, r.content AS content, r.scope_type AS scope_type,
            r.priority AS priority
           FROM node_rules nr JOIN rules r ON r.id = nr.rule_id
           WHERE nr.node_id = ? AND r.status = 'active'`,
        )
        .all(nodeId) as Array<{
        id: string;
        name: string;
        content: string;
        scope_type: string;
        priority: string;
      }>
    ).map((r) => ({
      id: r.id,
      name: r.name,
      content: r.content,
      scopeType: r.scope_type,
      priority: r.priority,
    }));
    const skills = (
      this.db
        .prepare(
          `SELECT s.id AS id, s.name AS name, s.description AS description, s.source AS source,
            s.tags AS tags
           FROM node_skills ns JOIN skills s ON s.id = ns.skill_id
           WHERE ns.node_id = ? AND ns.is_active = 1 AND s.status = 'active'`,
        )
        .all(nodeId) as Array<{
        id: string;
        name: string;
        description: string | null;
        source: string;
        tags: string | null;
      }>
    ).map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      source: s.source,
      tags: parseJsonArray(s.tags),
    }));
    return Promise.resolve({ memories, rules, skills });
  }

  listSkillsForInvocation(workspaceId: string): Promise<InvocationSkill[]> {
    const rows = this.db
      .prepare(
        "SELECT id, name, description, content, source, github_url FROM skills WHERE workspace_id = ? AND status = 'active'",
      )
      .all(workspaceId) as Array<{
      id: string;
      name: string;
      description: string | null;
      content: string;
      source: string;
      github_url: string | null;
    }>;
    return Promise.resolve(
      rows.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        content: s.content,
        source: s.source,
        githubUrl: s.github_url,
      })),
    );
  }

  getNodeForRule(ruleId: string): Promise<TreeNode | null> {
    const row = this.db
      .prepare("SELECT node_id FROM node_rules WHERE rule_id = ? LIMIT 1")
      .get(ruleId) as { node_id: string } | undefined;
    return row ? this.getNode(row.node_id) : Promise.resolve(null);
  }

  getNodeForSkill(skillId: string): Promise<TreeNode | null> {
    const row = this.db
      .prepare("SELECT node_id FROM node_skills WHERE skill_id = ? LIMIT 1")
      .get(skillId) as { node_id: string } | undefined;
    return row ? this.getNode(row.node_id) : Promise.resolve(null);
  }

  private selectNodeByPath(workspaceId: string, relativePath: string): MaterialisedNode | null {
    const row = this.db
      .prepare(
        "SELECT id, workspace_id, parent_id, name, type, relative_path FROM nodes WHERE workspace_id = ? AND relative_path = ?",
      )
      .get(workspaceId, relativePath) as MaterialisedNode | undefined;
    return row ?? null;
  }

  private insertNodeRow(
    workspaceId: string,
    parentId: string | null,
    name: string,
    type: MaterialisedNode["type"],
    relativePath: string,
    orderIndex: number,
  ): MaterialisedNode {
    const id = this.genId();
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO nodes (id, workspace_id, parent_id, name, type, relative_path, order_index, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(id, workspaceId, parentId, name, type, relativePath, orderIndex, ts, ts);
    return {
      id,
      workspace_id: workspaceId,
      parent_id: parentId,
      name,
      type,
      relative_path: relativePath,
    };
  }

  ensureNodeForPath(
    workspaceId: string,
    path: string,
    leafType?: MaterialisedNode["type"],
  ): Promise<MaterialisedNode> {
    // Port of shared/tools/nodes.ts materialisation over SQLite: ensure root, then
    // walk root→leaf creating folder ancestors and the typed leaf. The cumulative
    // path IS each node's relative_path, so no separate path builder is needed.
    const relativePath = normalizeNodePath(path);

    let root = this.selectNodeByPath(workspaceId, "/");
    if (!root) {
      const ws = this.db.prepare("SELECT name FROM workspaces WHERE id = ?").get(workspaceId) as
        | { name?: string }
        | undefined;
      root = this.insertNodeRow(workspaceId, null, ws?.name ?? "Workspace", "folder", "/", 0);
    }
    if (relativePath === "/") return Promise.resolve(root);

    const existing = this.selectNodeByPath(workspaceId, relativePath);
    if (existing) return Promise.resolve(existing);

    const segments = relativePath.split("/").filter((s) => s.length > 0);
    const resolvedLeafType = leafType ?? guessLeafType(relativePath);
    let parent = root;
    let cumulative = "";
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i]!;
      cumulative += "/" + seg;
      const here = this.selectNodeByPath(workspaceId, cumulative);
      if (here) {
        parent = here;
        continue;
      }
      const { c } = this.db
        .prepare("SELECT COUNT(*) AS c FROM nodes WHERE workspace_id = ? AND parent_id = ?")
        .get(workspaceId, parent.id) as { c: number };
      const type = i === segments.length - 1 ? resolvedLeafType : "folder";
      parent = this.insertNodeRow(workspaceId, parent.id, seg, type, cumulative, c);
    }
    return Promise.resolve(parent);
  }

  /**
   * Re-homes a node subtree to follow a filesystem move (Explorer cut+paste /
   * drag&drop). The node carrying a folder's memories/rules/skills moves with
   * the folder so attached content is never orphaned at the old path. Mirrors
   * the cloud moveNodeSubtree. No-op when no node exists at `oldPath` (a pure
   * filesystem move of a path that never received Pathrule content).
   */
  async moveNodePath(
    workspaceId: string,
    oldPath: string,
    newPath: string,
  ): Promise<{ moved: boolean }> {
    const from = normalizeNodePath(oldPath);
    const to = normalizeNodePath(newPath);
    if (from === to || from === "/") return { moved: false };

    const top = this.selectNodeByPath(workspaceId, from);
    if (!top) return { moved: false };

    const newParentPath = to.slice(0, to.lastIndexOf("/")) || "/";
    const newParent = await this.ensureNodeForPath(workspaceId, newParentPath, "folder");
    const newName = to.slice(to.lastIndexOf("/") + 1) || top.name;
    const ts = this.now();

    // Descendants are repathed by prefix-swap; parent_id inside the subtree is
    // unchanged. Filter in JS (workspaces are small) to avoid LIKE wildcards.
    const descendants = (
      this.db
        .prepare("SELECT id, relative_path FROM nodes WHERE workspace_id = ?")
        .all(workspaceId) as Array<{ id: string; relative_path: string }>
    ).filter((d) => d.relative_path.startsWith(`${from}/`));

    const apply = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE nodes SET parent_id = ?, name = ?, relative_path = ?, updated_at = ? WHERE id = ?",
        )
        .run(newParent.id, newName, to, ts, top.id);
      const upd = this.db.prepare(
        "UPDATE nodes SET relative_path = ?, updated_at = ? WHERE id = ?",
      );
      for (const d of descendants) {
        upd.run(`${to}${d.relative_path.slice(from.length)}`, ts, d.id);
      }
    });
    apply();
    return { moved: true };
  }

  // ── write guards / dedup ─────────────────────────────────────────────────
  isDemoWorkspace(_workspaceId: string): Promise<boolean> {
    return Promise.resolve(false); // OSS has no read-only demo workspaces.
  }

  checkContentDedup(args: DedupCheckArgs): Promise<DedupCheckResult> {
    // Local dedup applies the duplicate gate (normalised exact-title within scope);
    // the fuzzy `similar` list is not computed locally, so it is
    // empty here — the warning it powers is non-fatal.
    const norm = args.candidate.trim().toLowerCase();
    const exclude = args.excludeId ?? "";
    let row: { id: string; title: string } | undefined;
    if (args.kind === "memory") {
      row = this.db
        .prepare(
          "SELECT id, title FROM memories WHERE workspace_id = ? AND node_id = ? AND lower(trim(title)) = ? AND status = 'active' AND id != ? LIMIT 1",
        )
        .get(args.workspaceId, args.nodeId ?? "", norm, exclude) as
        | { id: string; title: string }
        | undefined;
    } else if (args.kind === "rule") {
      row = this.db
        .prepare(
          "SELECT id, name AS title FROM rules WHERE workspace_id = ? AND lower(trim(name)) = ? AND status = 'active' AND id != ? LIMIT 1",
        )
        .get(args.workspaceId, norm, exclude) as { id: string; title: string } | undefined;
    } else {
      row = this.db
        .prepare(
          "SELECT id, name AS title FROM skills WHERE workspace_id = ? AND lower(trim(name)) = ? AND status = 'active' AND id != ? LIMIT 1",
        )
        .get(args.workspaceId, norm, exclude) as { id: string; title: string } | undefined;
    }
    return Promise.resolve({ duplicate: row ?? null, similar: [] });
  }

  // ── context formulas (reference-level) ─────────────────────────────────────────
  subtreeMemoryIndex(scope: ContextScope, limit: number): Promise<SubtreeMemoryIndexResult> {
    const root = scope.relativePath || "/";
    // "/" → whole workspace; otherwise the node at root_path plus its descendants.
    // Descendants are expressed as a wildcard-free, case-sensitive half-open range
    // (`> root+'/'` .. `< root+'0'`, since '/'=0x2F and '0'=0x30) rather than a LIKE
    // pattern: LIKE would treat `%`/`_` in a path as wildcards AND match
    // case-insensitively, both of which diverge from InMemoryBackend's literal
    // `startsWith`. The range stays sargable on relative_path. See subtreeLo/subtreeHi.
    const pathClause =
      root === "/"
        ? ""
        : "AND (n.relative_path = @root OR (n.relative_path > @rootLo AND n.relative_path < @rootHi))";
    const bind = { ws: scope.workspaceId, root, rootLo: `${root}/`, rootHi: `${root}0`, limit };
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM memories m JOIN nodes n ON n.id = m.node_id
           WHERE m.workspace_id = @ws AND m.status = 'active' ${pathClause}`,
        )
        .get(bind) as { c: number }
    ).c;
    const rows = this.db
      .prepare(
        `SELECT m.id AS id, m.title AS title, n.relative_path AS node_path
         FROM memories m JOIN nodes n ON n.id = m.node_id
         WHERE m.workspace_id = @ws AND m.status = 'active' ${pathClause}
         ORDER BY m.created_at ASC LIMIT @limit`,
      )
      .all(bind) as Array<{ id: string; title: string; node_path: string }>;
    return Promise.resolve({ entries: rows, truncated: total > rows.length, total });
  }

  // Fuzzy project-map search. Assemble every content-bearing node (path/name +
  // aggregated memory/rule/skill names + body preview) then rank in TS with the
  // shared trigram word-similarity ranker.
  projectMapSearch(
    workspaceId: string,
    query: string,
    limit = 15,
  ): Promise<ProjectMapSearchResult> {
    if (!query || query.trim().length === 0) {
      return Promise.resolve({ nodes: [], topScore: 0 });
    }
    return Promise.resolve(
      rankProjectMap(this.collectProjectMapCandidates(workspaceId), query, limit),
    );
  }

  /** Gather content-bearing nodes for project-map ranking (only nodes with ≥1 memory/rule/skill). */
  private collectProjectMapCandidates(workspaceId: string): ProjectMapCandidate[] {
    const nodes = this.db
      .prepare(
        "SELECT id, relative_path, name FROM nodes WHERE workspace_id = ? AND status = 'active'",
      )
      .all(workspaceId) as Array<{ id: string; relative_path: string; name: string }>;

    const memRows = this.db
      .prepare(
        "SELECT node_id, title, content FROM memories WHERE workspace_id = ? AND status = 'active' AND node_id != ''",
      )
      .all(workspaceId) as Array<{ node_id: string; title: string; content: string }>;
    const ruleRows = this.db
      .prepare(
        `SELECT nr.node_id AS node_id, r.name AS name, r.content AS content
         FROM node_rules nr JOIN rules r ON r.id = nr.rule_id
         WHERE r.workspace_id = ? AND r.status = 'active'`,
      )
      .all(workspaceId) as Array<{ node_id: string; name: string; content: string }>;
    const skillRows = this.db
      .prepare(
        `SELECT ns.node_id AS node_id, s.name AS name, s.content AS content
         FROM node_skills ns JOIN skills s ON s.id = ns.skill_id
         WHERE s.workspace_id = ? AND s.status = 'active'`,
      )
      .all(workspaceId) as Array<{ node_id: string; name: string; content: string }>;

    interface Agg {
      memTitles: string[];
      ruleNames: string[];
      skillNames: string[];
      memBodies: string[];
      ruleBodies: string[];
      skillBodies: string[];
    }
    const byNode = new Map<string, Agg>();
    const agg = (id: string): Agg => {
      let a = byNode.get(id);
      if (!a) {
        a = {
          memTitles: [],
          ruleNames: [],
          skillNames: [],
          memBodies: [],
          ruleBodies: [],
          skillBodies: [],
        };
        byNode.set(id, a);
      }
      return a;
    };
    for (const r of memRows) {
      const a = agg(r.node_id);
      a.memTitles.push(r.title);
      a.memBodies.push(r.content ?? "");
    }
    for (const r of ruleRows) {
      const a = agg(r.node_id);
      a.ruleNames.push(r.name);
      a.ruleBodies.push(r.content ?? "");
    }
    for (const r of skillRows) {
      const a = agg(r.node_id);
      a.skillNames.push(r.name);
      a.skillBodies.push(r.content ?? "");
    }

    const candidates: ProjectMapCandidate[] = [];
    for (const node of nodes) {
      const a = byNode.get(node.id);
      if (
        !a ||
        (a.memTitles.length === 0 && a.ruleNames.length === 0 && a.skillNames.length === 0)
      ) {
        continue;
      }
      const bodyPreview = [...a.memBodies, ...a.ruleBodies, ...a.skillBodies]
        .join(" ")
        .slice(0, 400);
      candidates.push({
        node_id: node.id,
        path: node.relative_path,
        name: node.name,
        memory_titles: a.memTitles,
        rule_names: a.ruleNames,
        skill_names: a.skillNames,
        body_preview: bodyPreview,
      });
    }
    return candidates;
  }

  // Hot paths derived from activity_logs (the local "who touched what" feed
  // populated by logActivity): top-5 node_paths by count over the last 7 days.
  getHotPaths(workspaceId: string): Promise<HotPath[]> {
    const since = new Date(Date.parse(this.now()) - 7 * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT node_path AS path, COUNT(*) AS change_count
         FROM activity_logs
         WHERE workspace_id = ? AND created_at >= ? AND node_path IS NOT NULL AND node_path != ''
         GROUP BY node_path
         ORDER BY change_count DESC, node_path ASC
         LIMIT 5`,
      )
      .all(workspaceId, since) as Array<{ path: string; change_count: number }>;
    return Promise.resolve(rows);
  }

  // Snapshot the paths active when a memory was written: read the last-30-min
  // activity_logs node_paths and upsert (memory_id, path). Best-effort, idempotent.
  recordMemoryContextPaths(memoryId: string, workspaceId: string): Promise<void> {
    const since = new Date(Date.parse(this.now()) - 30 * 60 * 1000).toISOString();
    const paths = this.db
      .prepare(
        `SELECT DISTINCT node_path AS path FROM activity_logs
         WHERE workspace_id = ? AND created_at >= ? AND node_path IS NOT NULL AND node_path != ''`,
      )
      .all(workspaceId, since) as Array<{ path: string }>;
    if (paths.length === 0) return Promise.resolve();
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO memory_context_paths (memory_id, path) VALUES (?, ?)",
    );
    const tx = this.db.transaction((rows: Array<{ path: string }>) => {
      for (const r of rows) insert.run(memoryId, r.path);
    });
    tx(paths);
    return Promise.resolve();
  }

  // Rank prior solutions: memories whose context paths overlap matchedPaths,
  // newest first, grouping the overlapping paths as related_paths.
  rankPriorSolutions(
    workspaceId: string,
    matchedPaths: string[],
    limit = 5,
  ): Promise<PriorSolution[]> {
    if (!matchedPaths || matchedPaths.length === 0) return Promise.resolve([]);
    const effectiveLimit = limit > 0 ? limit : 5;
    const placeholders = matchedPaths.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT m.id AS memory_id, m.title AS title, m.content AS content, m.created_at AS created_at,
                mcp.path AS path
         FROM memory_context_paths mcp
         JOIN memories m ON m.id = mcp.memory_id
         WHERE m.workspace_id = ? AND m.status = 'active' AND mcp.path IN (${placeholders})
         ORDER BY m.created_at DESC`,
      )
      .all(workspaceId, ...matchedPaths) as Array<{
      memory_id: string;
      title: string;
      content: string;
      created_at: string;
      path: string;
    }>;

    // Group overlapping paths per memory, preserving created_at-DESC memory order.
    const byMemory = new Map<string, PriorSolution>();
    for (const r of rows) {
      let entry = byMemory.get(r.memory_id);
      if (!entry) {
        entry = {
          memory_id: r.memory_id,
          title: r.title,
          preview: (r.content ?? "").slice(0, 200),
          related_paths: [],
          created_at: r.created_at,
        };
        byMemory.set(r.memory_id, entry);
      }
      if (!entry.related_paths.includes(r.path)) entry.related_paths.push(r.path);
    }
    return Promise.resolve([...byMemory.values()].slice(0, effectiveLimit));
  }

  // Co-change derived from activity_logs: paths touched together in one
  // activity. Returns NodeBriefs (match_source "co_change", relevance = min(1, weight/10)).
  findCoupledNodes(
    workspaceId: string,
    seedNodeIds: string[],
    seedPaths: string[],
    _changeLogCount: number,
  ): Promise<NodeBrief[]> {
    void _changeLogCount; // not applicable to the local derivation
    // Resolve seed node ids to their paths and merge with the explicit seed paths.
    const seedSet = new Set(seedPaths.filter(Boolean));
    if (seedNodeIds.length > 0) {
      const placeholders = seedNodeIds.map(() => "?").join(", ");
      const rows = this.db
        .prepare(
          `SELECT relative_path FROM nodes WHERE workspace_id = ? AND id IN (${placeholders})`,
        )
        .all(workspaceId, ...seedNodeIds) as Array<{ relative_path: string }>;
      for (const r of rows) seedSet.add(r.relative_path);
    }
    if (seedSet.size === 0) return Promise.resolve([]);

    const activities = this.db
      .prepare("SELECT node_path, files_touched FROM activity_logs WHERE workspace_id = ?")
      .all(workspaceId) as Array<{ node_path: string | null; files_touched: string | null }>;
    const touched = activities.map((a) => {
      let byArea: Record<string, string[]> | null = null;
      if (a.files_touched) {
        try {
          const parsed = JSON.parse(a.files_touched) as { by_area?: Record<string, string[]> };
          byArea = parsed?.by_area ?? null;
        } catch {
          byArea = null;
        }
      }
      return activityTouchedPaths(byArea, a.node_path);
    });

    const coupled = rankCoupledPaths(touched, [...seedSet]);
    if (coupled.length === 0) return Promise.resolve([]);

    // Resolve coupled paths to nodes for names; unresolved paths use the path basename.
    const nodeByPath = new Map<string, { id: string; name: string }>();
    const placeholders = coupled.map(() => "?").join(", ");
    const nodeRows = this.db
      .prepare(
        `SELECT id, name, relative_path FROM nodes WHERE workspace_id = ? AND relative_path IN (${placeholders})`,
      )
      .all(workspaceId, ...coupled.map((c) => c.path)) as Array<{
      id: string;
      name: string;
      relative_path: string;
    }>;
    for (const n of nodeRows) nodeByPath.set(n.relative_path, { id: n.id, name: n.name });

    const briefs: NodeBrief[] = coupled.map((c) => {
      const node = nodeByPath.get(c.path);
      return {
        node_id: node?.id ?? "",
        path: c.path,
        name: node?.name ?? c.path.split("/").filter(Boolean).pop() ?? c.path,
        memory_titles: [],
        rule_names: [],
        skill_names: [],
        match_source: "co_change" as const,
        relevance: Math.min(1, c.weight / 10),
      };
    });
    return Promise.resolve(briefs);
  }

  // Episodes are clustered on-read locally, so this refresh is a no-op.
  refreshWorkEpisodes(
    _workspaceId: string,
    _since?: string,
  ): Promise<{ ok: boolean; episodes_upserted: number }> {
    void _workspaceId;
    void _since;
    return Promise.resolve({ ok: true, episodes_upserted: 0 });
  }

  // Build EpisodeActivity[] from activity_logs (shared by searchWorkEpisodes + hook index).
  private collectEpisodeActivities(workspaceId: string): EpisodeActivity[] {
    const rows = this.db
      .prepare(
        `SELECT id, created_at, domain, subjects, node_path, files_touched, task_summary
         FROM activity_logs WHERE workspace_id = ?`,
      )
      .all(workspaceId) as Array<{
      id: string;
      created_at: string;
      domain: string | null;
      subjects: string | null;
      node_path: string | null;
      files_touched: string | null;
      task_summary: string | null;
    }>;
    return rows.map((r) => {
      let byArea: Record<string, string[]> | null = null;
      if (r.files_touched) {
        try {
          byArea =
            (JSON.parse(r.files_touched) as { by_area?: Record<string, string[]> })?.by_area ??
            null;
        } catch {
          byArea = null;
        }
      }
      return {
        id: r.id,
        createdAt: r.created_at,
        domain: r.domain,
        subjects: parseJsonArray(r.subjects),
        touchedPaths: activityTouchedPaths(byArea, r.node_path),
        taskSummary: r.task_summary,
      };
    });
  }

  // Deterministic episode clustering over activity_logs, then query search.
  searchWorkEpisodes(
    workspaceId: string,
    query: string,
    _mode: "compact" | "deep",
    limit: number,
  ): Promise<WorkEpisodeBrief[]> {
    void _mode;
    return Promise.resolve(
      searchEpisodes(this.collectEpisodeActivities(workspaceId), query, limit),
    );
  }

  // Assemble the full offline HookIndex from the local store. Curation-only
  // fields (block_pattern/symbols/fail_patterns/promoted_rules_signature/experiments) are
  // omitted; semantic_tags are inferred (no local column). workspace_root left empty for the CLI.
  private collectHookInput(workspaceId: string): HookIndexInput {
    const linksByMemory = new Map<string, string[]>();
    for (const r of this.db
      .prepare(
        `SELECT l.memory_id AS memory_id, l.path AS path
         FROM memory_related_paths l JOIN memories m ON m.id = l.memory_id
         WHERE m.workspace_id = ? AND m.status = 'active'
         ORDER BY l.memory_id, l.path`,
      )
      .all(workspaceId) as Array<{ memory_id: string; path: string }>) {
      const arr = linksByMemory.get(r.memory_id) ?? [];
      arr.push(r.path);
      linksByMemory.set(r.memory_id, arr);
    }
    const memories = (
      this.db
        .prepare(
          `SELECT m.id, m.title, m.content, n.relative_path AS node_path, m.updated_at
           FROM memories m JOIN nodes n ON n.id = m.node_id
           WHERE m.workspace_id = ? AND m.status = 'active'`,
        )
        .all(workspaceId) as Array<{
        id: string;
        title: string;
        content: string;
        node_path: string; updated_at: string | null;
      }>
    ).map((m) => {
      const links = linksByMemory.get(m.id);
      return { ...m, semantic_tags: null, ...(links ? { related_paths: links } : {}) };
    });

    const ruleRows = this.db
      .prepare(
        `SELECT id, name, content, scope_type, priority, constraints
           FROM rules WHERE workspace_id = ? AND status = 'active'`,
      )
      .all(workspaceId) as Array<{
      id: string;
      name: string;
      content: string;
      scope_type: string;
      priority: string;
      constraints: string;
    }>;
    const ruleNodePaths = this.db
      .prepare(
        `SELECT nr.rule_id AS rule_id, n.relative_path AS node_path
         FROM node_rules nr JOIN nodes n ON n.id = nr.node_id
         WHERE n.workspace_id = ?`,
      )
      .all(workspaceId) as Array<{ rule_id: string; node_path: string }>;
    const pathsByRule = new Map<string, string[]>();
    for (const r of ruleNodePaths) {
      const arr = pathsByRule.get(r.rule_id) ?? [];
      arr.push(r.node_path);
      pathsByRule.set(r.rule_id, arr);
    }
    const rules: HookRuleInput[] = ruleRows.map((r) => ({
      ...r,
      node_paths: pathsByRule.get(r.id) ?? [],
      semantic_tags: null,
      // Parsed here rather than passed as raw TEXT: the compiler takes atoms, and a
      // string that happens to look like one is exactly how a deny gate goes wrong.
      constraints: parseRuleAtoms(r.constraints),
    }));

    const skillNodePaths = this.db
      .prepare(
        `SELECT ns.skill_id AS skill_id, n.relative_path AS node_path
         FROM node_skills ns JOIN nodes n ON n.id = ns.node_id
         WHERE n.workspace_id = ?`,
      )
      .all(workspaceId) as Array<{ skill_id: string; node_path: string }>;
    const pathsBySkill = new Map<string, string[]>();
    for (const r of skillNodePaths) {
      const arr = pathsBySkill.get(r.skill_id) ?? [];
      arr.push(r.node_path);
      pathsBySkill.set(r.skill_id, arr);
    }
    const skills = (
      this.db
        .prepare(
          `SELECT id, name, description, content, source, github_url FROM skills WHERE workspace_id = ? AND status = 'active'`,
        )
        .all(workspaceId) as Array<{
        id: string;
        name: string;
        description: string | null;
        content: string;
        source: string;
        github_url: string | null;
      }>
    ).map((s) => ({ ...s, node_paths: pathsBySkill.get(s.id) ?? [], semantic_tags: null }));

    const recentActs = this.db
      .prepare(
        `SELECT subjects, node_path, domain, action, task_summary, created_at
         FROM activity_logs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100`,
      )
      .all(workspaceId) as Array<{
      subjects: string | null;
      node_path: string | null;
      domain: string | null;
      action: string | null;
      task_summary: string | null;
      created_at: string;
    }>;
    const since = new Date(Date.parse(this.now()) - 30 * 60 * 1000).toISOString();
    const recentActivitySubjects = recentActs.map((a) => parseJsonArray(a.subjects));
    const recentActivityDigest = recentActs
      .filter((a) => a.created_at >= since)
      .map((a) => ({
        domain: a.domain,
        action: a.action,
        node_path: a.node_path,
        task_summary: a.task_summary,
      }));

    const workEpisodes = clusterEpisodes(this.collectEpisodeActivities(workspaceId)).filter(
      (e) => e.confidence === "medium" || e.confidence === "high",
    );

    const counts = this.db
      .prepare(
        `SELECT status, COUNT(*) AS c FROM refresh_tasks
         WHERE workspace_id = ? AND status IN ('pending','in_progress') GROUP BY status`,
      )
      .all(workspaceId) as Array<{ status: string; c: number }>;
    const pendingRefreshCount = counts.find((c) => c.status === "pending")?.c ?? 0;
    const inProgressRefreshCount = counts.find((c) => c.status === "in_progress")?.c ?? 0;

    return {
      workspaceId,
      generatedAt: this.now(),
      memories,
      rules,
      skills,
      recentActivitySubjects,
      recentActivityDigest,
      workEpisodes,
      pendingRefreshCount,
      inProgressRefreshCount,
      ...this.advisoryInputSync(workspaceId),
    };
  }

  /**
   * The advisory half of the hook input: deliverable atoms projected for delivery, plus the memory
   * each one was compiled from, which the completeness gate needs to judge it against.
   */
  private advisoryInputSync(workspaceId: string): Required<
    Pick<HookIndexInput, "advisories" | "selections" | "procedures" | "contexts" | "rationales" | "advisorySources">
  > {
    const withheld = this.hookConflictWithheld(workspaceId);
    const sources = this.db
      .prepare(
        `SELECT id, subject_id FROM knowledge_atoms
          WHERE workspace_id = ? AND status = 'active' AND authority IN ${TRUSTED} AND subject_type = 'memory'`,
      )
      .all(workspaceId) as Array<{ id: string; subject_id: string }>;
    return {
      // V33: a conflicting atom with no applicable approved precedence is withheld from the hook, the
      // same safe default the Agent IR compiler applies. contexts/rationales never auto-conflict.
      advisories: this.advisoriesForHookIndex(workspaceId).filter((a) => !withheld.has(a.ref)),
      selections: this.selectionsForHookIndex(workspaceId).filter((a) => !withheld.has(a.ref)),
      procedures: this.proceduresForHookIndex(workspaceId).filter((a) => !withheld.has(a.ref)),
      contexts: this.contextsForHookIndex(workspaceId),
      rationales: this.rationalesForHookIndex(workspaceId),
      advisorySources: Object.fromEntries(sources.map((r) => [r.id, r.subject_id])),
    };
  }

  /**
   * The memories delivered as their compiled form, keyed by memory id: the same plan the hook index,
   * the warehouse and the native knowledge files are built from, for a surface that delivers memory
   * bodies itself (the host's turn context). A memory absent from the result is delivered as written.
   *
   * `memories` is the text that surface is about to deliver. Pass it whenever this store may not hold
   * the current text (a cloud workspace whose atoms live in this local store): the gate must judge the
   * lines against what would otherwise reach the agent, never against an older copy. Without it, the
   * store's own active memories are the source.
   */
  compiledMemoryDeliveries(
    workspaceId: string,
    memories?: ReadonlyArray<{ id: string; content: string }>,
  ): Promise<Record<string, CompiledMemoryDelivery>> {
    const advisory = this.advisoryInputSync(workspaceId);
    const sourceIds = [...new Set(Object.values(advisory.advisorySources))];
    if (sourceIds.length === 0) return Promise.resolve({});
    if (memories) {
      return Promise.resolve(Object.fromEntries(compiledDeliveryPlan({ ...advisory, memories }).compiled));
    }
    const stored = this.db
      .prepare(
        `SELECT m.id, m.title, m.content, n.relative_path AS node_path
           FROM memories m JOIN nodes n ON n.id = m.node_id
          WHERE m.workspace_id = ? AND m.status = 'active' AND m.id IN (${sourceIds.map(() => "?").join(", ")})`,
      )
      .all(workspaceId, ...sourceIds) as HookIndexInput["memories"];
    return Promise.resolve(Object.fromEntries(compiledDeliveryPlan({ ...advisory, memories: stored }).compiled));
  }

  buildHookIndexPayload(workspaceId: string): Promise<HookIndex | null> {
    return Promise.resolve(assembleHookIndex(this.collectHookInput(workspaceId)));
  }

  // The full-body warehouse, assembled from the same SQLite source.
  buildWarehousePayload(workspaceId: string): Promise<Warehouse | null> {
    return Promise.resolve(assembleWarehouse(this.collectHookInput(workspaceId)));
  }

  // The knowledge map input and its cache key (knowledge-map-store.ts).
  async buildKnowledgeMapInput(workspaceId: string): Promise<KnowledgeMapInput | null> {
    return localKnowledgeMapInput(this.db, workspaceId);
  }
  async knowledgeMapFingerprint(workspaceId: string): Promise<string | null> {
    return localKnowledgeMapFingerprint(this.db, workspaceId);
  }

  // Project the on-write embedding store into a memory-id→vector payload of the current space
  // (embeddingSpace), the one the hook index names. No network for memories (embedded at write
  // time); skills are few, so they are embedded on demand. null when no vector is in that space.
  async buildEmbeddingsPayload(workspaceId: string): Promise<EmbeddingsPayload | null> {
    const space = workspaceEmbeddingSpace(this.db, workspaceId, this.embeddingFamily(), this.spaceFromVectors);
    if (!space) return null;
    const payload = memoryVectorsInSpace(this.db, workspaceId, space);
    if (this.semanticEnabled) {
      const skills = this.db
        .prepare(`SELECT id, name, content FROM skills WHERE workspace_id = ? AND status = 'active'`)
        .all(workspaceId) as Array<{ id: string; name: string; content: string }>;
      await addSkillVectors(payload, skills, this.embed, space);
    }
    return Object.keys(payload).length > 0 ? payload : null;
  }

  /** The space key buildEmbeddingsPayload's vectors are in; null when there are none. */
  async embeddingSpace(workspaceId: string): Promise<string | null> {
    return workspaceEmbeddingSpace(this.db, workspaceId, this.embeddingFamily(), this.spaceFromVectors)?.key ?? null;
  }

  /** How many memories have a vector of the current space, another space, or none. No network. */
  async embeddingCoverage(workspaceId: string): Promise<EmbeddingCoverage> {
    return embeddingCoverage(this.db, workspaceId, this.embeddingFamily(), this.spaceFromVectors);
  }

  /** One bounded, resumable re-embedding pass (embedding-store.ts). Only memory vectors change. */
  async reindexEmbeddings(workspaceId: string, options: ReindexOptions = {}): Promise<ReindexProgress> {
    const family = this.embeddingFamily();
    return reindexMemoryEmbeddings({ db: this.db, workspaceId, embed: this.embed, family, fromVectors: this.spaceFromVectors, now: this.now, options });
  }

  // Native Knowledge Compilation: per-directory knowledge sections (same source).
  buildKnowledgePayload(
    workspaceId: string,
    mode?: KnowledgeRenderMode,
  ): Promise<CompiledKnowledgeNode[] | null> {
    return Promise.resolve(assembleKnowledgeNodes(this.collectHookInput(workspaceId), { mode }));
  }

  // Compose the deep briefing from engine outputs + local prior_solutions.
  async assembleBriefing(input: AssembleBriefingInput): Promise<ResearchBriefing> {
    const primaryPaths =
      input.primaryPaths && input.primaryPaths.length > 0
        ? input.primaryPaths
        : input.primaryNodes.map((n) => n.path).filter(Boolean);
    const prior = await this.rankPriorSolutions(input.workspaceId, primaryPaths, 5);
    return assembleBriefingLocal(input, prior);
  }

  // Union: node-owner (node-at-path + ancestors) ∪ context-link memories,
  // node-owner winning duplicates. Local has no per-link confidence column, so context_link
  // confidence is null; owner hits carry 1.0.
  relevantMemoriesForPath(
    workspaceId: string,
    path: string,
    limit = 16,
  ): Promise<RelevantMemoryRow[]> {
    // Ancestor/descendant matching uses a wildcard-free, case-sensitive range
    // (`child > parent||'/'` .. `child < parent||'0'`) instead of LIKE, so `%`/`_`
    // in a stored or queried path are literals and matching is case-sensitive —
    // identical to InMemoryBackend's `startsWith`. (LIKE is case-insensitive in
    // SQLite and would treat those characters as wildcards.)
    const bind = { ws: workspaceId, path };
    const owner = this.db
      .prepare(
        `SELECT m.id AS memory_id, m.node_id AS node_id, m.title AS title
         FROM memories m JOIN nodes n ON n.id = m.node_id
         WHERE m.workspace_id = @ws AND m.status = 'active'
           AND (@path = n.relative_path
             OR (@path > n.relative_path || '/' AND @path < n.relative_path || '0')
             OR @path = '/')`,
      )
      .all(bind) as Array<{ memory_id: string; node_id: string; title: string }>;
    // Declared links first (confidence 1.0, as in the hosted store), then the activity paths
    // recorded at write time (no confidence of their own). The same overlap test for both.
    const linkRows = (table: "memory_related_paths" | "memory_context_paths") =>
      this.db
        .prepare(
          `SELECT m.id AS memory_id, m.node_id AS node_id, m.title AS title, mcp.path AS matched_path
           FROM ${table} mcp JOIN memories m ON m.id = mcp.memory_id
           WHERE m.workspace_id = @ws AND m.status = 'active'
             AND (mcp.path = @path
               OR (@path <> '/' AND @path > mcp.path || '/' AND @path < mcp.path || '0')
               OR (@path <> '/' AND mcp.path > @path || '/' AND mcp.path < @path || '0')
               OR @path = '/')
           ORDER BY mcp.path`,
        )
        .all(bind) as Array<{
        memory_id: string;
        node_id: string;
        title: string;
        matched_path: string;
      }>;
    const links = [
      ...linkRows("memory_related_paths").map((l) => ({ ...l, confidence: 1.0 })),
      ...linkRows("memory_context_paths").map((l) => ({ ...l, confidence: null })),
    ];

    const rows: RelevantMemoryRow[] = [];
    const seen = new Set<string>();
    for (const o of owner) {
      if (seen.has(o.memory_id)) continue;
      seen.add(o.memory_id);
      rows.push({
        memory_id: o.memory_id,
        node_id: o.node_id,
        title: o.title,
        via: "node_owner",
        matched_path: null,
        confidence: 1.0,
      });
    }
    for (const l of links) {
      if (seen.has(l.memory_id)) continue;
      seen.add(l.memory_id);
      rows.push({
        memory_id: l.memory_id,
        node_id: l.node_id,
        title: l.title,
        via: "context_link",
        matched_path: l.matched_path,
        confidence: l.confidence,
      });
    }
    return Promise.resolve(rows.slice(0, limit));
  }

  // ── activity ───────────────────────────────────────────────────────────────────
  logActivity(input: LogActivityInput): Promise<ActivityRecord> {
    return Promise.resolve(insertActivityRow(this.db, input, this.genId(), this.now()));
  }

  // Learning claims and learning activity evidence (learning-store.ts, activity-store.ts).
  putLearningClaim(input: LearningClaim): Promise<LearningClaim> {
    return putLearningClaimRow(this.db, input);
  }

  retiredLearningClaimIds(workspaceId: string, ids: string[]): Promise<string[]> {
    return retiredLearningClaimRows(this.db, workspaceId, ids);
  }

  reviseLearningClaim(raw: LearningClaimRevision): Promise<{ status: "applied"; id: string }> {
    return reviseLearningClaimRow(this.db, raw);
  }

  listLearningClaims(workspaceId: string, limit = 100): Promise<LearningClaim[]> {
    return listLearningClaimRows(this.db, workspaceId, limit);
  }

  learningActivities(workspaceId: string, limit = 200): Promise<ActivityLeadSource[]> {
    return Promise.resolve(learningActivityRows(this.db, workspaceId, limit));
  }

  // Runtime events an application sent to Pathrule Local (runtime-events-store.ts).
  ingestRuntimeEvents(
    workspaceId: string,
    envelope: unknown,
    options: { bytes?: number } = {},
  ): Promise<RuntimeIngestResult> {
    return Promise.resolve(
      ingestRuntimeEventRows(this.db, workspaceId, envelope, {
        bytes: options.bytes,
        now: this.now(),
        genId: this.genId,
      }),
    );
  }

  listRuntimeEventGroups(
    workspaceId: string,
    query: RuntimeEventsQuery = {},
  ): Promise<RuntimeEventsPage | { error: string }> {
    return Promise.resolve(listRuntimeEventRows(this.db, workspaceId, query, this.now()));
  }

  runtimeEventIndicator(workspaceId: string, path?: string): Promise<RuntimeEventIndicator | null> {
    return Promise.resolve(runtimeEventIndicatorRow(this.db, workspaceId, path, this.now()));
  }

  runtimeEventStatus(workspaceId: string): Promise<RuntimeEventsStatus> {
    return Promise.resolve(runtimeEventStatusRow(this.db, workspaceId, this.now()));
  }

  runtimeIndicatorSnapshot(workspaceId: string): Promise<RuntimeIndicatorSnapshot> {
    return Promise.resolve(runtimeIndicatorSnapshotRow(this.db, workspaceId, this.now()));
  }

  recordRuntimeCorrection(
    workspaceId: string,
    input: RuntimeCorrectionInput,
  ): Promise<RuntimeCorrectionResult> {
    return Promise.resolve(
      recordRuntimeCorrectionRow(this.db, workspaceId, input, { now: this.now(), genId: this.genId }),
    );
  }

  pruneRuntimeEvents(workspaceId: string): Promise<{ deleted: number }> {
    return Promise.resolve(pruneRuntimeEventRows(this.db, workspaceId, this.now()));
  }

  recentActivities(
    scope: ContextScope,
    limit: number,
    options: RecentActivitiesOptions = {},
  ): Promise<Activity[]> {
    return Promise.resolve(recentActivityRows(this.db, scope.workspaceId, limit, options.since));
  }

  // The router/briefing recent-activity shape (snake_case + node_path + files_touched).
  // Single principal, so the `userId` filter is ignored. files_touched is stored as a
  // JSON string locally; parse it back to its object shape so downstream consumers
  // behave identically across editions.
  recentActivitiesForRouter(
    workspaceId: string,
    limit: number,
    _userId?: string | null,
  ): Promise<RecentActivityForRouter[]> {
    // Contract: this method NEVER throws — the router/briefing degrades to [] on any
    // backend hiccup. A corrupt/locked store must not fail get_context closed.
    // `rowid DESC` ties to insertion order (see recentActivities) for
    // cross-backend determinism.
    try {
      const rows = this.db
        .prepare(
          "SELECT domain, action, task_summary, created_at, node_path, files_touched FROM activity_logs WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
        )
        .all(workspaceId, limit) as Array<Record<string, unknown>>;
      return Promise.resolve(
        rows.map((r) => ({
          domain: (r["domain"] as string | null) ?? "",
          action: (r["action"] as string | null) ?? "",
          task_summary: (r["task_summary"] as string | null) ?? "",
          created_at: r["created_at"] as string,
          node_path: (r["node_path"] as string | null) ?? undefined,
          files_touched: parseFilesTouchedJson(r["files_touched"]),
        })),
      );
    } catch {
      return Promise.resolve([]);
    }
  }

  // ── refresh queue ────────────────────────────────────────────────────────────────
  private rowToRefreshEntry(r: Record<string, unknown>): LocalRefreshEntry {
    return {
      id: r["id"] as string,
      workspaceId: r["workspace_id"] as string,
      subjectType: r["subject_type"] as "memory" | "rule",
      subjectId: r["subject_id"] as string,
      kind: (r["kind"] as string | null) ?? "drift",
      reason: (r["reason"] as string | null) ?? "",
      status: r["status"] as RefreshStatus,
      claimedByAi: (r["claimed_by_ai"] as string | null) ?? null,
      claimedAt: (r["claimed_at"] as string | null) ?? null,
      resolvedAt: (r["resolved_at"] as string | null) ?? null,
      resolvedNote: (r["resolved_note"] as string | null) ?? null,
      createdAt: r["created_at"] as string,
      updatedAt: (r["updated_at"] as string | null) ?? (r["created_at"] as string),
    };
  }

  /** Resolve the subject's current title/body/node path so the brief is always fresh. */
  private subjectSnapshot(
    subjectType: "memory" | "rule",
    subjectId: string,
  ): RefreshSubjectSnapshot {
    if (subjectType === "memory") {
      const m = this.db
        .prepare("SELECT title, content, node_id FROM memories WHERE id = ?")
        .get(subjectId) as { title?: string; content?: string; node_id?: string } | undefined;
      const nodePath = m?.node_id
        ? ((
            this.db.prepare("SELECT relative_path FROM nodes WHERE id = ?").get(m.node_id) as
              | { relative_path?: string }
              | undefined
          )?.relative_path ?? "/")
        : "/";
      return { title: m?.title ?? "(unknown)", body: m?.content ?? "", nodePath };
    }
    const r = this.db.prepare("SELECT name, content FROM rules WHERE id = ?").get(subjectId) as
      | { name?: string; content?: string }
      | undefined;
    const nodePath =
      (
        this.db
          .prepare(
            `SELECT n.relative_path AS relative_path FROM node_rules nr
             JOIN nodes n ON n.id = nr.node_id WHERE nr.rule_id = ? LIMIT 1`,
          )
          .get(subjectId) as { relative_path?: string } | undefined
      )?.relative_path ?? "/";
    return { title: r?.name ?? "(unknown)", body: r?.content ?? "", nodePath };
  }

  // ── typed knowledge atoms (docs/architecture/decisions/0001-remedy-atom-persistence.md) ──

  /** Reconstruct an atom from its row (`atom-rows.ts`: the columns are authoritative for lifecycle). */
  private rowToRemedyAtom(row: Record<string, unknown>): RemedyAtom | null { return rowToAtom(row, parseRemedyAtom, ADVISORY_TRUSTED); }

  /** Store an agent-captured, machine-grounded atom (`grounded-store.ts`). An earlier decision always wins. */
  recordGroundedAtom(workspaceId: string, atom: CapturedAtom): Promise<GroundedStoreResult> {
    return Promise.resolve(storeGroundedAtom(this.db, workspaceId, atom, this.now()));
  }

  proposeRemedyAtom(workspaceId: string, atom: RemedyAtom): Promise<RemedyAtom> {
    const existing = this.db
      .prepare("SELECT * FROM knowledge_atoms WHERE workspace_id = ? AND fingerprint = ?")
      .get(workspaceId, atom.fingerprint) as Record<string, unknown> | undefined;
    // Idempotent, and deliberately so: the same evidence is the same atom, and an atom the user
    // already decided on must not be reset to pending by another analysis run.
    if (existing) {
      const back = this.rowToRemedyAtom(existing);
      if (back) return Promise.resolve(back);
    }
    const ts = this.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO knowledge_atoms
           (id, workspace_id, kind, subject_type, subject_id, node_path, authority, status,
            approved_by, fingerprint, payload, observed_at, created_at, updated_at)
         VALUES (?, ?, 'remedy', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        atom.id, workspaceId, atom.source.kind, atom.source.id, atom.source.node_path,
        atom.authority, atom.status, atom.approved_by, atom.fingerprint,
        JSON.stringify(atom), atom.observed_at, atom.created_at || ts, ts,
      );
    return Promise.resolve(atom);
  }

  listProposedRemedyAtoms(workspaceId: string): Promise<RemedyAtom[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_atoms
          WHERE workspace_id = ? AND kind = 'remedy' AND status = 'proposed'
          ORDER BY created_at ASC`,
      )
      .all(workspaceId) as Array<Record<string, unknown>>;
    return Promise.resolve(
      rows.map((r) => this.rowToRemedyAtom(r)).filter((a): a is RemedyAtom => a !== null),
    );
  }

  /**
   * The DELIVERY read path: approved, active remedies. `listProposedRemedyAtoms` served review;
   * this serves the agent. Lifecycle is still enforced downstream by `isRemedyDeliverable` (which
   * also checks the evidence state), but filtering to active+human here keeps the query cheap and
   * the intent explicit. Uses the existing `idx_atoms_pending(workspace_id, kind, status)` index.
   */
  listActiveRemedyAtoms(workspaceId: string): Promise<RemedyAtom[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_atoms
          WHERE workspace_id = ? AND kind = 'remedy' AND status = 'active' AND authority IN ${TRUSTED}
          ORDER BY observed_at DESC, id ASC`,
      )
      .all(workspaceId) as Array<Record<string, unknown>>;
    return Promise.resolve(
      rows.map((r) => this.rowToRemedyAtom(r)).filter((a): a is RemedyAtom => a !== null),
    );
  }

  /**
   * Resolve a remedy's delivery SCOPE from its source, so an approved remedy learned under one path
   * is not delivered everywhere. For a memory-sourced remedy the scope is the source memory's node
   * `relative_path` (resolved fresh, so re-parenting the memory moves its remedy). A memory with no
   * node, or a source that no longer exists, resolves to null = workspace-global, which is correct:
   * an unplaced memory is workspace-wide knowledge. This resolves at DELIVERY time and touches no
   * frozen capture code.
   */
  private resolveRemedyScope(atom: RemedyAtom): string | null {
    if (atom.source.node_path && atom.source.node_path.trim()) return atom.source.node_path;
    if (atom.source.kind !== "memory") return null;
    const row = this.db
      .prepare(
        `SELECT n.relative_path AS p
           FROM memories m JOIN nodes n ON n.id = m.node_id
          WHERE m.id = ? AND n.relative_path <> ''`,
      )
      .get(atom.source.id) as { p?: string } | undefined;
    return row?.p ? row.p : null;
  }

  /** Sync core: deliverable active remedies, resolved scope, sorted strongest+most-recent first. */
  private activeScopedRemediesSync(workspaceId: string): Array<{ atom: RemedyAtom; scope: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_atoms
          WHERE workspace_id = ? AND kind = 'remedy' AND status = 'active' AND authority IN ${TRUSTED}`,
      )
      .all(workspaceId) as Array<Record<string, unknown>>;
    const rank: Record<string, number> = { HUMAN_AUTHORED: 3, REPEATED_SUCCESS: 2, OBSERVED_SUCCESS: 1 };
    return rows
      .map((r) => this.rowToRemedyAtom(r))
      .filter((a): a is RemedyAtom => a !== null && isRemedyDeliverable(a) && groundedNow(this.db, a))
      .sort((a, b) =>
        (rank[b.evidence_state] ?? 0) - (rank[a.evidence_state] ?? 0) ||
        String(b.observed_at).localeCompare(String(a.observed_at)) ||
        a.id.localeCompare(b.id))
      .map((atom) => ({ atom, scope: this.resolveRemedyScope(atom) }));
  }

  /** Active remedies paired with their resolved delivery scope. The input to Agent IR compilation. */
  listActiveScopedRemedies(workspaceId: string): Promise<Array<{ atom: RemedyAtom; scope: string | null }>> {
    return Promise.resolve(this.activeScopedRemediesSync(workspaceId));
  }

  /** Deliverable active remedies PROJECTED into advisories, for the hook index. Sync, no model. */
  advisoriesForHookIndex(workspaceId: string): RemedyAdvisory[] {
    return this.activeScopedRemediesSync(workspaceId).map(({ atom, scope }) => projectRemedyToAdvisory(atom, scope));
  }

  // ── SELECTION + PROCEDURE atoms (V31): same generic knowledge_atoms table, kind-discriminated ──

  /**
   * Generic delivery-scope resolution shared by every atom kind: the source's explicit node_path, else
   * a memory source's node relative_path (resolved fresh), else null (workspace-global). Mirrors
   * `resolveRemedyScope` without touching it, so the frozen remedy path is unchanged.
   */
  private resolveSourceScope(source: { kind: "memory" | "rule"; id: string; node_path: string | null }): string | null {
    if (source.node_path && source.node_path.trim()) return source.node_path;
    if (source.kind !== "memory") return null;
    const row = this.db
      .prepare(`SELECT n.relative_path AS p FROM memories m JOIN nodes n ON n.id = m.node_id WHERE m.id = ? AND n.relative_path <> ''`)
      .get(source.id) as { p?: string } | undefined;
    return row?.p ? row.p : null;
  }

  /** Insert a proposed atom of any kind into knowledge_atoms. Idempotent by fingerprint, like remedy. */
  private proposeTypedAtom(workspaceId: string, kind: string, atom: { id: string; fingerprint: string; source: { kind: string; id: string; node_path: string | null }; authority: string; status: string; approved_by: string | null; observed_at: string; created_at: string }): void {
    const ts = this.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO knowledge_atoms
           (id, workspace_id, kind, subject_type, subject_id, node_path, authority, status, approved_by, fingerprint, payload, observed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(atom.id, workspaceId, kind, atom.source.kind, atom.source.id, atom.source.node_path, atom.authority, atom.status, atom.approved_by, atom.fingerprint, JSON.stringify(atom), atom.observed_at, atom.created_at || ts, ts);
  }

  private rowToSelectionAtom(row: Record<string, unknown>): SelectionAtom | null { return rowToAtom(row, parseSelectionAtom, ADVISORY_TRUSTED); }

  private rowToProcedureAtom(row: Record<string, unknown>): ProcedureAtom | null { return rowToAtom(row, parseProcedureAtom, ADVISORY_TRUSTED); }

  proposeSelectionAtom(workspaceId: string, atom: SelectionAtom): Promise<SelectionAtom> {
    const existing = this.db.prepare("SELECT * FROM knowledge_atoms WHERE workspace_id = ? AND fingerprint = ?").get(workspaceId, atom.fingerprint) as Record<string, unknown> | undefined;
    if (existing) { const back = this.rowToSelectionAtom(existing); if (back) return Promise.resolve(back); }
    this.proposeTypedAtom(workspaceId, "selection", atom);
    return Promise.resolve(atom);
  }

  proposeProcedureAtom(workspaceId: string, atom: ProcedureAtom): Promise<ProcedureAtom> {
    const existing = this.db.prepare("SELECT * FROM knowledge_atoms WHERE workspace_id = ? AND fingerprint = ?").get(workspaceId, atom.fingerprint) as Record<string, unknown> | undefined;
    if (existing) { const back = this.rowToProcedureAtom(existing); if (back) return Promise.resolve(back); }
    this.proposeTypedAtom(workspaceId, "procedure", atom);
    return Promise.resolve(atom);
  }

  listProposedSelectionAtoms(workspaceId: string): Promise<SelectionAtom[]> {
    const rows = this.db.prepare("SELECT * FROM knowledge_atoms WHERE workspace_id = ? AND kind = 'selection' AND status = 'proposed' ORDER BY created_at ASC").all(workspaceId) as Array<Record<string, unknown>>;
    return Promise.resolve(rows.map((r) => this.rowToSelectionAtom(r)).filter((a): a is SelectionAtom => a !== null));
  }

  listProposedProcedureAtoms(workspaceId: string): Promise<ProcedureAtom[]> {
    const rows = this.db.prepare("SELECT * FROM knowledge_atoms WHERE workspace_id = ? AND kind = 'procedure' AND status = 'proposed' ORDER BY created_at ASC").all(workspaceId) as Array<Record<string, unknown>>;
    return Promise.resolve(rows.map((r) => this.rowToProcedureAtom(r)).filter((a): a is ProcedureAtom => a !== null));
  }

  decideSelectionAtom(workspaceId: string, atomId: string, decision: "approve" | "reject", decidedBy: string): Promise<SelectionAtom | null> {
    const row = this.db.prepare("SELECT * FROM knowledge_atoms WHERE workspace_id = ? AND id = ? AND kind = 'selection'").get(workspaceId, atomId) as Record<string, unknown> | undefined;
    const current = row ? this.rowToSelectionAtom(row) : null;
    if (!current) return Promise.resolve(null);
    const next = decision === "approve" ? approveSelection(current, decidedBy) : rejectSelection(current, decidedBy);
    this.db.prepare("UPDATE knowledge_atoms SET authority = ?, status = ?, approved_by = ?, payload = ?, updated_at = ? WHERE workspace_id = ? AND id = ?").run(next.authority, next.status, next.approved_by, JSON.stringify(next), this.now(), workspaceId, atomId);
    return Promise.resolve(next);
  }

  decideProcedureAtom(workspaceId: string, atomId: string, decision: "approve" | "reject", decidedBy: string): Promise<ProcedureAtom | null> {
    const row = this.db.prepare("SELECT * FROM knowledge_atoms WHERE workspace_id = ? AND id = ? AND kind = 'procedure'").get(workspaceId, atomId) as Record<string, unknown> | undefined;
    const current = row ? this.rowToProcedureAtom(row) : null;
    if (!current) return Promise.resolve(null);
    const next = decision === "approve" ? approveProcedure(current, decidedBy) : rejectProcedure(current, decidedBy);
    this.db.prepare("UPDATE knowledge_atoms SET authority = ?, status = ?, approved_by = ?, payload = ?, updated_at = ? WHERE workspace_id = ? AND id = ?").run(next.authority, next.status, next.approved_by, JSON.stringify(next), this.now(), workspaceId, atomId);
    return Promise.resolve(next);
  }

  private activeScopedSelectionsSync(workspaceId: string): Array<{ atom: SelectionAtom; scope: string | null }> {
    const rows = this.db.prepare(`SELECT * FROM knowledge_atoms WHERE workspace_id = ? AND kind = 'selection' AND status = 'active' AND authority IN ${TRUSTED}`).all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToSelectionAtom(r)).filter((a): a is SelectionAtom => a !== null && isSelectionDeliverable(a) && groundedNow(this.db, a)).map((atom) => ({ atom, scope: this.resolveSourceScope(atom.source) }));
  }

  private activeScopedProceduresSync(workspaceId: string): Array<{ atom: ProcedureAtom; scope: string | null }> {
    const rows = this.db.prepare(`SELECT * FROM knowledge_atoms WHERE workspace_id = ? AND kind = 'procedure' AND status = 'active' AND authority IN ${TRUSTED}`).all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToProcedureAtom(r)).filter((a): a is ProcedureAtom => a !== null && isProcedureDeliverable(a) && groundedNow(this.db, a)).map((atom) => ({ atom, scope: this.resolveSourceScope(atom.source) }));
  }

  listActiveScopedSelections(workspaceId: string): Promise<Array<{ atom: SelectionAtom; scope: string | null }>> {
    return Promise.resolve(this.activeScopedSelectionsSync(workspaceId));
  }

  listActiveScopedProcedures(workspaceId: string): Promise<Array<{ atom: ProcedureAtom; scope: string | null }>> {
    return Promise.resolve(this.activeScopedProceduresSync(workspaceId));
  }

  /** Deliverable active selections/procedures projected into advisories, for the hook index. No model. */
  selectionsForHookIndex(workspaceId: string): SelectionAdvisory[] {
    return this.activeScopedSelectionsSync(workspaceId).map(({ atom, scope }) => projectSelectionToAdvisory(atom, scope));
  }

  proceduresForHookIndex(workspaceId: string): ProcedureAdvisory[] {
    return this.activeScopedProceduresSync(workspaceId).map(({ atom, scope }) => projectProcedureToAdvisory(atom, scope));
  }

  // ── CONTEXT + RATIONALE atoms (V32): same generic knowledge_atoms table, kind-discriminated ──

  private rowToContextAtom(row: Record<string, unknown>): ContextAtom | null { return rowToAtom(row, parseContextAtom, ADVISORY_TRUSTED); }

  private rowToRationaleAtom(row: Record<string, unknown>): RationaleAtom | null { return rowToAtom(row, parseRationaleAtom, ADVISORY_TRUSTED); }

  proposeContextAtom(workspaceId: string, atom: ContextAtom): Promise<ContextAtom> {
    const existing = this.db.prepare("SELECT * FROM knowledge_atoms WHERE workspace_id = ? AND fingerprint = ?").get(workspaceId, atom.fingerprint) as Record<string, unknown> | undefined;
    if (existing) { const back = this.rowToContextAtom(existing); if (back) return Promise.resolve(back); }
    this.proposeTypedAtom(workspaceId, "context", atom);
    return Promise.resolve(atom);
  }

  proposeRationaleAtom(workspaceId: string, atom: RationaleAtom): Promise<RationaleAtom> {
    const existing = this.db.prepare("SELECT * FROM knowledge_atoms WHERE workspace_id = ? AND fingerprint = ?").get(workspaceId, atom.fingerprint) as Record<string, unknown> | undefined;
    if (existing) { const back = this.rowToRationaleAtom(existing); if (back) return Promise.resolve(back); }
    this.proposeTypedAtom(workspaceId, "rationale", atom);
    return Promise.resolve(atom);
  }

  listProposedContextAtoms(workspaceId: string): Promise<ContextAtom[]> {
    const rows = this.db.prepare("SELECT * FROM knowledge_atoms WHERE workspace_id = ? AND kind = 'context' AND status = 'proposed' ORDER BY created_at ASC").all(workspaceId) as Array<Record<string, unknown>>;
    return Promise.resolve(rows.map((r) => this.rowToContextAtom(r)).filter((a): a is ContextAtom => a !== null));
  }

  listProposedRationaleAtoms(workspaceId: string): Promise<RationaleAtom[]> {
    const rows = this.db.prepare("SELECT * FROM knowledge_atoms WHERE workspace_id = ? AND kind = 'rationale' AND status = 'proposed' ORDER BY created_at ASC").all(workspaceId) as Array<Record<string, unknown>>;
    return Promise.resolve(rows.map((r) => this.rowToRationaleAtom(r)).filter((a): a is RationaleAtom => a !== null));
  }

  decideContextAtom(workspaceId: string, atomId: string, decision: "approve" | "reject", decidedBy: string): Promise<ContextAtom | null> {
    const row = this.db.prepare("SELECT * FROM knowledge_atoms WHERE workspace_id = ? AND id = ? AND kind = 'context'").get(workspaceId, atomId) as Record<string, unknown> | undefined;
    const current = row ? this.rowToContextAtom(row) : null;
    if (!current) return Promise.resolve(null);
    const next = decision === "approve" ? approveContext(current, decidedBy) : rejectContext(current, decidedBy);
    this.db.prepare("UPDATE knowledge_atoms SET authority = ?, status = ?, approved_by = ?, payload = ?, updated_at = ? WHERE workspace_id = ? AND id = ?").run(next.authority, next.status, next.approved_by, JSON.stringify(next), this.now(), workspaceId, atomId);
    return Promise.resolve(next);
  }

  decideRationaleAtom(workspaceId: string, atomId: string, decision: "approve" | "reject", decidedBy: string): Promise<RationaleAtom | null> {
    const row = this.db.prepare("SELECT * FROM knowledge_atoms WHERE workspace_id = ? AND id = ? AND kind = 'rationale'").get(workspaceId, atomId) as Record<string, unknown> | undefined;
    const current = row ? this.rowToRationaleAtom(row) : null;
    if (!current) return Promise.resolve(null);
    const next = decision === "approve" ? approveRationale(current, decidedBy) : rejectRationale(current, decidedBy);
    this.db.prepare("UPDATE knowledge_atoms SET authority = ?, status = ?, approved_by = ?, payload = ?, updated_at = ? WHERE workspace_id = ? AND id = ?").run(next.authority, next.status, next.approved_by, JSON.stringify(next), this.now(), workspaceId, atomId);
    return Promise.resolve(next);
  }

  private activeScopedContextsSync(workspaceId: string): Array<{ atom: ContextAtom; scope: string | null }> {
    const rows = this.db.prepare(`SELECT * FROM knowledge_atoms WHERE workspace_id = ? AND kind = 'context' AND status = 'active' AND authority IN ${TRUSTED}`).all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToContextAtom(r)).filter((a): a is ContextAtom => a !== null && isContextDeliverable(a) && groundedNow(this.db, a)).map((atom) => ({ atom, scope: this.resolveSourceScope(atom.source) }));
  }

  private activeScopedRationalesSync(workspaceId: string): Array<{ atom: RationaleAtom; scope: string | null }> {
    const rows = this.db.prepare(`SELECT * FROM knowledge_atoms WHERE workspace_id = ? AND kind = 'rationale' AND status = 'active' AND authority IN ${TRUSTED}`).all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToRationaleAtom(r)).filter((a): a is RationaleAtom => a !== null && isRationaleDeliverable(a) && groundedNow(this.db, a)).map((atom) => ({ atom, scope: this.resolveSourceScope(atom.source) }));
  }

  listActiveScopedContexts(workspaceId: string): Promise<Array<{ atom: ContextAtom; scope: string | null }>> {
    return Promise.resolve(this.activeScopedContextsSync(workspaceId));
  }
  listActiveScopedRationales(workspaceId: string): Promise<Array<{ atom: RationaleAtom; scope: string | null }>> {
    return Promise.resolve(this.activeScopedRationalesSync(workspaceId));
  }

  contextsForHookIndex(workspaceId: string): ContextAdvisory[] {
    return this.activeScopedContextsSync(workspaceId).map(({ atom, scope }) => projectContextToAdvisory(atom, scope));
  }
  rationalesForHookIndex(workspaceId: string): RationaleAdvisory[] {
    return this.activeScopedRationalesSync(workspaceId).map(({ atom, scope }) => projectRationaleToAdvisory(atom, scope));
  }

  // ── PRECEDENCE atoms (V33): generic knowledge_atoms table + deterministic conflict resolution ──

  private rowToPrecedenceAtom(row: Record<string, unknown>): PrecedenceAtom | null { return rowToAtom(row, parsePrecedenceAtom, HUMAN_ONLY); }

  proposePrecedenceAtom(workspaceId: string, atom: PrecedenceAtom): Promise<PrecedenceAtom> {
    const existing = this.db.prepare("SELECT * FROM knowledge_atoms WHERE workspace_id = ? AND fingerprint = ?").get(workspaceId, atom.fingerprint) as Record<string, unknown> | undefined;
    if (existing) { const back = this.rowToPrecedenceAtom(existing); if (back) return Promise.resolve(back); }
    this.proposeTypedAtom(workspaceId, "precedence", atom);
    return Promise.resolve(atom);
  }

  listProposedPrecedenceAtoms(workspaceId: string): Promise<PrecedenceAtom[]> {
    const rows = this.db.prepare("SELECT * FROM knowledge_atoms WHERE workspace_id = ? AND kind = 'precedence' AND status = 'proposed' ORDER BY created_at ASC").all(workspaceId) as Array<Record<string, unknown>>;
    return Promise.resolve(rows.map((r) => this.rowToPrecedenceAtom(r)).filter((a): a is PrecedenceAtom => a !== null));
  }

  decidePrecedenceAtom(workspaceId: string, atomId: string, decision: "approve" | "reject", decidedBy: string): Promise<PrecedenceAtom | null> {
    const row = this.db.prepare("SELECT * FROM knowledge_atoms WHERE workspace_id = ? AND id = ? AND kind = 'precedence'").get(workspaceId, atomId) as Record<string, unknown> | undefined;
    const current = row ? this.rowToPrecedenceAtom(row) : null;
    if (!current) return Promise.resolve(null);
    const next = decision === "approve" ? approvePrecedence(current, decidedBy) : rejectPrecedence(current, decidedBy);
    this.db.prepare("UPDATE knowledge_atoms SET authority = ?, status = ?, approved_by = ?, payload = ?, updated_at = ? WHERE workspace_id = ? AND id = ?").run(next.authority, next.status, next.approved_by, JSON.stringify(next), this.now(), workspaceId, atomId);
    return Promise.resolve(next);
  }

  private activeScopedPrecedencesSync(workspaceId: string): Array<{ atom: PrecedenceAtom; scope: string | null }> {
    const rows = this.db.prepare("SELECT * FROM knowledge_atoms WHERE workspace_id = ? AND kind = 'precedence' AND status = 'active' AND authority = 'human'").all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToPrecedenceAtom(r)).filter((a): a is PrecedenceAtom => a !== null && isPrecedenceActive(a)).map((atom) => ({ atom, scope: this.resolveSourceScope(atom.source) }));
  }

  listActiveScopedPrecedences(workspaceId: string): Promise<Array<{ atom: PrecedenceAtom; scope: string | null }>> {
    return Promise.resolve(this.activeScopedPrecedencesSync(workspaceId));
  }

  /**
   * V33 hook-path conflict pre-resolution. The standalone hook injects pre-rendered stubs and cannot
   * run the TS conflict compiler, so this resolves conflicts at index-build time and returns the atom
   * ids to WITHHOLD. Each conflict group is resolved at its members' own scope using the approved
   * precedence edges, exactly like the Agent IR compiler; an unresolved/ambiguous/cyclic conflict
   * withholds every side (the safe default). No model call.
   */
  private hookConflictWithheld(workspaceId: string): Set<string> {
    const edges: PrecedenceEdge[] = this.activeScopedPrecedencesSync(workspaceId).map(({ atom, scope }) => ({ ref: atom.id, winner: atom.winner_evidence.join(" ") || atom.winner_normalized || "", loser: atom.loser_evidence.join(" ") || atom.loser_normalized || "", scope: normalizeScope(scope) }));
    const cand: ConflictCandidate[] = [
      ...this.activeScopedRemediesSync(workspaceId).map(({ atom, scope }) => ({ id: atom.id, kind: "remedy" as const, conflictKey: atom.condition_evidence.join(" ") || atom.condition_normalized || "", literal: atom.action_evidence.join(" "), scope: normalizeScope(scope) })),
      ...this.activeScopedSelectionsSync(workspaceId).map(({ atom, scope }) => ({ id: atom.id, kind: "selection" as const, conflictKey: atom.context_evidence.join(" ") || atom.context_normalized || "", literal: atom.preferred_evidence.join(" "), scope: normalizeScope(scope) })),
      ...this.activeScopedProceduresSync(workspaceId).map(({ atom, scope }) => ({ id: atom.id, kind: "procedure" as const, conflictKey: atom.operation_evidence.join(" ") || atom.operation_normalized || "", literal: atom.steps.join(" > "), scope: normalizeScope(scope) })),
    ];
    const withheld = new Set<string>();
    // Resolve each distinct candidate scope at that scope, so a scoped precedence applies correctly.
    const scopes = new Set(cand.map((c) => c.scope));
    for (const s of scopes) {
      const inScope = cand.filter((c) => c.scope === s);
      for (const id of resolveConflicts(inScope, edges, s).withhold) withheld.add(id);
    }
    return withheld;
  }

  /** The set of atom ids the hook should NOT inject because an unresolved conflict (or a lost side) withholds them. */
  conflictWithheldForHookIndex(workspaceId: string): Set<string> {
    return this.hookConflictWithheld(workspaceId);
  }

  /**
   * Record that a remedy reached an agent execution. Metadata only (the atom id is a hash), local
   * only. `delivered` is the only event today; `used`/`succeeded`/`failed` are the future seam and
   * are deliberately NOT written here, because delivery is not success.
   */
  recordRemedyDelivery(input: {
    workspaceId: string; atomId: string; sessionId?: string | null; path?: string | null; event?: string;
  }): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO remedy_deliveries (workspace_id, atom_id, session_id, path, event, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.workspaceId, input.atomId, input.sessionId ?? null, input.path ?? null, input.event ?? "delivered", this.now());
    return Promise.resolve();
  }

  /** Local delivery ledger for observation and tests. Answers "was this atom delivered, when, where". */
  listRemedyDeliveries(workspaceId: string): Promise<Array<{ atom_id: string; session_id: string | null; path: string | null; event: string; created_at: string }>> {
    const rows = this.db
      .prepare(
        `SELECT atom_id, session_id, path, event, created_at FROM remedy_deliveries
          WHERE workspace_id = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(workspaceId) as Array<{ atom_id: string; session_id: string | null; path: string | null; event: string; created_at: string }>;
    return Promise.resolve(rows);
  }

  // ── outcome observation (V30, docs/architecture/decisions/0003) ──

  /**
   * Append one categorical evidence row. Append-only and idempotent: an identical observation
   * (same session, atom, event_type, evidence_kind, path) is not re-inserted, so repeated hooks for
   * the same event do not inflate the history, while genuinely new observations always append.
   */
  recordKnowledgeEvidence(input: {
    workspaceId: string; atomId: string; deliveryId?: string | null; sessionId?: string | null;
    path?: string | null; eventType: string; evidenceKind?: string | null; strength?: string | null;
    reason?: string | null; signature?: string | null;
  }): Promise<void> {
    const dup = this.db
      .prepare(
        `SELECT 1 FROM knowledge_evidence
          WHERE workspace_id = ? AND atom_id = ? AND IFNULL(session_id,'') = IFNULL(?,'')
            AND event_type = ? AND IFNULL(evidence_kind,'') = IFNULL(?,'') AND IFNULL(path,'') = IFNULL(?,'')
            AND IFNULL(signature,'') = IFNULL(?,'') LIMIT 1`,
      )
      .get(input.workspaceId, input.atomId, input.sessionId ?? null, input.eventType, input.evidenceKind ?? null, input.path ?? null, input.signature ?? null);
    if (dup) return Promise.resolve();
    this.db
      .prepare(
        `INSERT INTO knowledge_evidence
           (workspace_id, atom_id, delivery_id, session_id, path, event_type, evidence_kind, strength, reason, signature, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.workspaceId, input.atomId, input.deliveryId ?? null, input.sessionId ?? null, input.path ?? null, input.eventType, input.evidenceKind ?? null, input.strength ?? null, input.reason ?? null, input.signature ?? null, this.now());
    return Promise.resolve();
  }

  /**
   * Observe ONE agent tool event against the atoms delivered to this session, and record only the
   * decision. `outcomeObserver()` makes every decision (the engine's, else the open one); this feeds it
   * (delivered atoms with resolved scope + verbatim action evidence) and persists the categorical
   * result. It NEVER stores the event content.
   *
   * `checkTransition` is supplied by the caller ONLY when a deterministic CHECK for this scope moved
   * fail -> pass around the event; otherwise the outcome for a code change stays UNKNOWN.
   */
  async observeToolEvent(
    workspaceId: string, sessionId: string, deliveredAtomIds: string[], event: ObservedEvent,
    checkTransition?: { was_failing: boolean; now_passing: boolean } | null,
  ): Promise<UsageAttribution[]> {
    const observer = outcomeObserver();
    const advisories: DeliveredAdvisory[] = [];
    for (const atomId of new Set(deliveredAtomIds)) {
      const row = this.db.prepare("SELECT * FROM knowledge_atoms WHERE workspace_id = ? AND id = ?").get(workspaceId, atomId) as Record<string, unknown> | undefined;
      if (!row) continue;
      // Generic over atom kind (V31): the evidence table is keyed by opaque atom_id, so the same
      // deterministic engine observes any advisory once it is reduced to (scope, action_literals).
      //  - REMEDY: its corrective action literals (unchanged from V30).
      //  - SELECTION: its preferred choice literal; the agent inserting the preferred option in scope
      //    is conservative usage evidence, exactly like a remedy action.
      //  - PROCEDURE: deliberately NOT usage-attributed in V1. A single tool event cannot show an
      //    ordered multi-step workflow was followed, so procedure usage stays UNKNOWN (the honest
      //    answer) rather than being over-claimed from one step insertion.
      if (row["kind"] === "remedy") {
        const atom = this.rowToRemedyAtom(row);
        if (!atom || !isRemedyDeliverable(atom)) continue;
        advisories.push({ atom_id: atom.id, scope: this.resolveRemedyScope(atom), action_literals: observableLiterals(atom.action_evidence), variant: atom.variant, condition_literals: observableLiterals(atom.condition_evidence) });
      } else if (row["kind"] === "selection") {
        const atom = this.rowToSelectionAtom(row);
        if (!atom || !isSelectionDeliverable(atom)) continue;
        advisories.push({ atom_id: atom.id, scope: this.resolveSourceScope(atom.source), action_literals: observableLiterals(atom.preferred_evidence), variant: "trouble", condition_literals: [] });
      }
    }
    const attributions = observer.attributeUsage(advisories, event);
    const advByAtom = new Map(advisories.map((a) => [a.atom_id, a] as const));
    for (const at of attributions) {
      const deliveryId = `${sessionId}:${at.atom_id}`;
      const path = event.kind === "command" ? null : event.path;
      // Condition observation is recorded independently of usage: seeing the remedy's triggering
      // condition (a matching command failing, or its error signature) is evidence in its own right,
      // and its ABSENCE means "the remedy may never have been needed", never failure.
      const adv = advByAtom.get(at.atom_id);
      if (adv) {
        const cond = observer.observeCondition(adv, event);
        if (cond.status === "OBSERVED") {
          await this.recordKnowledgeEvidence({ workspaceId, atomId: at.atom_id, deliveryId, sessionId, path, eventType: "condition_observed", evidenceKind: cond.evidence_kind, strength: "MODERATE", reason: cond.evidence_kind, signature: cond.signature });
        }
      }
      if (at.status === "NOT_OBSERVED") continue; // record only signals, never the absence of one
      const eventType = at.status === "ATTRIBUTED" ? "usage_attributed" : at.status === "AMBIGUOUS" ? "usage_ambiguous" : "usage_possible";
      await this.recordKnowledgeEvidence({ workspaceId, atomId: at.atom_id, deliveryId, sessionId, path, eventType, evidenceKind: at.evidence_kind, strength: at.strength, reason: at.reason });
      // Outcome, only for a genuinely ATTRIBUTED usage, and always narrow.
      if (at.status !== "ATTRIBUTED") continue;
      const outcome = event.kind === "command"
        ? observer.classifyCommandOutcome(at, event.exit_code)
        : observer.classifyCheckOutcome(at, checkTransition ?? null);
      if (outcome.status === "UNKNOWN") continue; // UNKNOWN is not recorded as an outcome claim
      await this.recordKnowledgeEvidence({
        workspaceId, atomId: at.atom_id, deliveryId, sessionId, path,
        eventType: outcome.status === "SUCCEEDED" ? "outcome_success" : "outcome_failure",
        evidenceKind: outcome.evidence_kind, strength: outcome.strength, reason: outcome.evidence_kind,
      });
    }
    return attributions;
  }

  /**
   * V30 error-persistence outcome (Phase 15): after a remedy's action was ATTRIBUTED, a later command
   * whose output still carries the SAME error signature the condition was observed under is STRONG
   * negative evidence that the remedy did not resolve its own condition. A different or absent error
   * is UNKNOWN, never a success claim. Reads the atom's recorded condition signature; records nothing
   * unless there was both an attributed usage and a matching persisted signature.
   */
  async observeErrorPersistence(workspaceId: string, sessionId: string, atomId: string, laterOutput: string | null): Promise<"FAILED" | "UNKNOWN"> {
    const observer = outcomeObserver();
    const usedRow = this.db.prepare("SELECT 1 FROM knowledge_evidence WHERE workspace_id = ? AND atom_id = ? AND IFNULL(session_id,'') = ? AND event_type = 'usage_attributed' LIMIT 1").get(workspaceId, atomId, sessionId);
    const condRow = this.db.prepare("SELECT signature FROM knowledge_evidence WHERE workspace_id = ? AND atom_id = ? AND IFNULL(session_id,'') = ? AND event_type = 'condition_observed' AND signature IS NOT NULL ORDER BY id DESC LIMIT 1").get(workspaceId, atomId, sessionId) as { signature: string } | undefined;
    if (!usedRow || !condRow) return "UNKNOWN";
    const verdict = observer.classifyErrorPersistenceOutcome(
      { atom_id: atomId, status: "ATTRIBUTED", evidence_kind: "text_inserted", strength: "STRONG", reason: "literal_inserted" },
      condRow.signature,
      laterOutput,
    );
    if (verdict.status !== "FAILED") return "UNKNOWN";
    await this.recordKnowledgeEvidence({
      workspaceId, atomId, deliveryId: `${sessionId}:${atomId}`, sessionId, path: null,
      eventType: "outcome_failure", evidenceKind: verdict.evidence_kind, strength: verdict.strength,
      reason: verdict.evidence_kind, signature: condRow.signature,
    });
    return "FAILED";
  }

  /** Read the append-only evidence history for a workspace, optionally one atom. Newest last. */
  listKnowledgeEvidence(workspaceId: string, atomId?: string): Promise<Array<{ atom_id: string; delivery_id: string | null; session_id: string | null; path: string | null; event_type: string; evidence_kind: string | null; strength: string | null; reason: string | null; signature: string | null; observed_at: string }>> {
    const cols = "atom_id, delivery_id, session_id, path, event_type, evidence_kind, strength, reason, signature, observed_at";
    const rows = atomId
      ? this.db.prepare(`SELECT ${cols} FROM knowledge_evidence WHERE workspace_id = ? AND atom_id = ? ORDER BY observed_at ASC, id ASC`).all(workspaceId, atomId)
      : this.db.prepare(`SELECT ${cols} FROM knowledge_evidence WHERE workspace_id = ? ORDER BY observed_at ASC, id ASC`).all(workspaceId);
    return Promise.resolve(rows as Array<{ atom_id: string; delivery_id: string | null; session_id: string | null; path: string | null; event_type: string; evidence_kind: string | null; strength: string | null; reason: string | null; signature: string | null; observed_at: string }>);
  }

  /**
   * V30 debug trace (Phase 37 / Area Z). For a session + atom (a delivery), return the ordered chain
   * delivery -> observed events -> attribution -> outcome, each row carrying its reason code, so a
   * reviewer can see WHY an event was or was not attributed without re-running the matcher. Read-only.
   */
  explainAtomEvidence(workspaceId: string, sessionId: string, atomId: string): Promise<{
    delivery_id: string; delivered: number;
    chain: Array<{ event_type: string; evidence_kind: string | null; strength: string | null; reason: string | null; signature: string | null; path: string | null; observed_at: string }>;
  }> {
    const delivered = (this.db.prepare("SELECT COUNT(*) AS n FROM remedy_deliveries WHERE workspace_id = ? AND atom_id = ? AND IFNULL(session_id,'') = ?").get(workspaceId, atomId, sessionId) as { n: number }).n;
    const chain = this.db.prepare(
      `SELECT event_type, evidence_kind, strength, reason, signature, path, observed_at
         FROM knowledge_evidence WHERE workspace_id = ? AND atom_id = ? AND IFNULL(session_id,'') = ?
        ORDER BY id ASC`,
    ).all(workspaceId, atomId, sessionId) as Array<{ event_type: string; evidence_kind: string | null; strength: string | null; reason: string | null; signature: string | null; path: string | null; observed_at: string }>;
    return Promise.resolve({ delivery_id: `${sessionId}:${atomId}`, delivered, chain });
  }

  /**
   * Read-only DERIVED counts for one atom. Not authority and not a "success rate": a summary of the
   * append-only evidence a future reviewer or ranking round could read. Deliveries come from the
   * delivery ledger, everything else from the evidence history.
   */
  /** Atom ids delivered to a session (the second input `observeToolEvent` needs), from the ledger. */
  private deliveredAtomIdsForSession(workspaceId: string, sessionId: string): string[] {
    const rows = this.db.prepare("SELECT DISTINCT atom_id FROM remedy_deliveries WHERE workspace_id = ? AND IFNULL(session_id,'') = ?").all(workspaceId, sessionId) as Array<{ atom_id: string }>;
    return rows.map((r) => r.atom_id);
  }

  /**
   * V30 live-runtime drain (Area A). The standalone hook captures each observable tool event to a
   * local, ephemeral `knowledge-observations.jsonl` (raw before/after/command live only in that local
   * file, never in the durable DB). This drains it: each line is correlated to the session's delivered
   * atoms and run through `observeToolEvent`, so a REAL agent action becomes categorical evidence with
   * NO manual call. The file is renamed to `.consumed` after a successful pass, so replays do not
   * double-count. Malformed lines are skipped, never fatal. Returns how many events were observed.
   *
   * This is the single production seam: the app gateway and the external-client hook both feed the
   * same JSONL, so attribution lives in one place (`outcomeObserver()`) and is never duplicated.
   */
  async ingestObservationsFromDisk(workspaceId: string, filePath: string): Promise<{ observed: number; skipped: number }> {
    await drainHookDeliveries(this, workspaceId, dirname(filePath)); // delivered-atom lookup reads the table
    await drainAutoActivity(this, workspaceId, dirname(filePath)); // the hook's file-change notes become activity rows
    if (!existsSync(filePath)) return { observed: 0, skipped: 0 };
    let raw = "";
    try { raw = readFileSync(filePath, "utf8"); } catch { return { observed: 0, skipped: 0 }; }
    let observed = 0;
    let skipped = 0;
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === "") continue;
      let rec: { sid?: unknown; event?: unknown; check?: unknown };
      try { rec = JSON.parse(line) as { sid?: unknown; event?: unknown; check?: unknown }; } catch { skipped += 1; continue; }
      const sid = typeof rec.sid === "string" ? rec.sid : null;
      const ev = rec.event as ObservedEvent | undefined;
      if (!sid || !ev || (ev.kind !== "edit" && ev.kind !== "write" && ev.kind !== "command")) { skipped += 1; continue; }
      const atomIds = this.deliveredAtomIdsForSession(workspaceId, sid);
      if (atomIds.length === 0) { skipped += 1; continue; }
      const check = rec.check as { was_failing: boolean; now_passing: boolean } | null | undefined;
      await this.observeToolEvent(workspaceId, sid, atomIds, ev, check ?? null);
      if (ev.kind === "command" && typeof ev.output === "string" && ev.output.length > 0) {
        for (const atomId of atomIds) await this.observeErrorPersistence(workspaceId, sid, atomId, ev.output);
      }
      observed += 1;
    }
    try { renameSync(filePath, `${filePath}.consumed`); } catch { /* best effort: a locked file is retried next pass */ }
    retireFailedGroundedAtoms(this.db, workspaceId, this.now()); // grounded atoms the evidence went against
    return { observed, skipped };
  }

  aggregateAtomEvidence(workspaceId: string, atomId: string): Promise<{ delivered: number; attributed: number; possible: number; ambiguous: number; outcome_success: number; outcome_failure: number }> {
    const delivered = (this.db.prepare("SELECT COUNT(*) AS n FROM remedy_deliveries WHERE workspace_id = ? AND atom_id = ?").get(workspaceId, atomId) as { n: number }).n;
    const byType = this.db.prepare("SELECT event_type, COUNT(*) AS n FROM knowledge_evidence WHERE workspace_id = ? AND atom_id = ? GROUP BY event_type").all(workspaceId, atomId) as Array<{ event_type: string; n: number }>;
    const c = (t: string) => byType.find((r) => r.event_type === t)?.n ?? 0;
    return Promise.resolve({ delivered, attributed: c("usage_attributed"), possible: c("usage_possible"), ambiguous: c("usage_ambiguous"), outcome_success: c("outcome_success"), outcome_failure: c("outcome_failure") });
  }

  listRemedyAtomsForSubject(
    subjectType: "memory" | "rule",
    subjectId: string,
  ): Promise<RemedyAtom[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_atoms
          WHERE kind = 'remedy' AND subject_type = ? AND subject_id = ?
          ORDER BY created_at ASC`,
      )
      .all(subjectType, subjectId) as Array<Record<string, unknown>>;
    return Promise.resolve(
      rows.map((r) => this.rowToRemedyAtom(r)).filter((a): a is RemedyAtom => a !== null),
    );
  }

  decideRemedyAtom(
    workspaceId: string,
    atomId: string,
    decision: "approve" | "reject",
    decidedBy: string,
  ): Promise<RemedyAtom> {
    const row = this.db
      .prepare("SELECT * FROM knowledge_atoms WHERE workspace_id = ? AND id = ?")
      .get(workspaceId, atomId) as Record<string, unknown> | undefined;
    // Reject rather than throw: the signature promises a Promise, and a caller using .catch()
    // would silently miss a synchronous throw. The contract suite caught this divergence
    // between the two backends.
    if (!row) return Promise.reject(new Error(`remedy atom ${atomId} not found`));
    const current = this.rowToRemedyAtom(row);
    if (!current) return Promise.reject(new Error(`remedy atom ${atomId} is unreadable`));
    // The transition itself lives in shared, so the lifecycle rules cannot drift between the
    // place that decides and the place that stores.
    const next = decision === "approve" ? approveRemedy(current, decidedBy) : rejectRemedy(current, decidedBy);
    this.db
      .prepare(
        `UPDATE knowledge_atoms
            SET authority = ?, status = ?, approved_by = ?, payload = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
      )
      .run(next.authority, next.status, next.approved_by, JSON.stringify(next), this.now(), workspaceId, atomId);
    return Promise.resolve(next);
  }

  listPendingRefreshes(
    workspaceId: string,
    includeInProgress?: boolean,
  ): Promise<PendingRefreshSummary[]> {
    const statusClause = includeInProgress
      ? "status IN ('pending','in_progress')"
      : "status = 'pending'";
    const rows = this.db
      .prepare(
        `SELECT * FROM refresh_tasks WHERE workspace_id = ? AND ${statusClause} ORDER BY created_at ASC`,
      )
      .all(workspaceId) as Array<Record<string, unknown>>;
    return Promise.resolve(
      rows.map((r) => {
        const entry = this.rowToRefreshEntry(r);
        return localEntryToSummary(entry, this.subjectSnapshot(entry.subjectType, entry.subjectId));
      }),
    );
  }

  getRefreshBrief(refreshId: string, claimedBy?: string): Promise<RefreshRow> {
    const row = this.db.prepare("SELECT * FROM refresh_tasks WHERE id = ?").get(refreshId) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error(`refresh ${refreshId} not found`);
    let entry = this.rowToRefreshEntry(row);
    // Claim-on-read: pending → in_progress.
    if (entry.status === "pending") {
      const ts = this.now();
      this.db
        .prepare(
          "UPDATE refresh_tasks SET status = 'in_progress', claimed_at = ?, claimed_by_ai = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
        )
        .run(ts, claimedBy ?? null, ts, refreshId);
      entry = {
        ...entry,
        status: "in_progress",
        claimedAt: ts,
        claimedByAi: claimedBy ?? null,
        updatedAt: ts,
      };
    }
    return Promise.resolve(
      localEntryToRefreshRow(entry, this.subjectSnapshot(entry.subjectType, entry.subjectId)),
    );
  }

  resolveRefresh(
    refreshId: string,
    status: "applied" | "rejected",
    note?: string,
    claimedBy?: string,
  ): Promise<RefreshRow> {
    const ts = this.now();
    const info = this.db
      .prepare(
        `UPDATE refresh_tasks SET status = ?, resolved_at = ?, resolved_note = ?, updated_at = ?,
          claimed_by_ai = COALESCE(?, claimed_by_ai) WHERE id = ?`,
      )
      .run(status, ts, note ?? null, ts, claimedBy ?? null, refreshId);
    if (info.changes === 0) throw new Error(`refresh ${refreshId} not found`);
    const row = this.db
      .prepare("SELECT * FROM refresh_tasks WHERE id = ?")
      .get(refreshId) as Record<string, unknown>;
    const entry = this.rowToRefreshEntry(row);
    // No suggestion mirror / dismissal window / notifications locally.
    return Promise.resolve(
      localEntryToRefreshRow(entry, this.subjectSnapshot(entry.subjectType, entry.subjectId)),
    );
  }

  requestRefresh(input: RequestRefreshInput): Promise<RequestRefreshResult> {
    // Resolve the workspace from the subject (the queue is keyed by a concrete memory/rule).
    const table = input.subjectType === "memory" ? "memories" : "rules";
    const subj = this.db
      .prepare(`SELECT workspace_id FROM ${table} WHERE id = ?`)
      .get(input.subjectId) as { workspace_id?: string } | undefined;
    if (!subj?.workspace_id) throw new Error(`refresh subject ${input.subjectId} not found`);
    // Idempotent per open subject.
    const existing = this.db
      .prepare(
        "SELECT id FROM refresh_tasks WHERE subject_id = ? AND status IN ('pending','in_progress') LIMIT 1",
      )
      .get(input.subjectId) as { id?: string } | undefined;
    if (existing?.id) return Promise.resolve({ refreshId: existing.id, alreadyPending: true });
    const id = this.genId();
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO refresh_tasks
          (id, workspace_id, subject_type, subject_id, kind, reason, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        id,
        subj.workspace_id,
        input.subjectType,
        input.subjectId,
        input.kind ?? "drift",
        input.reason,
        ts,
        ts,
      );
    return Promise.resolve({ refreshId: id, alreadyPending: false });
  }

  // No AI route: the deterministic router answers upstream.
  async routeIntent(_input: RouteIntentInput): Promise<RoutingResult | null> {
    return null;
  }

  // Bring-your-own semantic search over the local embedding store. `null`
  // ⇒ capability unwired (no key/embed) → get_context omits the field. Otherwise
  // embeds the query, cosine-scans active memories' vectors of the query's space,
  // and shapes the canonical semantic_candidates payload (degrades to a soft
  // skip on an embedding failure).
  async semanticCandidates(query: SemanticQuery): Promise<SemanticCandidatesResult | null> {
    if (!this.semanticEnabled) return null;
    return semanticCandidatesOverVectors({ query, embed: this.embed, vectors: () => memoryVectors(this.db, query.workspaceId) });
  }

  capabilities(): BackendCapabilities {
    return {
      aiMerge: false,
      aiGenerate: false,
      staleness: false,
      realtime: false,
      // True only when an embedding key/seam is wired — the editions matrix
      // --check enforces this stays honest (advertising a capability you can't
      // fill = a lie). BYO embedding key ⇒ first-class local semantic search.
      semantic: this.semanticEnabled,
      routerLLM: false,
    };
  }
}
