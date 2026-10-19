// SPDX-License-Identifier: Apache-2.0
// Compile a turn's Pathrule context: the one path every surface uses to pre-load an agent's turn.
//
// The host resolves the folder's backend and takes core's `get_context` bundle and deterministic
// route, selects the memories (semantic candidates when the backend offers them, otherwise the
// lexical related set), renders the block with its fixed budgets, adds the engine's sections and the
// project learning under one ceiling, and caches the result for a short while.
//
// What the host cannot do itself arrives from its caller as sources: the backend of a folder no
// local store serves, the store holding a cloud workspace's atoms, who is signed in, and what an
// account adds to a turn. With none of them, a folder resolves to its local store only and the turn
// carries no account sections.
//
// Never throws: any miss or error gives the empty context, so a turn always proceeds.

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { KnowledgeBackend, NodeContent } from "@pathrule/core";
import { classifyDeterministicRoute } from "@pathrule/core/retrieval/deterministic-routing.js";
import { pathruleHome } from "@pathrule/core/storage/paths.js";
import { runtimeIndicatorLine } from "@pathrule/core/tools/runtime-events.js";
import { getContextHandler } from "@pathrule/core/tools/tree.js";
import type { DeterministicRoute } from "@pathrule/protocol/routing-types.js";
import { extractSkillInvocationMarkers } from "@pathrule/protocol/skill-invocation.js";
import type {
  TurnContext,
  TurnContextMetrics,
  TurnContextRequest,
} from "@pathrule/protocol/turn-context.js";
import { stableHash } from "@pathrule/protocol/versioning.js";

import {
  composeWithProjectLearning,
  learningTagCurrent,
  type LearningCacheTag,
  type ProjectLearningDeps,
} from "./project-context.js";
import {
  fetchRelated,
  getSemanticCandidates,
  intentTerms,
  relatedFromSemantic,
  selectCurrentNodeMemories,
} from "./related.js";
import {
  emptyTurnContext,
  MAX_BLOCK_CHARS,
  renderBlock,
  truncate,
  type RelatedNode,
} from "./render.js";
import { referencedSkillReadPaths } from "./skill-paths.js";

export type { TurnContextRequest };

/** Which backend serves the folder. */
export interface ResolvedTurnBackend {
  backend: KnowledgeBackend;
  kind: "local" | "cloud";
}

/** What an account adds to a turn: Pathrule Cloud's, from its plugin. */
export interface TurnContextAccount<R extends ResolvedTurnBackend> {
  /** The id the turn's injection and its end-of-turn feedback are joined on; null when there is none. */
  sessionKey(resolved: R, workspaceId: string): string | null;
  /** The account's sections, already rendered: retrieval signals with their version, and its intelligence. */
  sections(input: {
    resolved: R;
    route: DeterministicRoute;
    workspaceId: string;
    currentNodePath: string;
    userIntent: string | undefined;
    knownItemVersions: string[] | undefined;
    surface: string;
  }): Promise<{ retrieval: { delta: string; version: string }; intelligenceBlock: string }>;
  /** Runs once the context is composed, before it is cached. It may annotate the attributions. */
  afterRender(input: {
    resolved: R;
    workspaceId: string;
    userIntent: string | undefined;
    sessionKey: string | null;
    context: TurnContext;
  }): Promise<void>;
}

export interface TurnContextSources<R extends ResolvedTurnBackend = ResolvedTurnBackend> {
  /** Which backend serves a folder; null when none does. */
  resolveBackend(cwd: string): Promise<R | null>;
  /**
   * The local store of a workspace, for a cloud workspace's approved atoms. Asked only when the
   * store already exists, so a cloud workspace nobody analysed never gets one created.
   */
  openLocalStore?(workspaceId: string): Promise<KnowledgeBackend>;
  /** Who is signed in. It partitions the cache; "signed-out" without it. */
  identity?(): Promise<string>;
  account?: TurnContextAccount<R>;
  /** The person's lease-request setting, read when the request does not carry it. */
  leaseRequests?(): boolean;
  env?: NodeJS.ProcessEnv;
  /** Test seams of the project context and the engine sections. */
  project?: ProjectLearningDeps;
}

