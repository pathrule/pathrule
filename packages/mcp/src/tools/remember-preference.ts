// SPDX-License-Identifier: Apache-2.0
/**
 * pathrule_remember_preference: how the PERSON works, kept with the person, not with the project.
 *
 * A project decision ("refunds show as İade") is workspace knowledge and goes to write_memory. A way
 * of working that belongs to the person ("I want a one-line comment on every exported function",
 * "answer me in Turkish") goes here: grounded in their own words, private to them, and active only
 * once they say it again in another session (`core/user-knowledge/user-knowledge-capture.ts`).
 * An account's store when one is bound (Cloud data stays in Cloud), else the local person's file.
 */
import { z } from "zod";
import { join } from "node:path";
import { localRuntimePaths } from "@pathrule/core/storage/paths.js";
import { userKnowledgeStoreFor } from "@pathrule/core/user-knowledge/user-knowledge-store.js";
import { captureUserPreference, readUserWords, trimUserWords } from "@pathrule/core/user-knowledge/user-knowledge-capture.js";
import { isProjectContext } from "../local-runtime.js";
import { mcpPersonalAccount } from "../plugin.js";
import { rerenderClaudeMdAfterWrite, resolveWorkspaceTarget } from "./helpers.js";
import { formatThrown, formatToolError } from "../errors.js";
import type { ToolDef } from "./types.js";

interface Args {
  workspace_id?: string;
  cwd?: string;
  kind: "selection" | "procedure" | "context";
  claim: string;
  quotes: string[];
  when?: string[];
  same_as?: string;
  always?: boolean;
  lasting?: boolean;
}

export const rememberPreferenceTool: ToolDef<Args> = {
  name: "pathrule_remember_preference",
  title: "Remember Preference",
  description:
    "Remember how the USER prefers to work (style, process, communication), as opposed to a project decision (use write_memory for those). Quote the user's own words verbatim from their message. A preference the user states as lasting (`lasting`) is active in this workspace at once; any other becomes active once the user states it in a second session. The result lists stored candidates, and `same_as` links a repeat to one.",
  inputSchema: {
    workspace_id: z.string().uuid().optional().describe("Workspace UUID, or pass cwd."),
    cwd: z.string().optional().describe("Absolute working directory, to resolve the workspace."),
    kind: z.enum(["selection", "procedure", "context"]).describe("selection = prefers A over B; procedure = how they like work done in steps; context = a fact about how they work."),
    claim: z.string().min(1).max(280).describe("The preference in one sentence, for the next agent."),
    quotes: z.array(z.string().min(1)).min(1).max(4).describe("Verbatim spans of the user's own words."),
    when: z.array(z.string().min(1)).max(2).optional().describe("Verbatim spans naming a NARROWER kind of work it applies to (\"for database migrations\"). Omit for a habit that covers all their work."),
    always: z.boolean().optional().describe("true when the user says it holds for all the work they ask for (\"for any code you write for me\", \"always\"). Use instead of `when`."),
    lasting: z.boolean().optional().describe("true when the user stated it as a lasting way of working (\"a habit of mine\", \"from now on\"), not a remark about this task: it then applies in this workspace at once."),
    same_as: z.string().optional().describe("Id of a stored candidate this repeats."),
  },
  handler: async (args) => {
    try {
      const target = await resolveWorkspaceTarget(args);
      if (!target.ok) return formatToolError(target.error);
      const { ctx, workspaceId } = target;
      // Where the person's knowledge lives: an account's own store when one is bound here (Cloud data
      // stays in Cloud), else the local person's file. Never workspace knowledge, which a team shares.
      const bound = await mcpPersonalAccount()?.bind(workspaceId).catch(() => null);
      if (isProjectContext(ctx) && !bound?.userKnowledge) {
        return { ok: true, skipped: "no_personal_store", human_message: "No personal store is bound to this workspace; nothing was stored." };
      }
      const now = new Date().toISOString();
      const cacheDir = join(localRuntimePaths(process.env).home, "cache", workspaceId);
      trimUserWords(cacheDir);
      const words = readUserWords(cacheDir);
      const store = userKnowledgeStoreFor({ env: process.env, ...(bound ? { userId: bound.userId, userKnowledge: bound.userKnowledge } : {}) });
      const result = await captureUserPreference(store, args, { workspaceId, words, now });
      if (!result.ok) return { ok: false, code: result.code, human_message: result.message };
      if (result.status === "active") await rerenderClaudeMdAfterWrite(ctx, workspaceId);
      const human_message =
        result.status === "active"
          ? `Remembered: "${args.claim}" is now part of how agents work with this user.`
          : `Noted "${args.claim}" as a candidate preference; it becomes active if the user says it again in another session.`;
      return { ok: true, id: result.id, status: result.status, sessions: result.sessions, ...(result.candidates.length > 0 ? { other_candidates: result.candidates } : {}), human_message };
    } catch (e) {
      return formatThrown(e);
    }
  },
};
