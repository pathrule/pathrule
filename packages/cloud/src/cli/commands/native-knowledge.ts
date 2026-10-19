// SPDX-License-Identifier: Apache-2.0
// `pathrule sync`, `repair`, `search`, `memory`, `rule`, `skill` and `refresh` on Pathrule Cloud: the
// open CLI's own pipelines (local/sync-local.ts, local/content-local.ts) run over the attached
// folder's Project backend on the Worker instead of the local store. The hook index is written by the
// open writer over that backend.
import type { KnowledgeBackend } from "@pathrule/core";
import { runtimeEventsHandler } from "@pathrule/core/tools/runtime-events.js";
import { folderConflictMessage } from "@pathrule/core/workspace/folder-mode.js";
import {
  parseEventsArgs,
  readLocalRuntimeEvents,
  type EventsOutcome,
} from "@pathrule/cli/commands/instrument.js";
import { parseContentOptions, renderContentRows } from "@pathrule/cli/content-options.js";
import type { CliContentKind } from "@pathrule/cli/content-helpers.js";
import {
  listLocalContent,
  readLocalContent,
  searchLocalContent,
} from "@pathrule/cli/local/content-local.js";
import { syncLocalWorkspace, type LocalSyncResult } from "@pathrule/cli/local/sync-local.js";
import type { CliCommandContext, CliRuntime } from "@pathrule/cli/plugin.js";
import { RULE_CHECK_SUBCOMMANDS, runRuleChecks } from "@pathrule/cli/commands/rule-checks.js";
import { syncHookIndex } from "@pathrule/integrations/index-writers/hook-index-writer.js";

import { folderModeHere } from "../../native/auto-attach.js";
import { CloudHttpError } from "../../native/client/http.js";
import type { NativeWorkspaceEntry } from "../../native/workspaces.js";
import {
  attachedHere,
  NativeCommandError,
  nativeSession,
  type NativeOutcome,
  type NativeSessionContext,
} from "./native-commands.js";

/** The attached folder's Project backend on the Worker, bound to the signed-in person. */
async function projectOf(
  session: NativeSessionContext,
  served: NativeWorkspaceEntry,
): Promise<KnowledgeBackend> {
  const ctx = await session.runtime.projectAccount.resolveContext({
    workspaceId: served.workspace_id,
    cwd: served.root,
  });
  if (!ctx?.backend)
    throw new NativeCommandError(
      "workspace_unavailable",
      `Workspace "${served.name}" is not available to you on Pathrule Cloud (archived, deleted, or your access changed).`,
      [{ label: "Attach another", command: "pathrule attach <workspace>" }],
    );
  return ctx.backend;
}

/**
 * `pathrule instrument events` with an account, routed by the edition that serves the folder (core's
 * resolveFolderMode): a Pathrule Local folder reads its Local workspace as the open CLI does, a
 * Pathrule Cloud folder reads its Cloud workspace's groups. A Cloud folder that cannot be read
 * (signed out, not attached, no access, unreachable) is an error that says what to do, never a
 * Local answer, whatever Local store exists there; a folder in conflict asks the person to choose.
 */
export async function readRuntimeEventsHere(
  ctx: CliCommandContext,
  args: readonly string[],
): Promise<EventsOutcome> {
  let query: ReturnType<typeof parseEventsArgs>;
  try {
    query = parseEventsArgs(args);
  } catch (err) {
    return { ok: false, code: "usage", message: (err as Error).message, exitCode: 64 };
  }
  const folder = folderModeHere(ctx.runtime.cwd, ctx.runtime.env);
  if (folder.mode === null)
    return {
      ok: false,
      code: "folder_conflict",
      message: folderConflictMessage(folder.conflict!),
      exitCode: 1,
    };
  if (folder.mode === "local") return readLocalRuntimeEvents(ctx, args);
  try {
    const session = await nativeSession(ctx.runtime);
    const served = await attachedHere(session, ctx.runtime);
    const backend = await projectOf(session, served);
    const result = await runtimeEventsHandler(
      { backend, userId: session.userId, workspaceId: served.workspace_id },
      { ...query, workspace_id: served.workspace_id },
    );
    if (!result.ok)
      return { ok: false, code: result.error.code, message: result.error.message, exitCode: 1 };
    return { ok: true, workspaceId: served.workspace_id, view: result.data };
  } catch (err) {
    return { ok: false, ...cloudFolderFailure(err), exitCode: 1 };
  }
}

