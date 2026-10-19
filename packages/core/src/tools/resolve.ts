// SPDX-License-Identifier: Apache-2.0
// pathrule_resolve — cheap name/title → editing handle lookup.
//
// The problem this solves: the compiled turn-zero knowledge and the hook
// injection deliver memory/rule/skill knowledge to the agent by TITLE/NAME +
// body, but NOT the stable `id` the read/update/delete tools require. So to edit
// something it was just shown by name (e.g. the `pathrule-release` skill), an
// agent had to reverse-engineer the id: pull the whole tree, list every skill,
// then read candidate bodies in parallel to match `name === "..."` — a documented
// ~109k-token, multi-minute detour.
//
// This handler maps a name/title straight to its `{ id, node_path, version_id }`
// in ONE cheap call, reading only the workspace overview (titles + ids, no
// bodies). For a single unambiguous hit it also attaches the `version_id` +
// `updated_at` (one targeted row read), so the agent can immediately call
// update_* with optimistic-concurrency safety and NO further reads.
//
// Security: it returns only the ids of the caller's OWN workspace items —
// exactly the ids `pathrule_get_context` already returns in `workspace_overview`.
// It exposes no new data, just a far cheaper path to the same handles.

import type { ToolContext, ToolResult } from "./types.js";
import { mapStoreError } from "./types.js";

export type ResolveKind = "memory" | "rule" | "skill";

export interface ResolveArgs {
  /** Workspace to search (the tool wrapper resolves this from cwd or an explicit id). */
  workspaceId: string;
  /** Name (rule/skill) or title (memory) to resolve — exact, prefix, or substring. */
  query: string;
  /** Restrict to one kind. Omit to search all three. */
  kind?: ResolveKind;
  /** Restrict to items attached at this workspace-relative path (disambiguates same-named items). */
  node_path?: string;
  /** Max matches to return (default 8). */
  limit?: number;
  /**
   * When a single unambiguous match is found, also return its full body. The row
   * is already read to attach version_id, so the body is free — this collapses a
   * "resolve then read" into one call. Default true; pass false to keep the
   * response tiny (handle only).
   */
  include_body?: boolean;
}

export interface ResolveMatch {
  kind: ResolveKind;
  id: string;
  /** Title for a memory; name for a rule/skill. */
  name: string;
  node_path: string;
  /** Attached only for a single unambiguous hit — pass as expected_version_id to update safely. */
  version_id?: string;
  updated_at?: string;
  /** Full body, attached for a single unambiguous match when include_body is not disabled. */
  content?: string;
}

export interface ResolveResult {
  matches: ResolveMatch[];
  /** True when exactly one strong match was found and its edit handle is fully populated. */
  unique: boolean;
}

/** "/foo" | "foo" | "" | "/" → a normalised comparable path ("" and "/" both → "/"). */
function normalizePath(p: string | undefined | null): string {
  if (!p) return "/";
  const s = p.startsWith("/") ? p : `/${p}`;
  return s === "" ? "/" : s;
}

/** 3 = exact (ci), 2 = prefix/whole-word, 1 = substring, 0 = no match. */
function scoreName(candidate: string, query: string): number {
  const c = candidate.trim().toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  if (c === q) return 3;
  if (c.startsWith(q) || c.split(/[^\p{L}\p{N}]+/u).includes(q)) return 2;
  if (c.includes(q)) return 1;
  return 0;
}

/**
 * Resolve a name/title to its editing handle(s). Reads the workspace overview
 * (cheap: titles + ids, no bodies); for a single unambiguous hit, reads that one
 * row to attach `version_id` + `updated_at`.
 */
export async function resolveHandler(
  ctx: ToolContext,
  args: ResolveArgs,
): Promise<ToolResult<ResolveResult>> {
  if (!ctx.backend) {
    return { ok: false, error: { code: "upstream_error", message: "No backend configured." } };
  }
  const query = args.query?.trim();
  if (!query) {
    return { ok: false, error: { code: "invalid_args", message: "query is required." } };
  }
  const limit = Math.min(Math.max(args.limit ?? 8, 1), 50);
  const pathFilter = args.node_path !== undefined ? normalizePath(args.node_path) : null;

  try {
    const overview = await ctx.backend.workspaceOverview(args.workspaceId);
    const scored: Array<ResolveMatch & { score: number }> = [];
    for (const node of overview) {
      const nodePath = normalizePath(node.relative_path);
      if (pathFilter !== null && nodePath !== pathFilter) continue;
      const wantMemory = !args.kind || args.kind === "memory";
      const wantRule = !args.kind || args.kind === "rule";
      const wantSkill = !args.kind || args.kind === "skill";
      if (wantMemory) {
        for (const m of node.memories) {
          const score = scoreName(m.title, query);
          if (score > 0) scored.push({ kind: "memory", id: m.id, name: m.title, node_path: nodePath, score });
        }
      }
      if (wantRule) {
        for (const r of node.rules) {
          const score = scoreName(r.name, query);
          if (score > 0) scored.push({ kind: "rule", id: r.id, name: r.name, node_path: nodePath, score });
        }
      }
      if (wantSkill) {
        for (const s of node.skills) {
          const score = scoreName(s.name, query);
          if (score > 0) scored.push({ kind: "skill", id: s.id, name: s.name, node_path: nodePath, score });
        }
      }
    }

    scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const top = scored.slice(0, limit);

    // A single unambiguous winner: the best match is a lone exact hit, OR there
    // is exactly one candidate overall. Attach its version_id so the caller can
    // update safely with no extra read.
    const exactHits = scored.filter((s) => s.score === 3);
    const uniqueWinner =
      (exactHits.length === 1 && scored[0]?.score === 3 && scored[0]?.id === exactHits[0]?.id) ||
      scored.length === 1
        ? (scored[0] ?? null)
        : null;

    if (uniqueWinner) {
      const handle = await readVersionHandle(ctx, uniqueWinner.kind, uniqueWinner.id);
      if (handle) {
        const match = top.find((m) => m.id === uniqueWinner.id && m.kind === uniqueWinner.kind);
        if (match) {
          match.version_id = handle.versionId;
          match.updated_at = handle.updatedAt;
          // The row was already read for version_id, so the body is free — attach
          // it unless the caller opted out. Collapses "resolve then read" to one call.
          if (args.include_body !== false) match.content = handle.content;
        }
      }
    }

    const matches: ResolveMatch[] = top.map(({ score, ...m }) => (void score, m));
    return { ok: true, data: { matches, unique: Boolean(uniqueWinner) } };
  } catch (err) {
    return { ok: false, error: mapStoreError(err as { code?: string; message: string }) };
  }
}

/** Read the concurrency token + timestamp + body for one resolved item. */
async function readVersionHandle(
  ctx: ToolContext,
  kind: ResolveKind,
  id: string,
): Promise<{ versionId: string; updatedAt: string; content: string } | null> {
  const backend = ctx.backend!;
  const row =
    kind === "memory"
      ? await backend.readMemory(id)
      : kind === "rule"
        ? await backend.readRule(id)
        : await backend.readSkill(id);
  if (!row) return null;
  return { versionId: row.versionId, updatedAt: row.updatedAt, content: row.content };
}
