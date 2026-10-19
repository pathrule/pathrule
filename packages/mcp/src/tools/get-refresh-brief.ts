// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { getRefreshBriefHandler } from "@pathrule/core/tools/refreshes.js";
import { resolveContext } from "./helpers.js";
import { formatThrown, formatToolError } from "../errors.js";
import type { ToolDef } from "./types.js";

interface Args {
  refresh_id: string;
  claimed_by?: string;
}

export const getRefreshBriefTool: ToolDef<Args> = {
  name: "pathrule_get_refresh_brief",
  title: "Get memory/rule refresh brief",
  description:
    "Claim a refresh task and return its full brief — subject body, plain-language reason, raw detection signals and AI instructions. Calling this transitions the task to status='in_progress' so other AI sessions don't double-claim it. After you apply the fix via `pathrule_update_memory`/`pathrule_update_rule` (pass `refresh_id` to auto-resolve) OR decide not to, call `pathrule_resolve_refresh`.",
  inputSchema: {
    refresh_id: z.string().uuid().describe("Refresh task UUID from pathrule_list_pending_refreshes."),
    claimed_by: z
      .string()
      .max(40)
      .optional()
      .describe("Optional — identify the AI client (e.g. 'claude-code', 'cursor', 'codex'). Written to the audit trail."),
  },
  handler: async (args) => {
    try {
      const ctx = await resolveContext();
      // M19f — Default claimed_by to the resolved transport client id so
      // the audit trail captures who picked up the refresh even when the
      // LLM forgot to pass the argument.
      const claimedBy = args.claimed_by ?? ctx.clientId ?? undefined;
      const result = await getRefreshBriefHandler(ctx, {
        refresh_id: args.refresh_id,
        claimed_by: claimedBy,
      });
      if (!result.ok) return formatToolError(result.error);
      const { brief, id, status, subjectType, subjectId, formulaId } = result.data;
      return {
        ok: true,
        refresh_id: id,
        status,
        subject: {
          type: subjectType,
          id: subjectId,
          title: brief.subject?.title ?? "",
          node_path: brief.subject?.nodePath ?? "/",
          body: brief.subject?.body ?? "",
        },
        signal: brief.signal ?? { formulaId, humanReason: formulaId, detectedAt: result.data.createdAt, rawSignals: {} },
        ai_instructions: brief.aiInstructions ?? "",
        proposed_patch: brief.proposedPatch ?? null,
        human_message: `Refresh ${id} claimed. Review the brief, apply fixes with pathrule_update_${subjectType} (include refresh_id=${id} to auto-resolve), then call pathrule_resolve_refresh.`,
      };
    } catch (e) {
      return formatThrown(e);
    }
  },
};