interface CacheEntry {
  result: TurnContext;
  expires: number;
  learning?: LearningCacheTag;
}

// Pre-injection runs on EVERY turn; within a burst at the same node the
// knowledge rarely changes, so a short TTL keeps the cost off the hot path while
// staying fresh enough to reflect a same-chat write within a couple of turns.
const CACHE_TTL_MS = 20_000;

/** One caller's rendered turns, kept for a short while, and the builds in flight. */
export class TurnContextCache {
  readonly entries = new Map<string, CacheEntry>();
  readonly inFlight = new Map<string, Promise<TurnContext>>();

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }
}

/**
 * Where this workspace's approved atoms live. Atoms are local by design: a local workspace keeps them
 * in its own store, and a cloud workspace keeps them in the local store the review queue wrote them to.
 * That store is opened only if it already exists, so a cloud workspace nobody analysed never gets one
 * created just to find it empty.
 */
async function atomStoreFor<R extends ResolvedTurnBackend>(
  resolved: R,
  workspaceId: string,
  sources: TurnContextSources<R>,
): Promise<KnowledgeBackend | null> {
  const { backend, kind } = resolved;
  if (backend.compiledMemoryDeliveries) return backend;
  if (kind !== "cloud" || !sources.openLocalStore) return null;
  return existsSync(join(pathruleHome(sources.env ?? process.env), workspaceId, "pathrule.db"))
    ? sources.openLocalStore(workspaceId)
    : null;
}

/**
 * Build the markdown context block (+ its attributions) to prepend to the engine
 * system instruction. Returns an empty result on any miss/error so the caller
 * can merge it unconditionally.
 */
