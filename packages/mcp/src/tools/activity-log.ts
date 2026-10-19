// SPDX-License-Identifier: Apache-2.0
// MCP tool wrapper for pathrule_log_activity, with the session's tool-call counters
// and what the hook delivered attached at the activity boundary.

import { z } from "zod";
import { pathruleHome } from "@pathrule/core/storage/paths.js";
import {
  activityCharCount,
  TASK_SUMMARY_HARD_MAX_CHARS,
  TASK_SUMMARY_TARGET_CHARS,
  VALID_ACTIONS,
  VALID_AI_CLIENTS,
  VALID_DOMAINS,
  VALID_SCOPES,
  writeActivityLog,
  type ActivityAction,
  type ActivityDomain,
  type ActivityScope,
  type AiClient,
} from "@pathrule/core/tools/activity-log.js";
import { normalizeFilesTouched } from "@pathrule/protocol/normalize-workspace-path.js";
import { resolveContext } from "./helpers.js";
import { getLocalBackend, isProjectContext } from "../local-runtime.js";
import { join as joinPath } from "node:path";
import { formatThrown, formatToolError } from "../errors.js";
import type { ToolDef } from "./types.js";

interface Args {
  workspace_id?: string;
  cwd?: string;
  node_path?: string;
  domain: string;
  action: string;
  scope: string;
  subjects?: string[];
  task_summary: string;
  files_touched?: { total?: number; by_area?: Record<string, string[]> };
  ai_client?: string;
  session_id?: string;
  applied_memory_ids?: string[];
  verbose?: boolean;
}

