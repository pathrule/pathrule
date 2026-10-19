// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { requestRefreshHandler } from "@pathrule/core/tools/refreshes.js";
import { resolveContext } from "./helpers.js";
import { formatThrown, formatToolError } from "../errors.js";
import type { ToolDef } from "./types.js";

interface Args {
  subject_type: "memory" | "rule";
  subject_id: string;
  reason: string;
  kind?: "drift" | "contradicts_code" | "duplicate" | "too_narrow" | "unclear";
}

export const requestRefreshTool: ToolDef<Args> = {
  name: "pathrule_request_refresh",
  title: "Flag a stale memory or rule for refresh",
  description:
    "Call this when you notice that an existing memory or rule has drifted from the current codebase, contradicts what you just read, or is too narrow/unclear to be useful. Pathrule files the flag as a pending refresh task in the queue `pathrule_list_pending_refreshes` reads from, where a later session picks it up. Idempotent: flagging the same subject twice returns the same refresh id. Use sparingly — only when you actually noticed the drift in your normal work, not as a fishing exercise.",
  inputSchema: {
    subject_type: z
      .enum(["memory", "rule"])
      .describe("Whether you're flagging a memory or a rule."),
    subject_id: z
      .string()
      .uuid()
      .describe(
        "UUID of the memory or rule. Get it from `pathrule_get_context` candidate ids, the read tools, or list_memories.",
      ),
    reason: z
      .string()
      .min(1)
      .max(500)
      .describe(
        "One short sentence saying what drifted, read by the session that picks up the task, e.g. 'Migration file mentioned no longer exists in the repo' or 'The body says useAuth.ts but the hook moved to useSession.ts'.",
      ),
    kind: z
      .enum(["drift", "contradicts_code", "duplicate", "too_narrow", "unclear"])
      .optional()
      .describe(
        "Optional category. 'drift' (default): subject describes a state that no longer matches the code. 'contradicts_code': subject says X but code clearly does Y. 'duplicate': another memory/rule covers the same ground better. 'too_narrow': only applies to a long-gone case. 'unclear': you couldn't tell what action it asks for.",
      ),
  },
  handler: async (args) => {
    try {
      const ctx = await resolveContext();
      const result = await requestRefreshHandler(ctx, {
        subject_type: args.subject_type,
        subject_id: args.subject_id,
        reason: args.reason,
        kind: args.kind,
      });
      if (!result.ok) return formatToolError(result.error);
      return {
        ok: true,
        refresh_id: result.data.refreshId,
        already_pending: result.data.alreadyPending,
        human_message: result.data.alreadyPending
          ? "An open refresh task already exists for this subject — id returned unchanged."
          : "Refresh task filed; it waits in the refresh queue for a later session.",
      };
    } catch (e) {
      return formatThrown(e);
    }
  },
};
