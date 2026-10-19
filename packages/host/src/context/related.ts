// SPDX-License-Identifier: Apache-2.0
// The deterministic related set of a turn: which memories of the current node, and which bodies
// from other nodes, go out for this request. It is the open default ranker for the turn context.
//
// - Semantic candidates, when the backend offers them (`KnowledgeBackend.semanticCandidates`): the
//   current node keeps the memories they surfaced, and other nodes contribute their best few.
// - Otherwise lexical: content-bearing intent terms (fillers dropped) scored against titles, plus
//   the backend's project-map search, capped and best first.
//
// Moved unchanged from Studio's turn context.

import type { KnowledgeBackend, NodeContent } from "@pathrule/core";
import type { ContextBundle } from "@pathrule/core/tools/tree.js";
import { isArchivedKnowledgePath } from "@pathrule/protocol/knowledge-archive.js";
import type {
  SemanticCandidateOut,
  SemanticCandidatesResult,
} from "@pathrule/protocol/routing-types.js";

import type { RelatedNode } from "./render.js";

// How many cross-node NODES to scan for matches (the candidate pool).
// projectMapSearch already floors relevance at ~0.30.
const MAX_RELATED_NODES = 3;
// Hard cap on how many memory BODIES we actually embed, across all nodes. The
// old code kept every title-matching memory on each picked node, so a single
// generic token like "test" on a root node full of benchmark memories dumped
// 7+ full bodies. We now score every candidate and keep only the best few.
// Completeness: deliver enough of the relevant slice that the agent does ZERO
// exploration (k=8 was measured as the floor; below it the agent explores for
// missing facts). Counts are the candidate ceiling; the shared
// body budget in renderBlock is the real limiter, so over-selecting is safe.
const MAX_RELATED_MEMORIES = 4;

// Filler tokens that carry no retrieval signal — they substring-match memory
// titles by accident ("test amaçlı küçük görevleri" lit up every benchmark/test
// memory). Stripping them leaves only the content-bearing tokens. Conservative
// on purpose: words that could be a real topic (codex, claude, agent) stay, and
// the score+cap below keep them from over-firing.
const STOP_WORDS = new Set<string>([
  // Turkish fillers
  "için",
  "gibi",
  "çok",
  "daha",
  "ama",
  "veya",
  "ile",
  "bir",
  "bu",
  "şu",
  "amaçlı",
  "basit",
  "küçük",
  "büyük",
  "üzerinden",
  "başlat",
  "yeni",
  "yap",
  "görev",
  "görevi",
  "görevleri",
  "hangi",
  "neler",
  "nerede",
  "olan",
  "kadar",
  // English fillers
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "your",
  "you",
  "run",
  "new",
  "just",
  "very",
  "small",
  "simple",
  "start",
  "make",
  "please",
  "some",
  "any",
  "task",
  "tasks",
]);

/**
 * Score how well a memory title answers the query: a whole-word hit (the term
 * appears as its own word in the title) is worth more than an incidental
 * substring hit. Returns 0 when nothing matches.
 */
function scoreTitle(title: string, terms: string[]): number {
  const lower = title.toLowerCase();
  const words = new Set(lower.split(/[^\p{L}\p{N}]+/u));
  let score = 0;
  for (const t of terms) {
    if (words.has(t)) score += 2;
    else if (lower.includes(t)) score += 1;
  }
  return score;
}

/** Content-bearing query tokens (filler/short words dropped), shared by lexical paths. */
export function intentTerms(intent: string | undefined): string[] {
  const q = intent?.trim();
  if (!q) return [];
  return Array.from(
    new Set(
      q
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length >= 3 && !STOP_WORDS.has(t)),
    ),
  );
}

// Cap on how many of the CURRENT node's own memories we inject. Like the cross-node
// cap, this stops a memory-dense node (e.g. the root with 17 memories) from dumping
// all of them every turn — they are now intent-filtered first.
const MAX_NODE_MEMORIES = 6;
// How many candidates to pull from the semantic RPC; split across this-node +
// cross-node, so ask for more than either cap alone.
const SEMANTIC_RPC_LIMIT = 10;

