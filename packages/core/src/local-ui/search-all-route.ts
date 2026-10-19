// SPDX-License-Identifier: Apache-2.0
// `knowledge.searchAll` over the stores of a Pathrule home (@pathrule/protocol/local-ui-api.ts): one
// search across every local workspace, each workspace's items read, scored and ranked as
// `knowledge.search` ranks them (./knowledge-query.ts), then merged. A local store cannot filter by
// text, so each workspace is read whole, a few at a time, and only its best `limit` items are kept.
// Pathrule Cloud answers the same route from one D1 query (the knowledge search of Pathrule Cloud).
import {
  KNOWLEDGE_SEARCH_ALL_LIMIT_MAX,
  KNOWLEDGE_SEARCH_ALL_WORKSPACES_MAX,
  type KnowledgeSearchAllItem,
  type KnowledgeSearchAllResponse,
} from "@pathrule/protocol/local-ui-api.js";
import { parseKnowledgeSearch, rankKnowledge, searchOrder } from "./knowledge-query.js";
import { listItems, named, type WorkspaceRouteStore } from "./workspace-routes.js";

/** Workspaces read at once: each read asks the host for the whole workspace. */
const SEARCH_CONCURRENCY = 4;

export interface SearchAllDependencies {
  /** Every workspace the person may search, in the order the console lists them. */
  workspaces: ReadonlyArray<{ id: string; name: string }>;
  store(workspaceId: string): Promise<WorkspaceRouteStore>;
  bad(message: string): Error;
  people?(ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

/**
 * The answer to `knowledge.searchAll`: the first `KNOWLEDGE_SEARCH_ALL_WORKSPACES_MAX` workspaces
 * searched, best first. A workspace that cannot be read is left out and the answer says it is
 * incomplete (`truncated`); when none can be read, the first failure is the answer.
 */
export async function searchAllWorkspaces(
  body: Record<string, unknown>,
  deps: SearchAllDependencies,
): Promise<KnowledgeSearchAllResponse> {
  for (const key of Object.keys(body)) {
    if (!["query", "path", "kinds", "limit"].includes(key)) {
      throw deps.bad(`Unknown field "${key}".`);
    }
  }
  const search = parseKnowledgeSearch(body, deps.bad, KNOWLEDGE_SEARCH_ALL_LIMIT_MAX);
  const searched = deps.workspaces.slice(0, KNOWLEDGE_SEARCH_ALL_WORKSPACES_MAX);
  const found: KnowledgeSearchAllItem[] = [];
  const failures: unknown[] = [];
  let next = 0;
  const worker = async () => {
    while (next < searched.length) {
      const workspace = searched[next++]!;
      try {
        const store = await deps.store(workspace.id);
        const items = await listItems(store, workspace.id, search.kinds, "active");
        for (const item of rankKnowledge(items, search).slice(0, search.limit)) {
          found.push({ ...item, workspaceId: workspace.id, workspaceName: workspace.name });
        }
      } catch (err) {
        failures.push(err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SEARCH_CONCURRENCY, searched.length) }, worker));
  if (searched.length > 0 && failures.length === searched.length) throw failures[0];
  const best = found.sort(searchOrder(search.needle)).slice(0, search.limit);
  return {
    items: (await named(best, deps.people)) as KnowledgeSearchAllItem[],
    truncated: deps.workspaces.length > searched.length || failures.length > 0,
  };
}
