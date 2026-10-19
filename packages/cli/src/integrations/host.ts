// SPDX-License-Identifier: Apache-2.0
// The CLI's side of the integration engine (@pathrule/integrations native/manager.ts): how this
// runtime installs its hook, describes itself in the runtime manifest, prepares a Local workspace,
// reads its Cloud state, and runs a provider's own CLI. The engine decides what to do; this module
// only does it.
import { spawn } from "node:child_process";
import { homedir } from "node:os";

import { readIfExists, atomicWrite } from "@pathrule/core/storage/atomic-write.js";
import { folderConflictMessage, resolveFolderMode } from "@pathrule/core/workspace/folder-mode.js";
import { ensureClaudeSettingsHook, ensureCodexHooks } from "@pathrule/integrations/pathrule-protocol.js";
import type { IntegrationHost, ProviderCommandResult } from "@pathrule/integrations/native/manager.js";
import { runtimeManifestPath } from "@pathrule/integrations/native/home.js";
import { findOnPath } from "@pathrule/integrations/native/providers.js";
import { PATHRULE_REMOTE_MCP_URL } from "@pathrule/integrations/native/plugin-bundle.js";
import { readRuntimeManifest, writeRuntimeManifest } from "@pathrule/integrations/native/runtime-manifest-io.js";
import type { PluginBundleInput } from "@pathrule/integrations/native/plugin-bundle.js";
import { HOOK_EXTENSION_CONTRACT } from "@pathrule/protocol/hook-extension.js";
import { SUPPORTED_HOOK_INDEX_SCHEMAS } from "@pathrule/protocol/hook-index.js";
import type { IntegrationProviderId } from "@pathrule/protocol/integration-registry.js";
import type { RuntimeLaunch } from "@pathrule/protocol/runtime-manifest.js";

import { CLI_VERSION } from "../cli-version.js";
import { installCliHookScript } from "../hook-script-install.js";
import {
  installEntryToCliTargets,
  resolveCliEntrypoint,
  resolveMcpServerEntry,
  uninstallCliTargets,
} from "../install-local.js";
import { initLocalWorkspace } from "../local/init-local.js";
import { cliSelfCommand } from "../local/self-command.js";
import { syncLocalWorkspace } from "../local/sync-local.js";
import { prepareCapabilitiesFor } from "../capabilities/onboarding.js";
import { cliAccount, type CliRuntime } from "../plugin.js";
import { nativePluginAssets } from "./plugin-assets.js";

const PROVIDER_BINARY: Record<IntegrationProviderId, string> = { "claude-code": "claude", codex: "codex" };
const PROVIDER_TIMEOUT_MS = 120_000;

/** How the runtime manifest says to run this CLI: the binary's own launch, else Node and its entry. */
function cliLaunch(): { node: string; entry: string; env?: Record<string, string> } {
  const self = cliSelfCommand();
  if (self && self.args.length === 1 && /\.(c|m)?js$/.test(self.args[0]!)) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(self.env ?? {})) if (typeof v === "string") env[k] = v;
    return { node: self.command, entry: self.args[0]!, ...(Object.keys(env).length > 0 ? { env } : {}) };
  }
  return { node: process.execPath, entry: resolveCliEntrypoint() };
}

/** Whether this run can serve Pathrule Cloud: its account is composed here. */
export function cloudAvailableHere(): boolean {
  return cliAccount() !== null;
}

/** The edition that serves `root`, and the sentence for a folder in conflict. */
export function integrationFolderEdition(root: string, env: NodeJS.ProcessEnv) {
  const folder = resolveFolderMode(root, env, { cloudAvailable: cloudAvailableHere() });
  return {
    mode: folder.mode,
    deviceDefault: folder.deviceDefault.mode,
    conflict: folder.conflict ? folderConflictMessage(folder.conflict) : null,
  };
}

/**
 * The MCP server every native plugin launches: the entry `pathrule install` writes, one for every
 * folder whatever its edition; the server resolves each call's folder.
 */
function mcpLaunch(env: NodeJS.ProcessEnv): RuntimeLaunch {
  const entry = resolveMcpServerEntry(env);
  return { command: entry.command, args: entry.args, env: entry.env ?? {} };
}

function runProcess(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<ProviderCommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    const timer = setTimeout(() => child.kill("SIGKILL"), PROVIDER_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: 1, stdout, stderr: `${stderr}${err.message}` });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