export const logActivityTool: ToolDef<Args> = {
  name: "pathrule_log_activity",
  title: "Log Activity",
  description:
    "Log a file-modifying response with structured taxonomy and file paths. " +
    "Call this AFTER every response where you created, edited, or deleted " +
    "files. One call per response, not per file. Skip only for trivial " +
    "changes (whitespace-only, single comment). Files ≤10: list full paths. " +
    "Files >10: group by directory + list key files only. " +
    "Pass either `workspace_id` (UUID; taken from your UserPromptSubmit " +
    "hook session metadata) OR `cwd` (absolute working directory — the " +
    "server resolves it to the workspace) — one is enough, not both. " +
    "`task_summary` should be ONE concise sentence, ideally ≤300 characters. " +
    "This call is NEVER rejected for length: anything past ~500 chars is stored " +
    "auto-shortened, you get a non-blocking warning, not an error — so do not " +
    "retry or rewrite to satisfy a limit. Default response is compact " +
    "(`{ id, created_at, human_message }`); pass `verbose: true` to get the " +
    "full activity row back.",
  inputSchema: {
    workspace_id: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Workspace UUID. If omitted, pass `cwd` instead and the server will " +
          "resolve it. The hook supervisor exposes this UUID in its " +
          "UserPromptSubmit session metadata so you rarely need to fetch it.",
      ),
    cwd: z
      .string()
      .optional()
      .describe(
        "Absolute working directory — server resolves to workspace_id via " +
          "user_workspace_paths. Use this when workspace_id is unknown " +
          "(e.g. first call of a fresh session, hook metadata missing).",
      ),
    node_path: z
      .string()
      .optional()
      .default("/")
      .describe(
        "Workspace-relative path, e.g. '/packages/app'. Targets the most " +
          "specific node the activity belongs to.",
      ),
    domain: z
      .enum(VALID_DOMAINS)
      .describe("What area: ui, backend, database, infra, config, test, docs"),
    action: z
      .enum(VALID_ACTIONS)
      .describe("What was done: create, update, fix, refactor, delete, style"),
    scope: z
      .enum(VALID_SCOPES)
      .describe(
        "What kind of thing: component, page, hook, store, api, migration, " +
          "service, model, util, project",
      ),
    subjects: z
      .array(z.string())
      .optional()
      .default([])
      .describe(
        "Free-form keywords, lowercase. E.g. ['sidebar', 'resize-handle']. " +
          "Only the first 5 are stored; extras are dropped, never rejected.",
      ),
    task_summary: z
      .string()
      .describe(
        "One concise sentence describing the completed work. Ideal: ≤300 " +
          "characters. NEVER rejected for length: anything past ~500 chars is " +
          "stored auto-shortened with a non-blocking warning, so do not retry " +
          "or rewrite to fit a limit. Keep it tight: what changed + why, no file " +
          "paths (those go in `files_touched`) and no bullet lists. If the work " +
          "is complex, compress to the essential decision: extra detail belongs " +
          "in memories, not activity logs.",
      ),
    // Tolerant by contract (see the "never hard-reject" activity-log memory): the
    // fields are optional and the whole thing `.catch`es to undefined, so a missing
    // or malformed value NEVER surfaces a Zod InvalidParams error (that is what the
    // model reads as "fix args and retry" — the multi-minute retry-loop hang). The
    // writer clamps undefined to an empty map.
    files_touched: z
      .object({
        total: z.number().optional(),
        by_area: z.record(z.array(z.string())).optional(),
      })
      .optional()
      .catch(undefined)
      .describe("Files involved (optional). ≤10: full paths per area. >10: directory summaries."),
    ai_client: z.enum(VALID_AI_CLIENTS).optional(),
    session_id: z
      .string()
      .optional()
      .describe(
        "Hook session_id from UserPromptSubmit metadata. When provided, the server " +
          "drains the in-process PostToolUse buffer for this session and attaches " +
          "tool_call_count / tool_failure_count / tool_failure_codes to this activity row.",
      ),
    applied_memory_ids: z
      .array(z.string().uuid())
      .optional()
      .describe(
        "Optional. Memory ids you actually read and applied this turn. Pathrule uses " +
          "this as a direct positive signal for the memory affinity model (M42) — only " +
          "list memories whose content you genuinely consulted, not every id you saw in " +
          "get_context. Requires session_id and a recent context_injection in the same " +
          "session within the last 30 minutes; otherwise silently dropped.",
      ),
    verbose: z
      .boolean()
      .optional()
      .describe(
        "Set to true to receive the full activity row in the response. Default false (compact response).",
      ),
  },
  handler: async (args) => {
    try {
      // Resolve workspace_id from cwd when the caller didn't provide one.
      // The hook supervisor exposes the UUID in its UserPromptSubmit metadata,
      // but if Claude skipped that signal we fall back to cwd → workspace lookup.
      let workspaceId = args.workspace_id;
      const ctx = await resolveContext(workspaceId);
      // The activity write runs on ctx.backend, so logging works offline.

      if (!workspaceId) {
        const cwd = args.cwd ?? process.cwd();
        const match = (await ctx.backend?.resolveWorkspaceFromCwd(cwd)) ?? null;
        if (!match) {
          return formatToolError({
            code: "invalid_args",
            message: `Could not resolve workspace_id — neither workspace_id nor a workspace-matching cwd was provided. cwd="${cwd}" did not match any user_workspace_paths row. Pass workspace_id (from UserPromptSubmit hook metadata) or an absolute cwd inside a bound workspace.`,
          });
        }
        workspaceId = match.workspaceId;
      }

      // M19f — Stamp the originating client server-side. Precedence:
      //   1. Explicit `ai_client` arg (LLM override; rare)
      //   2. `ctx.clientId` from the MCP transport handshake
      //   3. `claude-code` as the legacy default (back-compat)
      const aiClient: AiClient =
        (args.ai_client as AiClient | undefined) ??
        (ctx.clientId as AiClient | null) ??
        "claude-code";

      // Normalize files_touched paths to canonical workspace-relative form.
      // Resolve workspace root: prefer the localRootPath from workspace-matcher
      // (available when cwd was passed). Fall back to workspaces.relative_path_root
      // (a sub-path anchor stored in the DB, default '/').
      let workspaceRoot = "";
      {
        const cwd = args.cwd ?? null;
        if (cwd) {
          const match = (await ctx.backend?.resolveWorkspaceFromCwd(cwd)) ?? null;
          if (match) workspaceRoot = match.localRootPath;
        }
      }
      const { normalized: normalizedFiles, dropped: droppedCounts } = normalizeFilesTouched(
        args.files_touched,
        workspaceRoot,
      );
      // Log drop counts at debug level when any paths were dropped.
      if (Object.keys(droppedCounts).length > 0) {
        console.debug("[m43] files_touched paths dropped by normalizer:", droppedCounts);
      }

      const taskSummaryChars = activityCharCount(args.task_summary);
      const summaryOverTarget = taskSummaryChars > TASK_SUMMARY_TARGET_CHARS;
      const summaryClamped = taskSummaryChars > TASK_SUMMARY_HARD_MAX_CHARS;
      const summaryWarning = summaryOverTarget
        ? ` Note: task_summary was ${taskSummaryChars} chars; keep future summaries ≤${TASK_SUMMARY_TARGET_CHARS}.${
            summaryClamped ? ` It was stored auto-shortened to ${TASK_SUMMARY_HARD_MAX_CHARS} chars (not an error, no retry needed).` : ""
          }`
        : "";

      // Drain the session's PostToolUse outcomes at the activity boundary.
      //
      // Two steps, and the first one is load-bearing: the hook records outcomes from
      // a SEPARATE, short-lived process per event, so it appends them to disk. Without
      // the ingest, flushSession reads an in-memory buffer that has no writer at all —
      // which is exactly why tool_call_count was 0 on every activity row for months.
      //
      // flushSession then returns null when there is genuinely nothing to report (a
      // client running no hooks, or no drainable session).
      //
      // TWO KEYS, ON PURPOSE. `drainSessionId` addresses a FILE on this machine
      // (tool-outcomes/<id>.jsonl, written by the hook under its own session uuid).
      // `rowSessionId` is what the activity row stores, and that one is a DB JOIN key:
      // the store's BEFORE trigger stamps `<workspace>:<user>` when it is NULL, which is
      // the shape the captured injections use. Stamping the hook uuid there instead
      // would silence that join. So the drain key is resolved from disk and never
      // written to the row; only an explicitly passed session_id sets both.
      const rowSessionId = args.session_id ?? null;
      // V30 - drain the hook's local knowledge-observations ledger into categorical outcome
      // evidence. This is the live production seam: a real agent tool action captured by the hook
      // becomes attribution here, with no runtime model call. Local only, because observeToolEvent
      // is a LocalBackend method kept off the cloud-sync surface; best-effort so a bad line or a
      // locked file never fails activity logging.
      if (workspaceId && !isProjectContext(ctx)) {
        try {
          const obsFile = joinPath(pathruleHome(), "cache", workspaceId, "knowledge-observations.jsonl");
          await (await getLocalBackend(workspaceId)).ingestObservationsFromDisk(workspaceId, obsFile);
        } catch {
          // observation drain is advisory; never block the activity write on it.
        }
      }

      const row = await writeActivityLog(ctx, {
        workspaceId,
        nodePath: args.node_path ?? "/",
        domain: args.domain as ActivityDomain,
        action: args.action as ActivityAction,
        scope: args.scope as ActivityScope,
        subjects: args.subjects ?? [],
        taskSummary: args.task_summary,
        filesTouched: normalizedFiles,
        provenance: {
          version: 1, summarySource: "agent_authored", filesSource: "agent_reported",
          observedFileCount: normalizedFiles.total, storedFileCount: normalizedFiles.total,
          filesTruncated: Object.keys(droppedCounts).length > 0, outcome: "unknown",
        },
        aiClient,
        sessionId: rowSessionId ?? undefined,
        appliedMemoryIds: args.applied_memory_ids,
      });

      // Echo the STORED (clamped) summary so an oversized raw input never bloats the response.
      const human_message = `Activity logged: [${args.domain}/${args.action}] ${row.task_summary}${summaryWarning}`;
      return args.verbose
        ? {
            ok: true,
            activity: row,
            human_message,
            summary_over_target: summaryOverTarget,
            task_summary_chars: taskSummaryChars,
            task_summary_target_chars: TASK_SUMMARY_TARGET_CHARS,
            task_summary_hard_max_chars: TASK_SUMMARY_HARD_MAX_CHARS,
          }
        : {
            ok: true,
            id: row.id,
            created_at: row.created_at,
            human_message,
            summary_over_target: summaryOverTarget,
            task_summary_chars: taskSummaryChars,
            task_summary_target_chars: TASK_SUMMARY_TARGET_CHARS,
            task_summary_hard_max_chars: TASK_SUMMARY_HARD_MAX_CHARS,
          };
    } catch (e) {
      return formatThrown(e);
    }
  },
};
