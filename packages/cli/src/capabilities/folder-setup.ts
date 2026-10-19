// SPDX-License-Identifier: Apache-2.0
/**
 * `pathrule setup` and `pathrule init` settle which edition serves the folder before they set it up.
 * They are the only commands that change a folder's edition; every other command follows it.
 *
 * - **No mode asked for:** the folder keeps its edition (its own choice, its workspace, or the
 *   device default). Nothing is asked. A folder in conflict asks which edition serves it, and a run
 *   that cannot ask stops and names both commands.
 * - **The folder's own edition asked for:** the same setup again; nothing changes.
 * - **The other edition:** exactly two scopes. *This project only* (the default) records the
 *   folder's choice and leaves every other folder and the device default alone. *The device
 *   default* changes what new folders use and never a folder that already has its own edition, this
 *   one included. `--scope project|device` answers it in a script. A script that changes a folder
 *   already set up in the other edition and gives no scope stops (`setup_scope_required`); a folder
 *   not set up yet (no choice, no workspace) changes no project's edition, so a script gets the
 *   documented default, this project only, and is told so.
 * - **Choosing a scope approves no copy of knowledge.** Copying a folder's Local knowledge to
 *   Pathrule Cloud is the account setup's own question (`--transfer` / `--no-transfer`).
 * - **Leaving Pathrule Cloud copies nothing from it.** The folder's Cloud cache on this machine goes,
 *   and a Local store whose origin is uncertain is set aside (core/workspace/local-store-markers.ts).
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { listLocalWorkspaceStores } from "@pathrule/core/backend/local/workspace-stores.js";
import { pathruleHome } from "@pathrule/core/storage/paths.js";
import {
  forgetFolderChoice,
  readCloudFolderBindings,
  readFolderChoices,
  recordFolderChoice,
  type FolderChoiceVia,
  type FolderMode,
  type FolderModeChoice,
  type FolderModeResolution,
} from "@pathrule/core/workspace/folder-mode.js";
import {
  clearDormantMark,
  markLocalStoreDormant,
  readDormantMark,
  removeCloudMachineCache,
  setAsideLocalStore,
} from "@pathrule/core/workspace/local-store-markers.js";
import { canonicalizePath } from "@pathrule/core/backend/local/workspace-stores.js";
import { pathsEqual } from "@pathrule/protocol/path-compare.js";

import { jsonEnvelope, statusLabel, type CliOutputMode } from "../output.js";
import {
  cliAccount,
  type CliCommandContext,
  type CliJsonResult,
  type CliRuntime,
  type CliSetupPlan,
} from "../plugin.js";
import { cloudNamed, EDITION_TITLE, editionReason, folderEdition } from "./folder-edition.js";
import { clearRenderedKnowledge } from "@pathrule/integrations/client-renderers/clear-knowledge.js";
import { writeDeviceDefault } from "./selection.js";

export type EditionScope = "project" | "device";

/** The open command `setup` or `init` runs for a Pathrule Local folder. */
export interface OpenEditionCommand {
  render(runtime: CliRuntime, mode: CliOutputMode, args: string[]): Promise<number>;
  json(runtime: CliRuntime, args: string[]): Promise<CliJsonResult>;
}

export interface EditionOptions {
  scope: EditionScope | null;
  transfer: boolean | null;
  target: string | null;
  /** The arguments left for the edition's own setup (`--target` stays: Local setup reads it). */
  rest: string[];
}

interface Failure {
  code: string;
  message: string;
  exitCode: number;
  next?: string[];
}

/** `--scope`, `--transfer` and `--no-transfer` out of the arguments; `--target` read and kept. */
export function parseEditionOptions(args: readonly string[]): EditionOptions | Failure {
  const out: EditionOptions = { scope: null, transfer: null, target: null, rest: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--scope" || arg.startsWith("--scope=")) {
      const value = arg === "--scope" ? args[++i] : arg.slice("--scope=".length);
      if (value !== "project" && value !== "device") {
        return { code: "invalid_scope", message: "--scope takes project or device.", exitCode: 64 };
      }
      out.scope = value;
    } else if (arg === "--transfer" || arg === "--no-transfer") {
      if (out.transfer !== null && out.transfer !== (arg === "--transfer")) {
        return { code: "conflicting_transfer", message: "Choose one: --transfer or --no-transfer.", exitCode: 64 };
      }
      out.transfer = arg === "--transfer";
    } else {
      if (arg === "--target" || arg.startsWith("--target=")) {
        out.target = arg === "--target" ? (args[i + 1] ?? null) : arg.slice("--target=".length);
      }
      out.rest.push(arg);
    }
  }
  return out;
}