export async function cliIntegrationHost(
  env: NodeJS.ProcessEnv,
  options: {
    home?: string;
    now?: () => Date;
    runProvider?: IntegrationHost["runProvider"];
    providerBinary?: IntegrationHost["providerBinary"];
    runtime?: CliRuntime;
  } = {},
): Promise<IntegrationHost> {
  const runtime: CliRuntime = options.runtime ?? { cwd: process.cwd(), env, stdout: process.stderr, stderr: process.stderr };
  const assets = await nativePluginAssets();
  // The run's own HOME (a test, a sandbox) before the process's.
  const home = options.home ?? (env.HOME && env.HOME.trim() !== "" ? env.HOME : homedir());
  const bundleInput = (): PluginBundleInput => ({
    pluginVersion: CLI_VERSION,
    minRuntime: CLI_VERSION,
    // This marketplace comes from the runtime that serves it, which is already on the machine.
    runtime: { package: "@pathrule/cli", version: CLI_VERSION, integrity: null },
    assets,
    remoteMcpUrl: PATHRULE_REMOTE_MCP_URL,
  });
  const providerBinary =
    options.providerBinary ?? ((provider: IntegrationProviderId) => findOnPath(PROVIDER_BINARY[provider], env));
  return {
    env,
    home,
    now: options.now ?? (() => new Date()),
    runtimeVersion: CLI_VERSION,
    bundleInput,
    providerBinary,
    runProvider:
      options.runProvider ??
      (async (provider, args) => {
        const binary = await providerBinary(provider);
        if (!binary) return { status: 127, stdout: "", stderr: `${PROVIDER_BINARY[provider]} is not on PATH` };
        return runProcess(binary, args, env);
      }),
    async ensureRuntime({ mode, maintenance }) {
      if (mode === "cloud" && !cliAccount()) {
        // The approved plan names this step: Cloud's capabilities, with their terms, into this
        // runtime's capability home. Nothing signs in here.
        const prepared = await prepareCapabilitiesFor("cloud", runtime, { json: true, color: false, interactive: false });
        if (prepared && !prepared.ok) {
          throw new Error(`Pathrule Cloud could not be prepared: ${prepared.failed.map((f) => f.reason).join("; ")}`);
        }
      }
      const installed = await installCliHookScript(env);
      const manifest = await writeRuntimeManifest(
        {
          runtimeVersion: CLI_VERSION,
          hookExtensionContract: HOOK_EXTENSION_CONTRACT,
          hookIndexSchemas: [...SUPPORTED_HOOK_INDEX_SCHEMAS],
          hookPath: installed.scriptPath,
          cli: cliLaunch(),
          mcp: mcpLaunch(env),
          maintenanceConsent: maintenance,
        },
        env,
      );
      return { manifestPath: runtimeManifestPath(env), hookPath: manifest.hook };
    },
    async folderEdition(root) {
      const { mode, conflict } = integrationFolderEdition(root, env);
      return { mode, conflict };
    },
    async ensureLocalWorkspace(root, provider) {
      const ws = await initLocalWorkspace({ cwd: root, env });
      const sync = await syncLocalWorkspace(env, ws.localRootPath, ws.workspaceId, { activeEngines: [provider] });
      if (!sync.hook_index.ok) throw new Error(`the hook index for ${ws.localRootPath} was not written: ${sync.hook_index.error ?? sync.error ?? "unknown"}`);
      return { workspaceId: ws.workspaceId, created: ws.action === "created" };
    },
    async cloudStatus() {
      // The command a person types to sign in: `pathrule login` when that is on PATH, else this very
      // runtime by its path (a plugin-only machine has no `pathrule` command).
      const launch = cliLaunch();
      const onPath = await findOnPath("pathrule", env);
      const loginCommand = onPath ? "pathrule login" : `"${launch.node}" "${launch.entry}" login`;
      const account = cliAccount();
      if (!account) {
        return {
          ready: false,
          signedIn: false,
          detail: "Pathrule Cloud is not prepared in this runtime. Run: pathrule setup --cloud",
          loginCommand,
        };
      }
      const user = await account.signedInUser(env).catch(() => null);
      return { ready: true, signedIn: !!user, detail: user ? `Signed in as ${user}.` : "Not signed in.", loginCommand };
    },
    async writeSettingsHooks(provider, path) {
      await installCliHookScript(env);
      const existing = await readIfExists(path);
      if (existing !== null) {
        try {
          JSON.parse(existing);
        } catch {
          throw new Error(`${path} is not valid JSON; Pathrule leaves it as it is.`);
        }
      }
      const result = provider === "claude-code" ? ensureClaudeSettingsHook(existing) : ensureCodexHooks(existing);
      if (result.changed) await atomicWrite(path, result.body);
      return { changed: result.changed };
    },
    async installMcpEntry(provider) {
      const results = await installEntryToCliTargets([provider], resolveMcpServerEntry(env), env);
      const first = results[0];
      if (!first || !first.ok) throw new Error(first?.error ?? "the MCP entry was not written");
      return { path: first.config_path, server: "pathrule" };
    },
    async removeMcpEntry(provider) {
      await uninstallCliTargets(provider, env);
    },
  };
}

/** What the runtime manifest says about this machine, for status lines. */
export async function runtimeSummary(env: NodeJS.ProcessEnv) {
  return readRuntimeManifest(env);
}
