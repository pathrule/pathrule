// SPDX-License-Identifier: Apache-2.0
// `pathrule init`, `setup` and `sync` against the local store: no account, no organization, no
// preflight. They run here for a Pathrule Local folder; a Pathrule Cloud folder's run the account's.
// `setup` and `init` first settle which edition serves the folder (capabilities/folder-setup.ts).
import { LocalBackend } from "@pathrule/core";

import { editionCommand } from "../capabilities/folder-edition.js";
import {
  folderSetupJson,
  renderFolderSetup,
  type FolderSetupHooks,
  type OpenEditionCommand,
} from "../capabilities/folder-setup.js";
import { capabilityHost } from "../capabilities/host.js";
import { prepareMode } from "../capabilities/onboarding.js";
import { initLocalWorkspace } from "../local/init-local.js";
import { runLocalSetup } from "../local/setup-local.js";
import { syncLocalWorkspace, type LocalSyncResult } from "../local/sync-local.js";
import { cliErrorCode, jsonEnvelope, statusLabel, type CliOutputMode } from "../output.js";
import { cliAccount, type CliCommand, type CliRuntime } from "../plugin.js";
import { renderLocalInstructions } from "../setup-render.js";

/** What `setup` and `init` need around the folder's edition: Cloud loaded, and the open command. */
function folderHooks(open: OpenEditionCommand): FolderSetupHooks {
  return {
    async prepareCloud(ctx) {
      const host = capabilityHost();
      // A composition with its plugins built in (the VS Code extension) has Cloud or does not.
      if (!host) return cliAccount() !== null;
      return (await prepareMode(host, "cloud", ctx.runtime, ctx.mode)).ok;
    },
    open,
  };
}

const LOCAL_INIT: OpenEditionCommand = {
  render: (runtime, mode, args) => renderInit(args, runtime, mode),
  json: (runtime, args) => runInitJson(runtime, args),
};

/**
 * The name `init` was given: `--name <name>`, `--name=<name>` or a bare word. A flag is never a
 * name, and `--name` without a value is an error rather than a workspace called "--name".
 */
export function initWorkspaceName(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg !== "--name" && !arg.startsWith("--name=")) continue;
    const value = arg === "--name" ? args[i + 1] : arg.slice("--name=".length);
    if (!value || value.startsWith("-")) throw new Error("--name needs a value: pathrule init --local --name <name>");
    return value;
  }
  return args.find((a) => !a.startsWith("-"));
}

export const initCommand: CliCommand = {
  name: "init",
  help: {
    section: "quick-start",
    rank: 20,
    summary:
      "Create or reuse this folder's workspace in its edition (--cloud or --local changes the edition)",
    usage: ["pathrule init [name]", "pathrule init --local [--name <name>]", "pathrule init --cloud"],
  },
  jsonRank: 100,
  run: (ctx) => renderFolderSetup(ctx, folderHooks(LOCAL_INIT)),
  json: (ctx) => folderSetupJson(ctx, folderHooks(LOCAL_INIT)),
};

export const setupCommand: CliCommand = {
  name: "setup",
  help: {
    section: "quick-start",
    rank: 10,
    summary:
      "Set this folder up: Pathrule Cloud by default, or --local (no account, open source only)",
    usage: [
      "pathrule setup                  Pathrule Cloud: sign in and connect this folder",
      "pathrule setup --local          Pathrule Local: no account, knowledge stays on this machine",
      "pathrule setup --local --target <claude|codex|cursor|windsurf|copilot|all>",
      "                                [--workspace-name <name>] [--import-instructions] [--yes]",
    ],
  },
  jsonRank: 110,
  run: (ctx) => renderFolderSetup(ctx, folderHooks(LOCAL_SETUP)),
  json: (ctx) => folderSetupJson(ctx, folderHooks(LOCAL_SETUP)),
};

/** The open local setup, which `setup` runs for a Pathrule Local folder. */
const LOCAL_SETUP: OpenEditionCommand = {
  render: renderLocalSetup,
  json: runSetupJson,
};

