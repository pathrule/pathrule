// SPDX-License-Identifier: Apache-2.0
// A folder's own binding to Pathrule Cloud: attaching it, detaching it, and `setup` / `init` for a
// Cloud folder (the workspace, the MCP entries, the Local knowledge copy, the sync). Every binding
// here follows the folder's edition (core workspace/folder-mode.ts): a Local folder or one in
// conflict is never attached, and leaving Cloud leaves nothing of the workspace usable here.
// The other account commands are in ./native-commands.ts.
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";

import { readCloudFolderBindings } from "@pathrule/core/workspace/folder-mode.js";
import { statusLabel } from "@pathrule/cli/output.js";
import type { CliCommandContext, CliRuntime, CliSetupPlan } from "@pathrule/cli/plugin.js";

import {
  folderConflictMessage,
  type FolderModeResolution,
} from "@pathrule/core/workspace/folder-mode.js";

import { autoAttachFolder, autoAttachLine, folderModeHere } from "../../native/auto-attach.js";
import {
  attachNativeWorkspace,
  clearDetachedFolder,
  clearDisplacedFolders,
  detachNativeWorkspace,
  nativeWorkspaceFor,
  readNativeWorkspaces,
  type NativeWorkspaceEntry,
} from "../../native/workspaces.js";
import {
  currentOrganization,
  NativeCloudError,
  organizations,
  workspacesOf,
  type NativeSessionContext,
  type NativeWorkspace,
} from "../../native/tenancy.js";
import { installSetupMcpEntries } from "../install.js";
import type { TransferBackend } from "../transfer/copy.js";
import { transferLocalKnowledge, type TransferOutcome } from "../transfer/step.js";
import { promptYesNo } from "./interaction.js";
import { failure, type NativeOutcome } from "./native-commands.js";

export async function attachHere(
  session: NativeSessionContext,
  cli: CliRuntime,
  workspace: NativeWorkspace,
): Promise<NativeOutcome> {
  const before = await readNativeWorkspaces(session.userId, cli.env);
  const entries = await attachNativeWorkspace(
    session.userId,
    {
      workspace_id: workspace.id,
      organization_id: workspace.organization_id,
      name: workspace.name,
      root: cli.cwd,
    },
    cli.env,
  );
  const attached = entries.find((e) => e.workspace_id === workspace.id)!;
  // Attaching can move the workspace from the folder it served, or this folder from its workspace:
  // what the displaced folder kept of it goes now (clearDisplacedFolders), and is said.
  const moved = (await clearDisplacedFolders(before, attached, cli.env)).flatMap(({ entry, cleared }) => [
    entry.root === attached.root
      ? `This folder no longer uses "${entry.name}": its Pathrule files went (${cleared.removed} removed, ${cleared.stripped} of yours cleaned).`
      : `"${workspace.name}" moved here from ${entry.root}: its Pathrule files there went (${cleared.removed} removed, ${cleared.stripped} of yours cleaned).`,
    ...cleared.unclear.map((u) => `- left as it is, check it yourself: ${join(entry.root, u.path)} (${u.reason})`),
  ]);
  return {
    data: {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        organization_id: workspace.organization_id,
      },
      root: attached.root,
    },
    lines: [`Attached ${attached.root} to workspace "${workspace.name}".`, ...moved],
    next: [
      { label: "Write the agent files and the hook index", command: "pathrule sync" },
      // Offered, never run: Local's activity leaves the machine only when its person asks.
      ...((await import("./activity-import.js")).hasLocalActivity(attached.root, cli.env)
        ? [
            {
              label: "Bring this folder's Local activity to Pathrule Cloud",
              command: "pathrule activity import --from-local",
            },
          ]
        : []),
    ],
  };
}

/** The refusal for a folder in conflict: it has both editions and no choice between them. */
export function conflictError(conflict: NonNullable<FolderModeResolution["conflict"]>): NativeCloudError {
  return new NativeCloudError("folder_conflict", folderConflictMessage(conflict), [
    { label: "Use Pathrule Cloud here", command: "pathrule setup --cloud" },
    { label: "Or Pathrule Local", command: "pathrule setup --local" },
  ]);
}

/** The refusal for a Pathrule Local folder asked for its Pathrule Cloud workspace. */
export function localFolderError(folder: FolderModeResolution): NativeCloudError {
  const where = folder.root ?? folder.cwd;
  const why =
    folder.source === "project"
      ? "is set to Pathrule Local"
      : folder.local
        ? "uses its Pathrule Local workspace"
        : "uses Pathrule Local, this machine's default";
  return new NativeCloudError(
    "folder_is_local",
    `${where} ${why}, so no Pathrule Cloud workspace serves it.`,
    [
      {
        label: "Move it to Pathrule Cloud (shows what changes first)",
        command: "pathrule setup --cloud",
      },
    ],
  );
}

