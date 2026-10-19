// SPDX-License-Identifier: Apache-2.0
// The knowledge in an area of the code, for Signals: how many memories, rules and skills live at a
// folder and under it, and the Knowledge page scoped to that folder. Both consoles use it.
import type { KnowledgeKind, KnowledgeListItem } from "@pathrule/protocol/local-ui-api.js";
import { useAsync } from "@pathrule/ui";
import type { KnowledgeAt, KnowledgeAtPath } from "@pathrule/ui/signals";
import { useMemo } from "react";
import type { LocalApi } from "../api/client.js";

const KINDS: readonly KnowledgeKind[] = ["memory", "rule", "skill"];

function normalize(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** Counts per folder over every path an item is attached to; an item counts once per folder. */
export function knowledgeAtIndex(
  items: readonly KnowledgeListItem[],
  href: (path: string) => string,
): KnowledgeAt {
  const placed = items.map((item) => ({
    kind: item.kind,
    paths: [
      ...new Set((item.paths?.length ? item.paths : item.path ? [item.path] : []).map(normalize)),
    ],
  }));
  const cache = new Map<string, KnowledgeAtPath>();
  return (path) => {
    const at = normalize(path);
    const hit = cache.get(at);
    if (hit) return hit;
    const counts: KnowledgeAtPath = { memory: 0, rule: 0, skill: 0, href: href(at) };
    for (const item of placed) {
      if (item.paths.some((p) => p === at || p.startsWith(`${at}/`) || at === "/")) {
        counts[item.kind] += 1;
      }
    }
    cache.set(at, counts);
    return counts;
  };
}

/** Every active memory, rule and skill of a workspace; null while loading or when it fails. */
export function useActiveKnowledge(
  api: LocalApi | null,
  workspaceId: string | null,
): KnowledgeListItem[] | null {
  const list = useAsync(
    (signal) =>
      api && workspaceId
        ? Promise.all(
            KINDS.map((kind) =>
              api
                .call("knowledge.list", { workspaceId, kind, status: "active" }, signal)
                .then((r) => r.items),
            ),
          ).then((batches) => batches.flat())
        : Promise.resolve(null),
    [api, workspaceId],
  );
  return list.state.status === "success" ? list.state.data : null;
}

/** The workspace's active knowledge as a `KnowledgeAt`, or undefined until it loads (or fails). */
export function useKnowledgeAt(
  api: LocalApi | null,
  workspaceId: string | null,
  href: (path: string) => string,
): KnowledgeAt | undefined {
  const items = useActiveKnowledge(api, workspaceId);
  // `href` is a fresh function each render; the index follows the items.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (items ? knowledgeAtIndex(items, href) : undefined), [items]);
}