type Decision =
  | {
      kind: "run";
      target: FolderMode;
      root: string;
      from: FolderMode | null;
      scope: EditionScope | null;
      /** The folder changes edition in this run (its choice is recorded before its setup runs). */
      switching: boolean;
      /** A script took the default scope for a folder not set up yet: said in a line. */
      defaultScope?: boolean;
    }
  | { kind: "default-only"; deviceDefault: FolderMode; keeps: FolderMode; root: string }
  | { kind: "failed"; failure: Failure }
  | { kind: "canceled" };

function canAsk(ctx: CliCommandContext): boolean {
  if (!ctx.mode.interactive || ctx.mode.json) return false;
  if (ctx.runtime.promptLine) return true;
  if (process.env.NODE_ENV === "test") return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function ask(ctx: CliCommandContext, question: string): Promise<string> {
  if (ctx.runtime.promptLine) return (await ctx.runtime.promptLine(question)).trim().toLowerCase();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim().toLowerCase();
  } finally {
    rl.close();
  }
}

/** The two scopes, asked: 1 (this project, the default) or 2 (the device default). */
async function askScope(
  ctx: CliCommandContext,
  folder: FolderModeResolution,
  requested: FolderMode,
): Promise<EditionScope | null> {
  const now = EDITION_TITLE[folder.mode!];
  const next = EDITION_TITLE[requested];
  const thisFolder =
    folder.source === "device-default"
      ? " This folder is not set up yet, so it follows the new default."
      : ` This folder keeps ${now}.`;
  ctx.runtime.stdout.write(
    `\nThis folder uses ${now} (${editionReason(folder)}). Use ${next} for:\n\n` +
      `  1. This project only (recommended)\n` +
      `     Other projects and the device default stay as they are.\n` +
      `  2. The device default\n` +
      `     New folders use ${next}. Folders already set up keep their edition.${thisFolder}\n`,
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = await ask(ctx, "\nChoose 1 or 2 [1]: ");
    if (answer === "" || answer === "1") return "project";
    if (answer === "2") return "device";
    if (answer === "q" || answer === "quit") return null;
  }
  return null;
}

/** A folder in conflict, asked which edition serves it. No default: the person must say. */
async function askConflict(ctx: CliCommandContext, folder: FolderModeResolution): Promise<FolderMode | null> {
  const cloud = folder.dormant.cloud;
  ctx.runtime.stdout.write(
    `\n${folder.conflict!.root} has both a Pathrule Local workspace and a Pathrule Cloud workspace.\n` +
      `Which one serves this folder?\n\n` +
      `  1. Pathrule Cloud${cloud ? ` (workspace "${cloud.name}")` : ""}\n` +
      `  2. Pathrule Local\n`,
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = await ask(ctx, "\nChoose 1 or 2: ");
    if (answer === "1" || answer === "cloud") return "cloud";
    if (answer === "2" || answer === "local") return "local";
    if (answer === "q" || answer === "quit") return null;
  }
  return null;
}