/**
 * The attached folder serving the current directory, or the error that says what to do. Only a
 * Pathrule Cloud folder (core's resolveFolderMode) has one: a Local folder or one in conflict is
 * refused, never served from Cloud. A Cloud folder this machine served before from a workspace the
 * person can read is attached again, said on stderr (a --json run keeps its stdout); nothing else
 * binds a folder here (native/auto-attach.ts).
 */
export async function attachedHere(
  session: NativeSessionContext,
  cli: CliRuntime,
): Promise<NativeWorkspaceEntry> {
  const folder = folderModeHere(cli.cwd, cli.env);
  if (folder.mode === null) throw conflictError(folder.conflict!);
  if (folder.mode === "local") throw localFolderError(folder);
  const served = nativeWorkspaceFor(await readNativeWorkspaces(session.userId, cli.env), cli.cwd);
  if (served) return served;
  const restored = await autoAttachFolder({
    userId: session.userId,
    request: session.request,
    env: cli.env,
    cwd: cli.cwd,
  }).catch(() => null);
  if (restored) {
    cli.stderr.write(`${autoAttachLine(restored)} Undo: pathrule detach\n`);
    return restored.entry;
  }
  throw new NativeCloudError(
    "not_attached",
    "This folder uses Pathrule Cloud and is not attached to a Pathrule Cloud workspace.",
    [
      { label: "Attach it", command: "pathrule setup --cloud" },
      { label: "Or name the workspace", command: "pathrule attach <workspace>" },
    ],
  );
}

/**
 * Refuses to bind a folder that is not free to become a Pathrule Cloud folder by an attachment
 * alone: one in conflict, set to Pathrule Local, or served by a Pathrule Local workspace. Those move
 * with `pathrule setup --cloud`, which shows what changes first. A folder that only follows a Local
 * device default is free: the attachment makes it a Cloud folder, and the outcome says so.
 */
export function folderFreeForCloud(cli: CliRuntime): FolderModeResolution {
  const folder = folderModeHere(cli.cwd, cli.env);
  if (folder.mode === null) throw conflictError(folder.conflict!);
  if (folder.mode === "local" && folder.source !== "device-default") throw localFolderError(folder);
  return folder;
}

/**
 * `pathrule detach`: removes the attachment serving the folder, then what this machine kept of that
 * workspace (native/workspaces.ts clearDetachedFolder): its cache, and the knowledge rendered from
 * it into the folder when it served the folder. Says what went, in counts, and what serves the
 * folder now.
 */
export async function detach(cli: CliRuntime, session: NativeSessionContext): Promise<NativeOutcome> {
  const before = folderModeHere(cli.cwd, cli.env);
  const removed = await detachNativeWorkspace(session.userId, cli.cwd, cli.env);
  if (!removed)
    throw new NativeCloudError(
      "not_attached",
      "This folder is not attached to a Pathrule Cloud workspace.",
    );
  // A Local folder's rendered files are its Local knowledge: they stay. In a conflict nothing says
  // whose they are, so they go with the Cloud attachment, and `pathrule sync` renders Local again.
  const cleanup = await clearDetachedFolder(removed, cli.env, {
    knowledge: before.mode !== "local",
  });
  const after = folderModeHere(cli.cwd, cli.env);
  const { cache, knowledge } = cleanup;
  const lines = [
    `Detached ${removed.root} from Pathrule Cloud workspace "${removed.name}". Nothing was deleted on Pathrule Cloud.`,
    cache.kept
      ? `Kept this machine's cache of "${removed.name}": ${cache.kept}.`
      : `Removed ${cache.removed} cached item(s) of "${removed.name}" from this machine.`,
  ];
  if (before.mode !== "local")
    lines.push(
      `Removed ${knowledge.removed} Pathrule knowledge file(s) from ${removed.root}` +
        (knowledge.stripped > 0
          ? `, and Pathrule's block from ${knowledge.stripped} file(s) of yours, which stay.`
          : "."),
    );
  lines.push(...knowledge.errors.map((e) => `- not removed: ${e}`));
  lines.push(...knowledge.unclear.map((u) => `- left as it is, check it yourself: ${u.path} (${u.reason})`));
  if (after.mode === "local" && after.local)
    lines.push(
      "This folder uses its Pathrule Local workspace again: `pathrule sync` renders its Local knowledge.",
    );
  else if (after.mode === "local")
    lines.push(
      "This folder now uses Pathrule Local, which has no workspace here yet: `pathrule setup --local` creates one.",
    );
  else if (after.mode === "cloud" && !after.cloud)
    lines.push(
      "This folder still uses Pathrule Cloud and has no workspace now: attach one with `pathrule setup --cloud`, or move it to Pathrule Local with `pathrule setup --local`.",
    );
  else if (after.mode === null) lines.push(folderConflictMessage(after.conflict!));
  return {
    data: {
      ...removed,
      removed: {
        cache_items: cache.removed,
        cache_kept: cache.kept,
        knowledge_files: knowledge.removed,
        stripped_files: knowledge.stripped,
        unclear_files: knowledge.unclear,
        errors: knowledge.errors,
      },
      folder_mode: after.mode,
    },
    lines,
    exitCode: knowledge.errors.length > 0 ? 1 : 0,
  };
}