export const syncCommand: CliCommand = {
  name: "sync",
  help: {
    section: "workspace-setup",
    rank: 50,
    summary: "Rerender this folder's companion files and hook index from its workspace",
    usage: ["pathrule sync [--json]"],
  },
  jsonRank: 180,
  ...editionCommand({
    run: (ctx) => renderSync(ctx.runtime, ctx.mode),
    json: (ctx) => runSyncJson(ctx.runtime),
  }),
};

async function renderInit(
  args: readonly string[],
  runtime: CliRuntime,
  mode: CliOutputMode,
): Promise<number> {
  try {
    const name = initWorkspaceName(args);
    const result = await initLocalWorkspace({ cwd: runtime.cwd, name, env: runtime.env });
    const verb = result.action === "created" ? "Created" : "Using";
    runtime.stdout.write(
      `${statusLabel("ok", mode)} ${verb} local workspace "${result.name}" at ${result.localRootPath}\n`,
    );
    renderLocalInstructions(result.instructions, runtime.stdout, mode);
    runtime.stdout.write(
      `${statusLabel("info", mode)} Stored locally: no account, no cloud. Next: pathrule setup --local\n`,
    );
    return 0;
  } catch (err) {
    runtime.stderr.write(
      `${statusLabel("error", mode)} ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

async function runInitJson(runtime: CliRuntime, args: readonly string[]) {
  try {
    const name = initWorkspaceName(args);
    const data = await initLocalWorkspace({ cwd: runtime.cwd, name, env: runtime.env });
    return {
      exitCode: 0,
      envelope: jsonEnvelope({ command: "init", cwd: runtime.cwd, ok: true, data }),
    };
  } catch (err) {
    return {
      exitCode: 1,
      envelope: jsonEnvelope({
        command: "init",
        cwd: runtime.cwd,
        ok: false,
        error: {
          code: cliErrorCode(err, "init_failed"),
          message: err instanceof Error ? err.message : String(err),
        },
      }),
    };
  }
}

// `pathrule setup` for a Pathrule Local folder: the no-login launcher. No org, no auth, no
// preflight; init (idempotent) → MCP entries → hooks + index.
async function renderLocalSetup(
  runtime: CliRuntime,
  mode: CliOutputMode,
  args: string[],
): Promise<number> {
  try {
    const result = await runLocalSetup({ cwd: runtime.cwd, env: runtime.env, args });
    runtime.stdout.write("Pathrule setup (local)\n");
    const verb = result.workspace.action === "created" ? "Created" : "Using";
    runtime.stdout.write(
      `${statusLabel("ok", mode)} ${verb} local workspace "${result.workspace.name}" at ${result.workspace.localRootPath}\n`,
    );
    renderLocalInstructions(result.workspace.instructions, runtime.stdout, mode);
    for (const item of result.install) {
      if (item.ok) {
        runtime.stdout.write(
          `${statusLabel("ok", mode)} ${item.client}: MCP entry installed: ${item.config_path}\n`,
        );
      } else {
        runtime.stdout.write(
          `${statusLabel("warn", mode)} ${item.client}: install failed: ${item.error ?? "unknown error"}\n`,
        );
      }
    }
    renderProjectChanges(result.sync, runtime.stdout, mode);
    if (result.sync.ok) {
      runtime.stdout.write(
        `${statusLabel("ok", mode)} Hooks + offline context index ready (no account, no cloud).\n`,
      );
    } else {
      runtime.stdout.write(
        `${statusLabel("warn", mode)} Hook sync incomplete: ${result.sync.error ?? "unknown error"}\n`,
      );
    }
    if (result.ok) {
      runtime.stdout.write(
        "Next: restart your AI tool. Pathrule now runs fully local for this folder.\n",
      );
      return 0;
    }
    return 1;
  } catch (err) {
    const code = cliErrorCode(err, "setup_failed");
    runtime.stderr.write(
      `${statusLabel("error", mode)} ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return code.startsWith("unknown_setup_option") || code.startsWith("missing_value") ? 64 : 1;
  }
}

async function runSetupJson(runtime: CliRuntime, args: string[]) {
  try {
    const data = await runLocalSetup({ cwd: runtime.cwd, env: runtime.env, args });
    return {
      exitCode: data.ok ? 0 : 1,
      envelope: jsonEnvelope({
        command: "setup",
        cwd: runtime.cwd,
        ok: data.ok,
        data,
        error: data.ok ? undefined : { code: "local_setup_failed", message: "local_setup_failed" },
      }),
    };
  } catch (err) {
    const code = cliErrorCode(err, "setup_failed");
    return {
      exitCode:
        code.startsWith("unknown_setup_option") || code.startsWith("missing_value") ? 64 : 1,
      envelope: jsonEnvelope({
        command: "setup",
        cwd: runtime.cwd,
        ok: false,
        error: {
          code,
          message: err instanceof Error ? err.message : String(err),
        },
      }),
    };
  }
}

/**
 * Resolve the local (no-login) workspace covering the cwd and refresh its
 * compiled companion files + hook-index from the LocalBackend. Throws
 * `no_local_workspace` when the cwd is not inside a local workspace.
 */
async function syncLocalForCwd(runtime: CliRuntime): Promise<LocalSyncResult> {
  const match = LocalBackend.discoverWorkspaceForCwd(runtime.cwd, runtime.env);
  if (!match) {
    throw new Error("no_local_workspace");
  }
  return syncLocalWorkspace(runtime.env, match.localRootPath, match.workspaceId);
}

/**
 * What a sync did to the project outside `.pathrule/`, by name: every file it wrote, retracted or
 * removed, what an older Pathrule left that it cleared, and what it left alone because it could not
 * read it. A change in the person's tree is never silent.
 */
function renderProjectChanges(sync: LocalSyncResult, out: CliRuntime["stdout"], mode: CliOutputMode): void {
  const changed = [...new Set([...sync.files.changed, ...sync.companion.changed])];
  if (changed.length > 0) out.write(`${statusLabel("info", mode)} Project files changed: ${changed.join(", ")}\n`);
  if (sync.companion.legacy_removed.length > 0) {
    out.write(`${statusLabel("info", mode)} Removed what an older Pathrule left: ${sync.companion.legacy_removed.join(", ")}\n`);
  }
  for (const held of sync.companion.legacy_held) {
    out.write(
      `${statusLabel("warn", mode)} Your own instructions are in ${held}, where an older Pathrule moved them: copy them back, or \`pathrule eject\` restores them.\n`,
    );
  }
  for (const e of [...sync.files.errors, ...sync.companion.errors]) {
    out.write(`${statusLabel("warn", mode)} ${e.path} left as it is: ${e.message}\n`);
  }
}

async function renderSync(runtime: CliRuntime, mode: CliOutputMode): Promise<number> {
  try {
    const result = await syncLocalForCwd(runtime);
    renderProjectChanges(result, runtime.stdout, mode);
    if (!result.ok) {
      const reason =
        result.error === "no_local_workspace"
          ? "No local workspace here. Run: pathrule init --local"
          : (result.error ?? "local_sync_failed");
      runtime.stderr.write(`${statusLabel("error", mode)} ${reason}\n`);
      return 1;
    }
    runtime.stdout.write(
      `${statusLabel("ok", mode)} Synced local knowledge: ${result.companion.written} companion file(s) written, ${result.companion.skipped} skipped; hook index ${result.hook_index.ok ? "updated" : "skipped"}.\n`,
    );
    return 0;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const reason =
      raw === "no_local_workspace" ? "No local workspace here. Run: pathrule init --local" : raw;
    runtime.stderr.write(`${statusLabel("error", mode)} ${reason}\n`);
    return 1;
  }
}

async function runSyncJson(runtime: CliRuntime) {
  try {
    const data = await syncLocalForCwd(runtime);
    return {
      exitCode: data.ok ? 0 : 1,
      envelope: jsonEnvelope({
        command: "sync",
        cwd: runtime.cwd,
        ok: data.ok,
        data,
        error: data.ok
          ? undefined
          : {
              code: data.error ?? "sync_failed",
              message: data.error ?? "Pathrule sync failed.",
            },
      }),
    };
  } catch (err) {
    return {
      exitCode: 1,
      envelope: jsonEnvelope({
        command: "sync",
        cwd: runtime.cwd,
        ok: false,
        error: {
          code: cliErrorCode(err, "sync_failed"),
          message: err instanceof Error ? err.message : String(err),
        },
      }),
    };
  }
}