async function decide(
  ctx: CliCommandContext,
  folder: FolderModeResolution,
  options: EditionOptions,
): Promise<Decision> {
  const { flags, runtime } = ctx;
  if (flags.cloud && (flags.local || flags.noIntelligence)) {
    return { kind: "failed", failure: { code: "conflicting_setup_mode", message: "Choose one mode: --cloud, or --local.", exitCode: 64 } };
  }
  const requested: FolderMode | null = flags.cloud ? "cloud" : flags.local || flags.noIntelligence ? "local" : null;
  if (options.transfer !== null && requested === "local") {
    return {
      kind: "failed",
      failure: { code: "transfer_needs_cloud", message: "--transfer copies Local knowledge to Pathrule Cloud; it does not apply with --local.", exitCode: 64 },
    };
  }
  if (requested === "cloud" && !cloudNamed(runtime.env) && !cliAccount()) {
    return { kind: "failed", failure: { code: "cloud_unavailable", message: "Pathrule Cloud is not part of this build.", exitCode: 64 } };
  }

  if (folder.conflict) {
    const chosen = requested ?? (canAsk(ctx) ? await askConflict(ctx, folder) : null);
    if (!chosen) {
      if (canAsk(ctx)) return { kind: "canceled" };
      return {
        kind: "failed",
        failure: {
          code: "folder_edition_conflict",
          message: `${folder.conflict.root} has both a Pathrule Local workspace and a Pathrule Cloud workspace, and no choice between them. Choose one: pathrule setup --cloud, or pathrule setup --local.`,
          exitCode: 64,
          next: ["pathrule setup --cloud", "pathrule setup --local"],
        },
      };
    }
    return { kind: "run", target: chosen, root: folder.conflict.root, from: null, scope: "project", switching: true };
  }

  const current = folder.mode!;
  const root = folder.root ?? canonicalizePath(runtime.cwd);
  if (!requested || requested === current) {
    // Same edition: nothing changes, and a scope given anyway only sets the device default.
    if (requested && options.scope === "device") writeDeviceDefault(runtime.env, requested);
    return { kind: "run", target: current, root, from: current, scope: options.scope, switching: false };
  }

  // A script and a folder not set up yet: no project changes edition, so this project only applies.
  const unconfigured = folder.source === "device-default";
  const scope =
    options.scope ??
    (canAsk(ctx) ? await askScope(ctx, folder, requested) : unconfigured ? "project" : undefined);
  if (scope === null) return { kind: "canceled" };
  if (scope === undefined) {
    return {
      kind: "failed",
      failure: {
        code: "setup_scope_required",
        message:
          `This folder uses ${EDITION_TITLE[current]} (${editionReason(folder)}). Say what --${requested} changes: ` +
          `--scope project (this folder only) or --scope device (the default for new folders; folders already set up keep their edition).`,
        exitCode: 64,
        next: [`pathrule ${ctx.command} --${requested} --scope project`, `pathrule ${ctx.command} --${requested} --scope device`],
      },
    };
  }
  if (scope === "device") {
    writeDeviceDefault(runtime.env, requested);
    if (folder.source !== "device-default") return { kind: "default-only", deviceDefault: requested, keeps: current, root };
    return { kind: "run", target: requested, root, from: null, scope, switching: false };
  }
  return {
    kind: "run",
    target: requested,
    root,
    from: unconfigured ? null : current,
    scope,
    switching: true,
    defaultScope: !options.scope && !canAsk(ctx),
  };
}

/** The Local store set aside or brought back, and the Cloud cache removed, when a folder goes Local. */
async function leaveCloud(env: NodeJS.ProcessEnv, folder: FolderModeResolution): Promise<string[]> {
  const notes: string[] = [];
  const cloud = folder.cloud ?? folder.dormant.cloud;
  const local = folder.dormant.local;
  if (local) {
    if (readDormantMark(env, local.workspaceId)) {
      clearDormantMark(env, local.workspaceId);
      notes.push(`This folder's earlier Local workspace serves it again: nothing in it came from Pathrule Cloud.`);
    } else {
      const dir = setAsideLocalStore(env, local.workspaceId, "shared its folder with a Pathrule Cloud workspace before each folder had one edition");
      notes.push(
        `The Local workspace that shared this folder with Pathrule Cloud may hold content that came from it, so it is set aside, not used and not deleted (${dir}). A new Local workspace starts empty.`,
      );
    }
  }
  if (cloud) {
    const localIds = new Set(listLocalWorkspaceStores(env).map((w) => w.workspaceId));
    removeCloudMachineCache(env, cloud.workspaceId, (id) => localIds.has(id));
    // Everything a Cloud render put into the folder goes now, as on detach (integrations
    // clear-knowledge.ts): the rules folder, every knowledge file, the workspace's sections in the
    // protocol files. Not when Local renders next: a Local render only sweeps what it would write.
    const { errors, unclear } = await clearRenderedKnowledge(cloud.root);
    for (const error of errors) notes.push(`Pathrule Cloud's knowledge could not be removed from ${error}`);
    for (const u of unclear) notes.push(`${u.path} is left as it is, check it yourself: ${u.reason}`);
  }
  notes.unshift(
    "Pathrule Cloud's knowledge for this folder stays on Pathrule Cloud. Nothing from it is copied to this machine.",
  );
  return notes;
}