export async function create(
  cli: CliRuntime,
  session: NativeSessionContext,
  name: string,
): Promise<NativeOutcome> {
  const current = await currentOrganization(session, cli.env, true);
  const created = await session.request<NativeWorkspace>(
    `/v1/organizations/${encodeURIComponent(current!.id)}/workspaces`,
    { name },
    "POST",
    randomUUID(),
  );
  const attached = await attachHere(session, cli, created);
  return {
    ...attached,
    lines: [`Created workspace "${created.name}" in "${current!.name}".`, ...attached.lines],
  };
}

/** What `init` and `setup` settled about the folder's workspace (their `--json` data). */
export interface InitData {
  workspace: { id: string; name: string; organization_id: string };
  root: string;
  action: "existing" | "attached" | "created";
}

/**
 * The one workspace in the person's organizations named `wanted` (case and surrounding spaces
 * aside) that no folder on this machine is attached to; null when there is none, or more than one.
 */
export async function sameNameWorkspace(
  session: NativeSessionContext,
  env: NodeJS.ProcessEnv,
  wanted: string,
  attached: readonly NativeWorkspaceEntry[],
): Promise<{ workspace: NativeWorkspace; organization: string } | null> {
  const key = wanted.trim().toLowerCase();
  const found: { workspace: NativeWorkspace; organization: string }[] = [];
  for (const org of await organizations(session.request))
    for (const w of await workspacesOf(session.request, org.id))
      if (w.name.trim().toLowerCase() === key)
        found.push({
          workspace: { ...w, organization_id: w.organization_id ?? org.id },
          organization: org.name,
        });
  if (found.length !== 1) return null;
  const id = found[0]!.workspace.id;
  // Any person's attachment on this machine counts: one workspace serves one folder.
  const elsewhere =
    attached.some((e) => e.workspace_id === id) ||
    readCloudFolderBindings(env).some((b) => b.workspaceId === id);
  return elsewhere ? null : found[0]!;
}

/**
 * `pathrule init [name]` and `setup`: the folder's workspace on Pathrule Cloud.
 *
 * - A workspace attached at this folder is used.
 * - Else the one workspace of the wanted name (`name`, or the folder's) in the person's organizations
 *   that no folder here is attached to is attached, and a line says so. These two commands are the
 *   only place an existing workspace is bound without `pathrule attach`: the person asked for a
 *   workspace for this folder, and the line names which one and how to undo it.
 * - Else one is created in the current organization.
 */
export async function nativeInit(
  cli: CliRuntime,
  session: NativeSessionContext,
  name?: string,
): Promise<NativeOutcome> {
  const entries = await readNativeWorkspaces(session.userId, cli.env);
  const served = nativeWorkspaceFor(entries, cli.cwd);
  if (served && (!name || served.name === name)) {
    const data: InitData = {
      workspace: {
        id: served.workspace_id,
        name: served.name,
        organization_id: served.organization_id,
      },
      root: served.root,
      action: "existing",
    };
    return { data, lines: [`Using workspace "${served.name}" attached at ${served.root}.`] };
  }
  const wanted = name?.trim() || basename(cli.cwd);
  const same = await sameNameWorkspace(session, cli.env, wanted, entries);
  if (same) {
    const attached = await attachHere(session, cli, same.workspace);
    const data = { ...(attached.data as Omit<InitData, "action">), action: "attached" as const };
    return {
      ...attached,
      data,
      lines: [
        `Attached ${data.root} to your existing workspace "${same.workspace.name}" in "${same.organization}": it has ${name ? "the name you gave" : "this folder's name"}, and no other folder on this machine uses it (undo: pathrule detach).`,
      ],
    };
  }
  const outcome = await create(cli, session, wanted);
  return { ...outcome, data: { ...(outcome.data as object), action: "created" } };
}

/** No change of edition settled before this run: what an absent `ctx.setupPlan` means. */
export const NO_SETUP_PLAN: CliSetupPlan = { from: null, scope: null, transfer: null, target: null };

/**
 * Whether a person can answer a question in this run: a terminal, not `--json`. A run whose input
 * is a pipe is not asked, so its end of input is never taken for an answer.
 */
