// SPDX-License-Identifier: Apache-2.0
//
// Explicit path references in a knowledge body ("packages/cli/src", "src/store.ts").
// They anchor an item to the code it talks about: for "related" lookups by file and for
// coverage gaps. Paths, not words, so this is the same for every language.

export const MAX_ANCHORS_PER_ITEM = 64;

// Two or more segments after a boundary (start, whitespace, quote, backtick, bracket); the
// last segment may carry an extension. A preceding "/" or ":" never starts a match, so URLs
// ("https://host/a/b") and scheme paths are skipped.
const PATH_RE = /(?:^|[\s`"'([])(?:\.\/|\/)?((?:[\p{L}\p{N}_.@-]+\/)+[\p{L}\p{N}_.@-]+)/gu;
const TRAILING = /[.,;:!?)\]}'"`]+$/;

export function normalizeAnchorPath(path: string): string {
  return path.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "").replace(TRAILING, "");
}

/** Deduped, normalized path references (no leading slash), first-seen order, at most 64. */
export function extractPathAnchors(body: string | null | undefined): string[] {
  if (!body) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(PATH_RE)) {
    const path = normalizeAnchorPath(match[1] ?? "");
    const segments = path.split("/").filter(Boolean);
    if (segments.length < 2 || segments.some((segment) => segment === "." || segment === "..")) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length >= MAX_ANCHORS_PER_ITEM) break;
  }
  return out;
}

/**
 * A reference written relative to the item's own node, as workspace paths. Knowledge filed on
 * /tools/film says "scripts/plan.mjs", on .../agent-gateway/adapters "adapters/codex.ts".
 * A reference that starts with the node's first segment is already workspace-relative. One
 * that starts with a segment of the node path is spliced there; any other is appended. A
 * reference that names no real file this way simply never matches one.
 */
export function resolveNodeAnchor(anchor: string, nodePath: string): string | null {
  const node = normalizeAnchorPath(nodePath).split("/").filter(Boolean);
  const ref = normalizeAnchorPath(anchor).split("/").filter(Boolean);
  if (node.length === 0 || ref.length === 0 || ref[0] === node[0]) return null;
  const at = node.lastIndexOf(ref[0]!);
  return [...(at >= 0 ? node.slice(0, at) : node), ...ref].join("/");
}

/** An item's references plus their node-relative readings (resolveNodeAnchor), deduped. */
export function resolveItemAnchors(anchors: readonly string[], nodePaths: readonly string[]): string[] {
  const out = new Set(anchors);
  for (const anchor of anchors) {
    for (const node of nodePaths) {
      const resolved = resolveNodeAnchor(anchor, node);
      if (resolved) out.add(resolved);
    }
  }
  return [...out];
}

/** Ancestor directories of a file path, nearest first ("a/b/c.ts" -> ["a/b", "a"]). */
export function ancestorDirectories(path: string): string[] {
  const segments = normalizeAnchorPath(path).split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = segments.length - 1; i >= 1; i--) out.push(segments.slice(0, i).join("/"));
  return out;
}

/** Path depth in segments ("packages/app/src" -> 3). */
export function pathDepth(path: string): number {
  return normalizeAnchorPath(path).split("/").filter(Boolean).length;
}