/** Why a Pathrule Cloud folder's events could not be read, with the step that resolves it. */
function cloudFolderFailure(err: unknown): { code: string; message: string } {
  const withNext = (message: string, next?: string) =>
    next ? `${message} Next: ${next}` : message;
  if (err instanceof NativeCommandError) {
    if (err.code === "not_authenticated")
      return {
        code: "not_signed_in",
        message: withNext(
          "This folder uses Pathrule Cloud, and Pathrule CLI is not signed in.",
          "pathrule login",
        ),
      };
    if (err.code === "workspace_unavailable") return { code: "no_access", message: err.message };
    const next = err.next?.[0];
    return { code: err.code, message: withNext(err.message, next?.command ?? next?.url) };
  }
  if (err instanceof CloudHttpError) {
    if (err.status === 401)
      return {
        code: "not_signed_in",
        message: withNext(
          "This folder uses Pathrule Cloud, and your Pathrule Cloud session ended.",
          "pathrule login",
        ),
      };
    if (err.status === 403 || err.status === 404)
      return {
        code: "no_access",
        message: `Pathrule Cloud refused this folder's workspace: ${err.message}.`,
      };
    if (err.status === 402 || err.status === 429)
      return {
        code: "limit_reached",
        message: withNext(`Pathrule Cloud's limit is reached: ${err.message}.`, "pathrule billing"),
      };
    return {
      code: "cloud_unreachable",
      message: `Pathrule Cloud answered ${err.status}: ${err.message}.`,
    };
  }
  return {
    code: "cloud_unreachable",
    message: `Pathrule Cloud did not answer: ${err instanceof Error ? err.message : String(err)}.`,
  };
}

/** The engine's personal entries need an installed engine; without one the index is the Project's. */

/** Writes the companion files and the hook index of the attached folder serving `cli.cwd`. */
export async function nativeSync(
  cli: CliRuntime,
  session: NativeSessionContext,
): Promise<NativeOutcome> {
  const served = await attachedHere(session, cli);
  const backend = await projectOf(session, served);
  const result: LocalSyncResult = await syncLocalWorkspace(
    cli.env,
    served.root,
    served.workspace_id,
    {
      store: {
        backend,
        workspaceName: served.name,
        userId: session.userId,
        writeHookIndex: (decision) =>
          syncHookIndex({
            backend,
            workspaceId: served.workspace_id,
            workspaceRoot: served.root,
            env: cli.env,
            refreshEpisodes: false,
            ...decision,
          }),
      },
    },
  );
  return {
    data: result,
    exitCode: result.ok ? 0 : 1,
    lines: [
      result.ok
        ? `Synced "${served.name}": ${result.companion.written} companion file(s) written, ${result.companion.skipped} skipped; hook index ${result.hook_index.ok ? "updated" : "skipped"}.`
        : `Sync of "${served.name}" did not finish: ${result.error ?? "sync_failed"}.`,
      ...result.files.errors.map((e) => `- ${e.path}: ${e.message}`),
      ...result.companion.errors.map((e) => `- ${e.path}: ${e.message}`),
      ...(result.hook_index.error ? [`- hook index: ${result.hook_index.error}`] : []),
    ],
  };
}