export function canAsk(ctx: CliCommandContext): boolean {
  return (
    !ctx.mode.json &&
    ctx.mode.interactive &&
    (ctx.runtime.promptLine !== undefined ||
      (ctx.runtime.stdinIsTTY ?? process.stdin.isTTY === true))
  );
}

/** The folder's Project backend on Pathrule Cloud, for the copy of its Local knowledge. */
export async function projectBackendOf(
  session: NativeSessionContext,
  folder: InitData,
): Promise<TransferBackend> {
  const ctx = await session.runtime.projectAccount.resolveContext({
    workspaceId: folder.workspace.id,
    cwd: folder.root,
  });
  if (!ctx?.backend)
    throw new NativeCloudError(
      "workspace_unavailable",
      `Workspace "${folder.workspace.name}" is not available to you on Pathrule Cloud (archived, deleted, or your access changed).`,
    );
  return ctx.backend;
}

/**
 * `pathrule setup` and `init` on Pathrule Cloud. The open CLI settled the folder's edition first
 * (`ctx.setupPlan`), so the folder is a Cloud folder here. In order:
 *
 * 1. the folder's workspace (`nativeInit`);
 * 2. `setup` only: the MCP entry in the AI clients (`--target`, or every client);
 * 3. the copy of the folder's Local knowledge, when the person approves it (../transfer/step.ts);
 * 4. the agent files and the hook index (`nativeSync`), which then include what was copied.
 *
 * The exit code is non-zero when the sync fails, when no AI client got its MCP entry (one client
 * failing is a warning line), or when the copy did not run or an approved copy left items behind.
 */
export async function setupFolder(
  ctx: CliCommandContext,
  session: NativeSessionContext,
  command: "setup" | "init",
): Promise<NativeOutcome> {
  const cli = ctx.runtime;
  const plan = ctx.setupPlan ?? NO_SETUP_PLAN;
  const init = await nativeInit(cli, session, command === "init" ? ctx.args[0] : undefined);
  const folder = init.data as InitData;
  // Lines not yet written. A question empties them first, so what setup did reads before it.
  const lines = [...init.lines];
  let written = false;
  const mcp =
    command === "setup" ? await installSetupMcpEntries(plan.target, cli.env, ctx.mode) : null;
  if (mcp) lines.push(...mcp.lines);

  let transfer: TransferOutcome | null = null;
  let transferError: { code: string; message: string } | null = null;
  try {
    transfer = await transferLocalKnowledge({
      env: cli.env,
      cwd: cli.cwd,
      target: {
        workspaceId: folder.workspace.id,
        name: folder.workspace.name,
        organizationId: folder.workspace.organization_id,
      },
      backend: () => projectBackendOf(session, folder),
      request: session.request,
      answer: plan.transfer,
      ask: canAsk(ctx)
        ? async (question, preview) => {
            for (const [i, line] of [...lines.splice(0), ...preview].entries())
              cli.stdout.write(
                i === 0 && !written ? `${statusLabel("ok", ctx.mode)} ${line}\n` : `${line}\n`,
              );
            written = true;
            return promptYesNo(cli, question, false);
          }
        : null,
      ...(cli.sleep ? { sleep: cli.sleep } : {}),
    });
    if (transfer) lines.push(...transfer.lines);
  } catch (err) {
    // Ctrl-C at the question cancels setup; it is not an answer.
    if (err instanceof Error && err.message === "setup_canceled") throw err;
    // The copy is a step of setup, not its precondition: the rest still runs, and this is said.
    transferError = failure(err);
    lines.push(
      `The copy of this folder's Local knowledge did not finish: ${transferError.message}`,
      "The Local workspace is unchanged. Try again: pathrule setup --cloud (nothing already on Pathrule Cloud is copied twice).",
    );
  }

  const { nativeSync } = await import("./native-knowledge.js");
  const sync = await nativeSync(cli, session);
  lines.push(...sync.lines);
  const exitCode = Math.max(
    sync.exitCode ?? 0,
    mcp?.failed ? 1 : 0,
    transfer?.exitCode ?? 0,
    transferError ? 1 : 0,
  );
  return {
    data: {
      ...folder,
      ...(mcp ? { mcp: mcp.results, ...(mcp.error ? { mcp_error: mcp.error } : {}) } : {}),
      transfer: transferError
        ? { status: "error", error: transferError }
        : (transfer?.data ?? null),
      sync: sync.data,
    },
    lines,
    exitCode,
    next: [
      // setup has just synced; the activity hint of a new attachment stays.
      ...(init.next ?? []).filter((s) => s.command !== "pathrule sync"),
      ...(transfer?.next ?? []),
    ],
  };
}