/**
 * Intent-aware: find cross-node memories that match the user's question and pull
 * their bodies. Two signals, unioned:
 *  1. Deterministic keyword match against the overview titles/names already in
 *     hand (catches short tokens like an issue id that fuzzy ranking floors out).
 *  2. Semantic projectMapSearch (catches matches that aren't literal in titles).
 */
export async function fetchRelated(
  backend: KnowledgeBackend,
  workspaceId: string,
  currentNodeId: string | undefined,
  overview: ContextBundle["workspace_overview"],
  userIntent: string | undefined,
): Promise<RelatedNode[]> {
  const query = userIntent?.trim();
  if (!query) return [];

  // node_id -> relative path for every candidate node.
  const candidates = new Map<string, string>();
  // Nodes that came from the semantic signal (not a literal title hit) — their
  // memories get a small floor score so a real semantic match can still surface
  // even when no query token appears in the title.
  const semanticNodes = new Set<string>();

  // 1) Deterministic keyword match on overview titles (cheap, already loaded).
  //    Filler tokens are dropped so generic words don't light up every title.
  const terms = intentTerms(query);
  if (terms.length > 0) {
    for (const node of overview) {
      if (node.node_id === currentNodeId) continue;
      const hay = [...node.memories.map((m) => m.title), ...node.rules.map((r) => r.name)]
        .join(" ")
        .toLowerCase();
      if (terms.some((t) => hay.includes(t))) candidates.set(node.node_id, node.relative_path);
    }
  }

  // 2) Semantic fallback/augment.
  try {
    const search = await backend.projectMapSearch(workspaceId, query, MAX_RELATED_NODES + 2);
    for (const n of search.nodes) {
      if (n.node_id !== currentNodeId && n.memory_titles.length > 0) {
        candidates.set(n.node_id, n.path);
        semanticNodes.add(n.node_id);
      }
    }
  } catch {
    // best-effort
  }

  // Score every candidate memory and keep only the globally best few, instead of
  // dumping all title-matching memories per node. A whole-word title hit beats a
  // substring hit; a purely-semantic node contributes at a low floor score.
  const scored: Array<{
    path: string;
    memory: { id: string; title: string; content: string };
    score: number;
  }> = [];
  for (const [nodeId, path] of [...candidates.entries()].slice(0, MAX_RELATED_NODES)) {
    const content = await backend.getNodeContent(nodeId);
    const floor = semanticNodes.has(nodeId) ? 0.5 : 0;
    for (const m of content.memories) {
      const score = scoreTitle(m.title, terms) + floor;
      if (score > 0) {
        scored.push({ path, memory: { id: m.id, title: m.title, content: m.content }, score });
      }
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, MAX_RELATED_MEMORIES);

  // Regroup the winners by node path, preserving descending-score order.
  const byPath = new Map<string, RelatedNode>();
  for (const { path, memory } of top) {
    let node = byPath.get(path);
    if (!node) {
      node = { path, memories: [] };
      byPath.set(path, node);
    }
    node.memories.push(memory);
  }
  return [...byPath.values()];
}

/**
 * Semantic cross-node recall (signed-in cloud users). Asks the backend's
 * `semanticCandidates` (per-memory cosine, server-side embedding) and resolves the
 * winners' bodies. Returns:
 *   - RelatedNode[] when semantic produced bodied candidates,
 *   - [] when semantic ran but found nothing relevant (DON'T fall back to lexical
 *     noise — an empty answer is more honest than a bad keyword match),
 *   - null when semantic is unavailable/dormant/errored (caller uses lexical).
 *
 * The query names no `bundleMemories`. The candidate contract excludes ids the caller already
 * delivered, and this path's own memories are not delivered yet: the caller selects them FROM this
 * answer (`selectCurrentNodeMemories`), so claiming them here would leave nothing to select.
 */
export async function getSemanticCandidates(
  backend: KnowledgeBackend,
  workspaceId: string,
  matchedNodePath: string,
  userIntent: string | undefined,
): Promise<SemanticCandidateOut[] | null> {
  const intent = userIntent?.trim();
  if (!intent || typeof backend.semanticCandidates !== "function") return null;

  let result: SemanticCandidatesResult | null;
  try {
    result = await backend.semanticCandidates({
      workspaceId,
      userIntent: intent,
      matchedNodePath,
      bundleMemories: undefined,
      subtreeIndex: undefined,
      discoveryCandidateTitles: undefined,
      limit: SEMANTIC_RPC_LIMIT,
      // No floor of its own: each backend applies its default (0.45, as the cloud get_context
      // path does), or the embedding model's own floor where its cosine scale is lower.
    });
  } catch {
    return null;
  }
  if (!result) return null; // backend has no semantic closure wired (e.g. local, no key)
  // An archive node's knowledge is history (`knowledge-archive.ts`), never turn context.
  const live = isArchivedKnowledgePath(matchedNodePath)
    ? result.payload?.candidates
    : result.payload?.candidates.filter((c) => !isArchivedKnowledgePath(c.node_path));
  if (live && live.length > 0) return live;
  if (result.payload && result.payload.candidates.length > 0) return [];
  // Semantic ran. A genuine empty result means "nothing relevant" → return [] so the
  // caller shows nothing (no lexical noise). Only a hard failure → null (use lexical).
  if (result.skipped === "no_candidates" || result.skipped === "empty_intent") return [];
  return null;
}

/**
 * Pick the CURRENT node's own memories to inject, intent-aware. Mirrors the
 * cross-node logic so a memory-dense node (e.g. the root) no longer dumps every
 * memory regardless of the prompt:
 *   - semantic ran  → keep only memories it surfaced for this node (relevance-gated),
 *   - lexical       → keep title-scored matches (capped),
 *   - no signal     → keep the node's memories as the orientation default.
 */
export function selectCurrentNodeMemories(
  memories: NodeContent["memories"],
  semantic: SemanticCandidateOut[] | null,
  userIntent: string | undefined,
): NodeContent["memories"] {
  if (memories.length === 0) return memories;
  if (semantic !== null) {
    const ids = new Set(semantic.map((c) => c.id));
    return memories.filter((m) => ids.has(m.id)).slice(0, MAX_NODE_MEMORIES);
  }
  const terms = intentTerms(userIntent);
  if (terms.length === 0) return memories;
  return memories
    .map((m) => ({ m, score: scoreTitle(m.title, terms) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_NODE_MEMORIES)
    .map((x) => x.m);
}

/** Resolve semantic candidate bodies from their node content, capped + grouped by node. */
export async function relatedFromSemantic(
  backend: KnowledgeBackend,
  candidates: SemanticCandidateOut[],
  overview: ContextBundle["workspace_overview"],
  currentNodeId: string | undefined,
): Promise<RelatedNode[]> {
  const pathToNodeId = new Map(overview.map((n) => [n.relative_path, n.node_id]));
  const contentCache = new Map<string, NodeContent>();
  const byPath = new Map<string, RelatedNode>();
  // Candidates arrive in descending similarity order; keep the best few.
  for (const c of candidates.slice(0, MAX_RELATED_MEMORIES)) {
    const nodeId = pathToNodeId.get(c.node_path);
    if (!nodeId || nodeId === currentNodeId) continue;
    let nodeContent = contentCache.get(nodeId);
    if (!nodeContent) {
      nodeContent = await backend.getNodeContent(nodeId);
      contentCache.set(nodeId, nodeContent);
    }
    const mem = nodeContent.memories.find((m) => m.id === c.id);
    if (!mem) continue;
    let node = byPath.get(c.node_path);
    if (!node) {
      node = { path: c.node_path, memories: [] };
      byPath.set(c.node_path, node);
    }
    node.memories.push({ id: mem.id, title: mem.title, content: mem.content });
  }
  return [...byPath.values()];
}