async function content(
  ctx: CliCommandContext,
  session: NativeSessionContext,
  kind: CliContentKind,
): Promise<NativeOutcome> {
  const served = await attachedHere(session, ctx.runtime);
  const store = { backend: await projectOf(session, served), workspaceId: served.workspace_id };
  const sub = ctx.args[0] ?? "list";
  if (kind === "rule" && RULE_CHECK_SUBCOMMANDS.has(sub)) {
    // A decision on a check is a person's, at a terminal: it prints its own lines.
    if (ctx.mode.json)
      throw new NativeCommandError("not_available_json", `pathrule rule ${sub} runs for a person at a terminal, without --json.`);
    const exitCode = await runRuleChecks(sub, ctx.args.slice(1), ctx.runtime, ctx.mode, {
      ...store,
      root: served.root,
      userId: session.userId,
    });
    return { lines: [], exitCode };
  }
  const options = parseContentOptions(ctx.args.slice(1));
  if (sub === "add")
    throw new NativeCommandError(
      "not_on_pathrule_cloud",
      `Adding a ${kind} from the CLI is not available on Pathrule Cloud: your AI agent writes ${kind}s through the MCP server, and the console shows them.`,
    );
  if (sub === "read") {
    const selector = options.positionals[0];
    if (!selector)
      throw new NativeCommandError(
        `${kind}_selector_required`,
        `Name the ${kind}: pathrule ${kind} read <title-or-id>`,
      );
    const item = await readLocalContent(
      kind,
      selector,
      ctx.runtime.cwd,
      ctx.runtime.env,
      store,
    ).catch((err: unknown) => {
      if (err instanceof Error && err.message === `${kind}_not_found`)
        throw new NativeCommandError(
          `${kind}_not_found`,
          `No ${kind} "${selector}" in "${served.name}".`,
        );
      throw err;
    });
    return { data: item, lines: [item.title, item.path ?? "/", "", item.content] };
  }
  if (sub !== "list")
    throw new NativeCommandError(
      "unknown_subcommand",
      `Unknown ${kind} command: ${sub}. Use list or read.`,
    );
  const items = await listLocalContent(
    kind,
    ctx.runtime.cwd,
    ctx.runtime.env,
    { path: options.path, limit: options.limit },
    store,
  );
  return {
    data: { items },
    lines: [],
    render: (stdout, mode) => renderContentRows(stdout, mode, items),
  };
}

async function search(
  ctx: CliCommandContext,
  session: NativeSessionContext,
): Promise<NativeOutcome> {
  const served = await attachedHere(session, ctx.runtime);
  const store = { backend: await projectOf(session, served), workspaceId: served.workspace_id };
  const options = parseContentOptions(ctx.args);
  const query = options.positionals.join(" ");
  if (!query.trim())
    throw new NativeCommandError(
      "search_query_required",
      "Say what to search for: pathrule search <words>",
    );
  const items = await searchLocalContent(
    query,
    ctx.runtime.cwd,
    ctx.runtime.env,
    { types: options.types, path: options.path, limit: options.limit },
    store,
  );
  return {
    data: { query, items },
    lines: [],
    render: (stdout, mode) => renderContentRows(stdout, mode, items),
  };
}

async function refresh(
  ctx: CliCommandContext,
  session: NativeSessionContext,
): Promise<NativeOutcome> {
  const sub = ctx.args[0] ?? "list";
  if (sub !== "list")
    throw new NativeCommandError(
      "not_on_pathrule_cloud",
      `pathrule refresh ${sub} is not available on Pathrule Cloud from the CLI: your agent claims and resolves refresh tasks through the MCP server.`,
    );
  const served = await attachedHere(session, ctx.runtime);
  const pending = await (
    await projectOf(session, served)
  ).listPendingRefreshes(served.workspace_id);
  return {
    data: { workspace_id: served.workspace_id, refreshes: pending },
    lines: pending.length
      ? [
          `${pending.length} refresh task(s) in "${served.name}":`,
          ...pending.map(
            (r) =>
              `- ${r.subjectType} "${r.subjectTitle}" at ${r.nodePath}: ${r.humanReason} (${r.status})`,
          ),
        ]
      : [`No refresh tasks in "${served.name}".`],
  };
}

/** The knowledge command `ctx.command` on Pathrule Cloud, or null when it is not one. */
export async function runNativeKnowledgeCommand(
  ctx: CliCommandContext,
  session: NativeSessionContext,
): Promise<NativeOutcome | null> {
  switch (ctx.command) {
    case "sync":
    case "repair":
      return nativeSync(ctx.runtime, session);
    case "search":
      return search(ctx, session);
    case "memory":
    case "rule":
    case "skill":
      return content(ctx, session, ctx.command);
    case "refresh":
      return refresh(ctx, session);
    default:
      return null;
  }
}