/** A folder that goes Cloud: its Local store stays as it is, unused, and its Local index stops. */
function enterCloud(env: NodeJS.ProcessEnv, folder: FolderModeResolution): void {
  const local = folder.local ?? folder.dormant.local;
  if (!local) return;
  markLocalStoreDormant(env, local.workspaceId, folder.dormant.cloud?.workspaceId ?? null);
  rmSync(join(pathruleHome(env), "cache", local.workspaceId, "hook-index.json"), { force: true });
}

function previousChoice(env: NodeJS.ProcessEnv, root: string): FolderModeChoice | null {
  return readFolderChoices(env).find((c) => pathsEqual(c.root, root)) ?? null;
}

function attachedAt(env: NodeJS.ProcessEnv, root: string): boolean {
  return readCloudFolderBindings(env).some((b) => pathsEqual(b.root, root));
}

export interface FolderSetupHooks {
  /** Loads Pathrule Cloud for this run when it is not loaded yet; false with its reason printed. */
  prepareCloud(ctx: CliCommandContext): Promise<boolean>;
  open: OpenEditionCommand;
}

interface Outcome {
  exitCode: number;
  lines: string[];
  edition: Record<string, unknown>;
  failure?: Failure;
  json?: CliJsonResult;
}

/** Settles the folder's edition, then runs that edition's `setup` or `init` in the folder's project. */
async function run(ctx: CliCommandContext, hooks: FolderSetupHooks, asJson: boolean): Promise<Outcome> {
  const command = ctx.command === "init" ? "init" : "setup";
  const via: FolderChoiceVia = command;
  const parsed = parseEditionOptions(ctx.args);
  if ("code" in parsed) return { exitCode: parsed.exitCode, lines: [], edition: {}, failure: parsed };
  const env = ctx.runtime.env;
  const folder = folderEdition(ctx.runtime.cwd, env);
  const decision = await decide(ctx, folder, parsed);
  if (decision.kind === "canceled") return { exitCode: 0, lines: ["Setup canceled. Nothing changed."], edition: {} };
  if (decision.kind === "failed") return { exitCode: decision.failure.exitCode, lines: [], edition: {}, failure: decision.failure };
  if (decision.kind === "default-only") {
    return {
      exitCode: 0,
      lines: [
        `The device default is now ${EDITION_TITLE[decision.deviceDefault]}: new folders use it.`,
        `${decision.root} keeps ${EDITION_TITLE[decision.keeps]} (its own edition). To change this folder: pathrule ${command} --${decision.deviceDefault} --scope project`,
      ],
      edition: { mode: decision.keeps, scope: "device", device_default: decision.deviceDefault, root: decision.root },
    };
  }

  const { target, root, switching } = decision;
  const plan: CliSetupPlan = {
    from: decision.from,
    scope: decision.scope,
    transfer: parsed.transfer,
    target: parsed.target,
  };
  const lines: string[] = [];
  if (decision.defaultScope) {
    lines.push(
      `${EDITION_TITLE[target]} for this project only; the device default stays ${EDITION_TITLE[folder.deviceDefault.mode]}. ` +
        `For every new folder: pathrule config set default-mode ${target}`,
    );
  }
  const inProject: CliCommandContext = {
    ...ctx,
    args: parsed.rest,
    runtime: { ...ctx.runtime, cwd: root },
    setupPlan: plan,
  };
  const edition = { mode: target, scope: decision.scope, from: decision.from, root, switched: switching };

  if (target === "cloud") {
    if (!(await hooks.prepareCloud(ctx))) {
      return { exitCode: 1, lines, edition, failure: { code: "cloud_unavailable", message: "Pathrule Cloud could not be prepared for this CLI.", exitCode: 1 } };
    }
    const account = cliAccount()?.commands[command];
    if (!account) {
      return { exitCode: 1, lines, edition, failure: { code: "cloud_unavailable", message: "Pathrule Cloud is not part of this build.", exitCode: 1 } };
    }
    const previous = previousChoice(env, root);
    if (switching) {
      recordFolderChoice(env, root, "cloud", via);
      enterCloud(env, folder);
    }
    if (asJson) {
      const result = account.json ? await account.json(inProject) : null;
      const exitCode = result?.exitCode ?? 1;
      if (exitCode !== 0 && switching && !attachedAt(env, root)) rollback(env, root, previous, folder);
      else if (exitCode === 0) recordFolderChoice(env, root, "cloud", via);
      return { exitCode, lines, edition, json: result ?? undefined };
    }
    const exitCode = await account.run(inProject);
    if (exitCode !== 0 && switching && !attachedAt(env, root)) {
      rollback(env, root, previous, folder);
      lines.push(`This folder stays on ${EDITION_TITLE[decision.from ?? "local"]}: Pathrule Cloud setup did not finish.`);
    } else if (exitCode === 0) {
      recordFolderChoice(env, root, "cloud", via);
    }
    return { exitCode, lines, edition };
  }

  if (switching) {
    recordFolderChoice(env, root, "local", via);
    lines.push(...(await leaveCloud(env, folder)));
  }
  if (asJson) {
    const result = await hooks.open.json(inProject.runtime, parsed.rest);
    if (result.exitCode === 0) recordFolderChoice(env, root, "local", via);
    return { exitCode: result.exitCode, lines, edition, json: result };
  }
  for (const line of lines) ctx.runtime.stdout.write(`${statusLabel("info", ctx.mode)} ${line}\n`);
  lines.length = 0;
  const exitCode = await hooks.open.render(inProject.runtime, ctx.mode, parsed.rest);
  if (exitCode === 0) recordFolderChoice(env, root, "local", via);
  return { exitCode, lines, edition };
}

