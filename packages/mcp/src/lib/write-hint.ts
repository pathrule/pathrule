// SPDX-License-Identifier: Apache-2.0
// Related knowledge after an update, from the map this process already cached
// for pathrule_knowledge_map. Never builds a map. One local MCP server process serves one
// client session, so a process-wide ledger means once per item per session.
import {
  createWriteHintLedger,
  type RelatedToCheck,
} from "@pathrule/core/knowledge-map/write-hint.js";
import { getCachedMap } from "@pathrule/core/knowledge-map/cache.js";

const ledger = createWriteHintLedger();

/** `{ related_to_check }` when a cached map knows strong neighbours of the item, else `{}`. */
export function relatedToCheckField(workspaceId: string, itemId: string): { related_to_check?: RelatedToCheck[] } {
  const hint = ledger(workspaceId, itemId, getCachedMap(workspaceId));
  return hint.length > 0 ? { related_to_check: hint } : {};
}
