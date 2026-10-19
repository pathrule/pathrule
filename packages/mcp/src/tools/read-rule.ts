// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { readRuleHandler } from "@pathrule/core/tools/rules.js";
// Deep import: the ledger does node:fs IO, so it is deliberately not in the shared
// barrel — that barrel is also loaded by browser bundles.
import { cacheGet, cachePut } from "../cache.js";
import { resolveContext } from "./helpers.js";
import { recordExplicitRead } from "../lib/delivery.js";
import { formatThrown, formatToolError } from "../errors.js";
import { compactRule, type CompactRule } from "../lib/read-compact.js";
import type { ToolDef } from "./types.js";

export const readRuleTool: ToolDef<{ rule_id?: string; id?: string }> = {
  name: "pathrule_read_rule",
  title: "Read Rule",
  description:
    "Return a single rule. Response is flat (no wrapper): id, name, content, node_path, scope_type, priority, version_id, updated_at. Rules are constraints — obey them in your subsequent code. version_id is the optimistic concurrency token for pathrule_update_rule. Legacy response.rule.* wrapper removed in M14.",
  inputSchema: {
    rule_id: z.string().uuid().optional().describe("Rule UUID."),
    // Agents read "(id: …)" in the hook's lines and pass `id`; refusing it cost a retry step (measured 2026-10-15).
    id: z.string().uuid().optional().describe("Same as rule_id."),
  },
  handler: async (args) => {
    const ruleId = args.rule_id ?? args.id;
    if (!ruleId) return formatToolError({ code: "invalid_args", message: "Pass rule_id (the rule's UUID)." });
    try {
      const ctx = await resolveContext();
      const key = { workspaceId: "__by_id__", kind: "rule" as const, id: ruleId };
      const cached = await cacheGet<CompactRule>(key);
      if (cached) {
        void recordExplicitRead(ctx.workspaceId, "rule", cached, "pathrule_read_rule");
        return { ok: true, ...cached, cache_hit: true };
      }

      const result = await readRuleHandler(ctx, { rule_id: ruleId });
      if (!result.ok) return formatToolError(result.error);
      const compact = compactRule(result.data);
      await cachePut(key, compact);
      void recordExplicitRead(ctx.workspaceId, "rule", compact, "pathrule_read_rule");
      return { ok: true, ...compact };
    } catch (e) {
      return formatThrown(e);
    }
  },
};