/** A Cloud setup that did not finish leaves the folder as it was: its earlier choice, or none. */
function rollback(env: NodeJS.ProcessEnv, root: string, previous: FolderModeChoice | null, folder: FolderModeResolution): void {
  if (previous) recordFolderChoice(env, previous.root, previous.mode, previous.via);
  else forgetFolderChoice(env, root);
  const local = folder.local ?? folder.dormant.local;
  if (local) clearDormantMark(env, local.workspaceId);
}

/** `pathrule setup` or `init` at a terminal. */
export async function renderFolderSetup(ctx: CliCommandContext, hooks: FolderSetupHooks): Promise<number> {
  const outcome = await run(ctx, hooks, false);
  for (const line of outcome.lines) ctx.runtime.stdout.write(`${statusLabel("info", ctx.mode)} ${line}\n`);
  if (outcome.failure) {
    ctx.runtime.stderr.write(`${statusLabel("error", ctx.mode)} ${outcome.failure.message}\n`);
    for (const next of outcome.failure.next ?? []) ctx.runtime.stderr.write(`Next: ${next}\n`);
  }
  return outcome.exitCode;
}

/** `pathrule setup --json` or `init --json`. It never asks. */
export async function folderSetupJson(ctx: CliCommandContext, hooks: FolderSetupHooks): Promise<CliJsonResult> {
  const outcome = await run(ctx, hooks, true);
  const command = ctx.command === "init" ? "init" : "setup";
  if (outcome.failure) {
    return {
      exitCode: outcome.exitCode,
      envelope: jsonEnvelope({
        command,
        cwd: ctx.runtime.cwd,
        ok: false,
        error: {
          code: outcome.failure.code,
          message: outcome.failure.message,
          ...(outcome.failure.next ? { remediation: outcome.failure.next.map((c) => ({ label: "Next", command: c })) } : {}),
        },
      }),
    };
  }
  const base = outcome.json ?? {
    exitCode: outcome.exitCode,
    envelope: jsonEnvelope({ command, cwd: ctx.runtime.cwd, ok: outcome.exitCode === 0, data: {} }),
  };
  const data = base.envelope.data;
  return {
    ...base,
    envelope: {
      ...base.envelope,
      data: {
        ...(data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : { result: data ?? null }),
        mode: outcome.edition.mode ?? null,
        edition: outcome.edition,
        ...(outcome.lines.length > 0 ? { notices: outcome.lines } : {}),
      },
    },
  };
}
