// SPDX-License-Identifier: Apache-2.0
// `pathrule setup --local`: the no-login launcher.
//
// The two-command flow is `pathrule init --local` then `pathrule setup --local`.
// The runtime already works end-to-end under PATHRULE_LOCAL=1; this performs the
// wiring the user would otherwise do by hand:
//   1. discover/create the local workspace (initLocalWorkspace, idempotent),
//      importing the project's instruction files word for word,
//   2. write the AI-client MCP configs with an entry that spawns
//      `pathrule mcp run` carrying env PATHRULE_LOCAL=1 (installLocalCliTargets),
//   3. install the hook script + .claude/settings.json hook + static protocol
//      file + warm the offline hook-index (syncLocalWorkspace).
//
// A deliberately separate composition from the account-based setup — no org,
// no auth, no preflight — so neither path affects the other.

import type { CliInstallResult } from "../install-local.js";
import { installLocalCliTargets, parseInstallTargets } from "../install-local.js";
import { initLocalWorkspace, type InitLocalResult } from "./init-local.js";
import { syncLocalWorkspace, type LocalSyncOptions, type LocalSyncResult } from "./sync-local.js";

export interface LocalSetupArgs {
  /** AI-client install target (claude/cursor/codex/windsurf); defaults to "all". */
  target: string | null;
  /** Workspace name when init creates the store (defaults to the folder name). */
  workspaceName: string | null;
  /**
   * Import every instruction section the workspace has never had, even into a
   * workspace that already has content. Without it an existing workspace imports
   * only while it is still empty.
   */
  importInstructions: boolean;
}

/**
 * Parse the args `setup --local` accepts. Account-only options (--org,
 * --workspace, --create-workspace, bootstrap, ...) fail loudly with an
 * `unknown_setup_option` code, so they exit EX_USAGE through the existing
 * error mapping.
 */
export function parseLocalSetupArgs(args: string[]): LocalSetupArgs {
  const parsed: LocalSetupArgs = { target: null, workspaceName: null, importInstructions: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = () => {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`missing_value:${arg}`);
      i += 1;
      return value;
    };
    if (arg === "--target") parsed.target = next();
    else if (arg === "--workspace-name") parsed.workspaceName = next();
    else if (arg === "--import-instructions") parsed.importInstructions = true;
    else throw new Error(`unknown_setup_option:${arg}`);
  }
  return parsed;
}

/**
 * The agents whose project files a `--target` setup writes: the one it names, so `--target claude` writes
 * no Codex file and `--target cursor` (served through MCP alone) writes none. No target, or `all`, leaves
 * the choice to the sync (`enginesInUse`).
 */
function targetEngines(target: string | null): string[] | undefined {
  const parsed = target === null ? null : parseInstallTargets(target);
  if (!parsed || parsed.length !== 1) return undefined;
  return parsed[0] === "claude-code" || parsed[0] === "codex" ? [parsed[0]] : [];
}

export interface LocalSetupResult {
  workspace: InitLocalResult;
  install: CliInstallResult[];
  sync: LocalSyncResult;
  ok: boolean;
}

/**
 * Run the full local launcher. Idempotent end-to-end: init reuses an existing
 * store, the installers merge-inject, and sync is write-if-changed.
 */
export async function runLocalSetup(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  args?: string[];
  /** Test seam, threaded into syncLocalWorkspace. */
  syncOptions?: LocalSyncOptions;
}): Promise<LocalSetupResult> {
  const env = options.env;
  const { target, workspaceName, importInstructions } = parseLocalSetupArgs(options.args ?? []);

  const workspace = await initLocalWorkspace({
    cwd: options.cwd,
    env,
    name: workspaceName ?? undefined,
    instructionImport: importInstructions ? "missing" : undefined,
  });
  const install = await installLocalCliTargets(target ?? "all", env);
  const sync = await syncLocalWorkspace(env, workspace.localRootPath, workspace.workspaceId, {
    ...(targetEngines(target) ? { activeEngines: targetEngines(target) } : {}),
    ...options.syncOptions,
  });

  return {
    workspace,
    install,
    sync,
    ok: install.every((item) => item.ok) && sync.ok,
  };
}