export async function compileTurnContext<R extends ResolvedTurnBackend>(
  input: TurnContextRequest,
  sources: TurnContextSources<R>,
  cache: TurnContextCache,
): Promise<TurnContext> {
  const empty = emptyTurnContext();
  const cwd = input.workspaceRoot;
  if (!cwd) return empty;
  const deps = sources.project ?? {};

  // ::skill markers must resolve live (the prompt picked a specific skill), so
  // those turns bypass the cache; everything else is cacheable. The block now
  // depends on the question (intent-aware cross-node bodies), so the cache key
  // includes the intent — a repeated identical turn is free, a new question
  // refetches.
  const bypassCache = extractSkillInvocationMarkers(input.userIntent ?? "").length > 0;
  const surface = input.surface ?? "chat";
  // Account intelligence may contain owner-private personal preferences. Partition
  // the cache by who is signed in so a fast sign-out/sign-in on the same machine
  // can never reuse another person's rendered block.
  const cacheIdentity = sources.identity
    ? await sources.identity().catch(() => "signed-out")
    : "signed-out";
  const knownFingerprint = stableHash({
    stable: input.knownStableVersion ?? "",
    items: [...(input.knownItemVersions ?? [])].sort(),
  });
  const cacheKey = `${cacheIdentity}::${cwd}::${input.nodePath ?? ""}::${surface}::${input.userIntent ?? ""}::${knownFingerprint}`;
  if (!bypassCache) {
    const hit = cache.entries.get(cacheKey);
    if (
      hit &&
      hit.expires > Date.now() &&
      (await learningTagCurrent(hit.learning, deps, sources.env))
    )
      return hit.result;
    const pending = cache.inFlight.get(cacheKey);
    if (pending) return pending;
  }

  const build = (async (): Promise<TurnContext> => {
    try {
      const resolved = await sources.resolveBackend(cwd);
      if (!resolved) return empty;
      const { backend, kind } = resolved;

      const match = await backend.resolveWorkspaceFromCwd(cwd);
      if (!match) return empty;

      // Narrow to the closest EXISTING node (getContextHandler expects a node
      // relative_path; closestNode walks up the tree). Fall back to the raw
      // relative path so a not-yet-materialised node still yields the overview.
      const closest = await backend.closestNode(match.workspaceId, match.relativePath);
      const relativePath = closest?.relativePath ?? match.relativePath;

      const res = await getContextHandler(
        // getContextHandler reads only ctx.backend; identity rides the backend.
        { backend, userId: "", workspaceId: match.workspaceId },
        {
          workspace_id: match.workspaceId,
          relative_path: relativePath,
          user_intent: input.userIntent,
        },
      );
      if (!res.ok) return empty;

      const bundle = res.data;
      const content = bundle.node ? await backend.getNodeContent(bundle.node.id) : null;

      // Intent router (in-process, network-free — the same @pathrule/core
      // classifier the cloud MCP uses). On minimal-depth turns (direct commands,
      // known-file edits, recent-activity questions) the agent does NOT need
      // cross-node discovery memories, so skip the fetch entirely. This is the
      // cheap, MCP-free equivalent of the cloud router's section gating and is the
      // real fix for "a trivial prompt pulled 7 memories".
      const route = classifyDeterministicRoute({
        userIntent: input.userIntent ?? "",
        relativePath,
        recentActivities: [],
        workspaceOverview: bundle.workspace_overview,
      });

      // Both the CURRENT node's own memories and the CROSS-node discovery memories
      // are intent-aware. On minimal-depth turns (direct commands, known-file
      // edits) inject NEITHER — rules + skills still render, which is the real
      // orientation value. Otherwise prefer SEMANTIC (per-memory) recall when the
      // backend offers it (signed-in cloud users — embedding runs server-side).
      // Local users retain deterministic lexical discovery; cloud failures are
      // restricted to title-matched memories at the exact path.
      let related: RelatedNode[] = [];
      let selectedMemories = content?.memories ?? [];
      let retrievalMode: TurnContextMetrics["retrievalMode"] = "minimal";
      if (route.context_depth === "minimal") {
        related = [];
        selectedMemories = [];
      } else {
        const semantic = await getSemanticCandidates(
          backend,
          match.workspaceId,
          relativePath,
          input.userIntent,
        );
        if (semantic === null) {
          // Cloud semantic failure is fail-closed for CROSS-NODE discovery: a
          // broad project-map fallback can inject unrelated full bodies and was a
          // major source of token amplification. Keep only bounded, title-matched
          // memories at the exact current path so a transient embedding outage
          // does not erase otherwise-local project knowledge.
          if (kind === "cloud") {
            console.warn(
              "[pathrule-context] semantic candidates unavailable; using path-local bounded fallback",
            );
            related = [];
            selectedMemories =
              intentTerms(input.userIntent).length > 0
                ? selectCurrentNodeMemories(content?.memories ?? [], null, input.userIntent)
                : [];
            retrievalMode = "fail_closed";
          } else {
            related = await fetchRelated(
              backend,
              match.workspaceId,
              bundle.node?.id,
              bundle.workspace_overview,
              input.userIntent,
            );
            selectedMemories = selectCurrentNodeMemories(
              content?.memories ?? [],
              semantic,
              input.userIntent,
            );
            retrievalMode = "lexical";
          }
        } else {
          // Semantic path: candidates span the matched node + descendants, so split
          // this-node hits (current memories) from cross-node hits (related bodies).
          const crossNode = semantic.filter((c) => c.node_path !== relativePath);
          related = await relatedFromSemantic(
            backend,
            crossNode,
            bundle.workspace_overview,
            bundle.node?.id,
          );
          selectedMemories = selectCurrentNodeMemories(
            content?.memories ?? [],
            semantic,
            input.userIntent,
          );
          retrievalMode = "semantic";
        }
      }

      const filteredContent: NodeContent | null = content
        ? { ...content, memories: selectedMemories }
        : null;
      // One session key shared by the injection capture and the end-of-turn
      // log_activity feedback (only an account has an affinity loop).
      const sessionKey = sources.account?.sessionKey(resolved, match.workspaceId) ?? null;

      const subSkillReadPaths =
        bundle.invoked_skills && bundle.invoked_skills.length > 0
          ? await referencedSkillReadPaths(backend, match.workspaceId, cwd, bundle.invoked_skills)
          : [];

      // Which memories go out as their compiled form, judged against the exact text this turn would
      // otherwise deliver. No store with approved atoms, or a failed read, delivers every memory as
      // written: the fail-closed side.
      const deliverable = [
        ...(filteredContent?.memories ?? []),
        ...related.flatMap((r) => r.memories),
      ].map((m) => ({ id: m.id, content: m.content }));
      const atomStore = await atomStoreFor(resolved, match.workspaceId, sources);
      const compiledMemories =
        atomStore?.compiledMemoryDeliveries && deliverable.length > 0
          ? await atomStore
              .compiledMemoryDeliveries(match.workspaceId, deliverable)
              .catch(() => ({}))
          : {};

      // The application's runtime issues under this path: a count read from the local store only,
      // so a turn never makes a network call for it.
      const runtimeLine =
        kind === "local" && backend.runtimeEventIndicator
          ? runtimeIndicatorLine(
              await backend
                .runtimeEventIndicator(
                  match.workspaceId,
                  bundle.resolved_workspace_path ?? relativePath,
                )
                .catch(() => null),
            )
          : null;

      const baseResult = renderBlock(
        bundle,
        filteredContent,
        related,
        match.workspaceId,
        sessionKey,
        subSkillReadPaths,
        {
          knownStableVersion: input.knownStableVersion,
          knownItemVersions: input.knownItemVersions,
          compiledMemories,
          runtimeLine,
        },
      );
      // The account's sections: retrieval signals and its intelligence, rendered.
      const { retrieval, intelligenceBlock } = sources.account
        ? await sources.account.sections({
            resolved,
            route,
            workspaceId: match.workspaceId,
            currentNodePath: relativePath,
            userIntent: input.userIntent,
            knownItemVersions: input.knownItemVersions,
            surface,
          })
        : { retrieval: { delta: "", version: "" }, intelligenceBlock: "" };
      // Project learning and the source map join the dynamic block under one load budget. A
      // slow checkout costs this turn its learning, never the turn; that render is not cached.
      const { result, pending, learningTag } = await composeWithProjectLearning({
        deps,
        backend: resolved.backend,
        workspaceId: match.workspaceId,
        localRootPath: match.localRootPath || cwd,
        scope: input.nodePath || match.relativePath || "/",
        routeDepth: route.context_depth,
        retrievalMode,
        baseResult,
        retrieval,
        intelligenceBlock,
        surface,
        knownItemVersions: input.knownItemVersions,
        maxChars: MAX_BLOCK_CHARS,
        truncate,
        env: sources.env,
      });

      await sources.account?.afterRender({
        resolved,
        workspaceId: match.workspaceId,
        userIntent: input.userIntent,
        sessionKey,
        context: result,
      });

      // Cache the rendered result (empty included) so a repeat turn is free; a
      // same-chat write surfaces on the next turn after the short TTL.
      if (!bypassCache && !pending)
        cache.entries.set(cacheKey, {
          result,
          expires: Date.now() + CACHE_TTL_MS,
          learning: learningTag,
        });
      return result;
    } catch {
      // Never block a turn on context provisioning.
      return empty;
    }
  })();
  if (!bypassCache) cache.inFlight.set(cacheKey, build);
  try {
    return await build;
  } finally {
    if (cache.inFlight.get(cacheKey) === build) cache.inFlight.delete(cacheKey);
  }
}
