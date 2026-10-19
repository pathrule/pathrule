// SPDX-License-Identifier: Apache-2.0
// Local (no-login) post-init sync.
//
// Performs only the steps a solo dev needs for the offline loop:
//   1. materialize the hook script into PATHRULE_HOME/bin/ (installCliHookScript
//      also registers the hook command path the settings merger writes),
//   2. install the Pre/Post/UserPromptSubmit hook into <cwd>/.claude/settings.json
//      via the pure settings merger (when the sync serves Claude Code),
//   3. write the static `.claude/rules/pathrule-protocol.md` (no backend needed;
//      also only when the sync serves Claude Code),
//   4. render the per-directory compiled knowledge files (claude-code's
//      CLAUDE.md + .claude/rules/pathrule-knowledge.md, plus the other enabled
//      clients' files) from the LocalBackend — brings the native
//      compilation win to the no-login edition (MCP-less, turn-zero path context),
//   5. warm `~/.pathrule/cache/<ws>/hook-index.json` from the LocalBackend.
//
// No org, no auth, no remote calls, no preflight. Idempotent — every step is
// write-if-changed or a fresh assembly.

import { join } from "node:path";

import { resolveLocalPrincipal, type KnowledgeBackend } from "@pathrule/core";
import { homedir } from "node:os";

import {
  CLAUDE_SHARED_SETTINGS,
  syncClaudeSettingsHook,
} from "@pathrule/integrations/client-renderers/claude-settings-hook.js";
import { rerenderMultiClientLocal } from "@pathrule/integrations/client-renderers/pipeline.js";
import { pluginOwnsHooks } from "@pathrule/integrations/native/ownership.js";
import { enginesInUse } from "@pathrule/integrations/skills/disk-detection.js";
import { openPersonalIndexEntries } from "@pathrule/core/user-knowledge/user-knowledge-capture.js";
import { userKnowledgeStoreFor } from "@pathrule/core/user-knowledge/user-knowledge-store.js";
import { pathruleHome } from "@pathrule/core/storage/paths.js";
import {
  CLAUDE_PROTOCOL_FILE,
  syncClaudeProtocolFile,
} from "@pathrule/integrations/client-renderers/claude-protocol-file.js";
import {
  syncHookIndex,
  type HookIndexSyncResult,
} from "@pathrule/integrations/index-writers/hook-index-writer.js";
import {
  forgetManagedFileOwnership,
  readManagedFileOwnershipManifest,
  recordManagedFileOwnership,
  type ManagedFileOwner,
} from "@pathrule/core/storage/managed-file-ownership.js";

import { CLI_VERSION } from "../cli-version.js";
import { installCliHookScript } from "../hook-script-install.js";
import { cliHostSession } from "./host-session.js";

const CLI_MANAGED_FILE_OWNER: ManagedFileOwner = "cli";

export interface LocalSyncResult {
  ok: boolean;
  workspace_id: string;
  workspace_root: string;
  hook_script: { ok: boolean; hook_command_path: string | null; error?: string };
  files: {
    written: number;
    skipped: number;
    /** Project files (outside `.pathrule/`) this step changed or removed, workspace-relative. */
    changed: string[];
    errors: Array<{ path: string; message: string }>;
  };
  companion: {
    ok: boolean;
    enabled: string[];
    written: number;
    skipped: number;
    removed: number;
    /** Project files the render wrote, retracted or removed, workspace-relative. */
    changed: string[];
    /** What an older Pathrule left that this sync removed, reported so no deletion is silent. */
    legacy_removed: string[];
    /** Backups an older Pathrule made that hold the person's own text: left for them, and said. */
    legacy_held: string[];
    errors: Array<{ path: string; message: string }>;
    error?: string;
  };
  hook_index: HookIndexSyncResult;
  error?: string;
}

/**
 * The store a sync renders from when it is not the home's local store: an account's Project backend.
 * `writeHookIndex` then writes the hook index, given the companion render's protocol decision.
 */
export interface SyncStore {
  backend: KnowledgeBackend;
  workspaceName: string;
  userId: string;
  writeHookIndex?: (decision: {
    protocol?: string;
    teamContext?: string;
  }) => Promise<HookIndexSyncResult>;
}

export interface LocalSyncOptions {
  /** Override the embedded hook script source (tests only). */
  hookScriptSource?: string;
  /** Render from this store instead of the home's local store for `workspaceId`. */
  store?: SyncStore;
  /**
   * The agents this sync serves. A native integration names its own, so setting up one agent
   * writes no other agent's files into the project; omitted keeps the default target resolution.
   */
  activeEngines?: string[];
}

export async function syncLocalWorkspace(
  env: NodeJS.ProcessEnv,
  cwd: string,
  workspaceId: string,
  opts: LocalSyncOptions = {},
): Promise<LocalSyncResult> {
  const files: LocalSyncResult["files"] = { written: 0, skipped: 0, changed: [], errors: [] };
  const ownedPaths = new Set<string>();

  // 1. Hook script first — it registers the command path the settings merger
  // serializes into .claude/settings.json.
  let hookScript: LocalSyncResult["hook_script"];
  try {
    const installed = await installCliHookScript(
      env,
      opts.hookScriptSource === undefined ? {} : { scriptSource: opts.hookScriptSource },
    );
    hookScript = { ok: true, hook_command_path: installed.hookCommandPath };
  } catch (err) {
    hookScript = {
      ok: false,
      hook_command_path: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 2. Claude Code's hook entries (only when the script actually landed — an entry pointing at a
  // missing script would break every tool call): in `.claude/settings.local.json`, the personal project
  // file, never the team's shared `.claude/settings.json` (./claude-settings-hook.ts).
  // A sync that names the agents it serves writes Claude Code's project files only when Claude Code
  // is one of them: setting up Codex must not put a Claude Code hook into the project.
  // The agents this sync serves: named by the caller, else the ones in use here.
  const activeEngines = opts.activeEngines ?? (await enginesInUse(cwd, env));
  const servesClaude = activeEngines.includes("claude-code");
  // A Claude Code plugin delivers the hook for this workspace: a settings entry would run beside it.
  const pluginHook = await pluginOwnsHooks("claude-code", cwd, env);
  const forget: string[] = [];
  if (hookScript.ok && !pluginHook && servesClaude) {
    const ledger = (await readManagedFileOwnershipManifest(cwd).catch(() => ({ files: [] }))).files.map((f) => f.path);
    const hook = await syncClaudeSettingsHook(cwd, { home: env.HOME && env.HOME.trim() !== "" ? env.HOME : homedir(), ledger });
    files.written += hook.changed.length;
    files.changed.push(...hook.changed);
    files.errors.push(...hook.errors);
    if (hook.target) ownedPaths.add(hook.target);
    // Pathrule's entries are out of the shared file: the ledger no longer claims it.
    if (hook.changed.includes(CLAUDE_SHARED_SETTINGS)) forget.push(CLAUDE_SHARED_SETTINGS);
  }

  try {
    await recordManagedFileOwnership({
      workspaceRoot: cwd,
      paths: Array.from(ownedPaths),
      owner: CLI_MANAGED_FILE_OWNER,
      ownerVersion: CLI_VERSION,
    });
    if (forget.length > 0) await forgetManagedFileOwnership({ workspaceRoot: cwd, paths: forget });
  } catch (err) {
    files.errors.push({
      path: ".pathrule/managed-files.json",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 4 + 5 share one store: render the per-directory compiled
  // knowledge files, then warm the offline hook-index from the same store.
  let companion: LocalSyncResult["companion"];
  let hookIndex: HookIndexSyncResult;
  // The render takes the protocol-channel decision; the index writer below reuses
  // it. Taking it twice is how the companion files and the hook index end up
  // disagreeing, and the losing case of that disagreement is no protocol at all.
  let protocol: string | undefined;
  let teamContext: string | undefined;
  // The store is the home's Pathrule host's (./host-session.ts), unless the caller names one.
  const session = opts.store ? null : cliHostSession(env);
  const local = session ? await session.store(workspaceId) : null;
  const backend: KnowledgeBackend = opts.store?.backend ?? local!;
  try {
    const outcome = await rerenderMultiClientLocal({
      backend,
      workspaceId,
      workspaceName:
        opts.store?.workspaceName ?? (await local!.getWorkspaceName(workspaceId)) ?? workspaceId,
      workspaceRoot: cwd,
      userId: opts.store?.userId ?? resolveLocalPrincipal(env),
      runtimeOwner: CLI_MANAGED_FILE_OWNER,
      runtimeVersion: CLI_VERSION,
      env,
      // Opted in: the syncHookIndex call below receives the same decision.
      resolveChannel: true,
      activeEngines,
    });
    protocol = outcome.protocolChannel?.protocol;
    teamContext = outcome.teamContext;

    // Claude Code's protocol copy: written, or REMOVED in signature mode.
    // Removing is the half that is easy to forget. Nothing sweeps this path, so a
    // copy left behind keeps reaching turn zero and drifts from the protocol the
    // hook injects. Driven by the SAME decision the render just took, so the file
    // and the index cannot disagree about which channel carries the protocol.
    // A sync that does not serve Claude Code leaves the file as it finds it.
    if (servesClaude) {
      try {
        const protocolFile = await syncClaudeProtocolFile(cwd, {
          signed: outcome.protocolChannel?.signatureClients.includes("claude-code") === true,
        });
        if (protocolFile === "written") files.written += 1;
        else files.skipped += 1;
        if (protocolFile === "written" || protocolFile === "removed") files.changed.push(CLAUDE_PROTOCOL_FILE);
      } catch (err) {
        files.errors.push({
          path: CLAUDE_PROTOCOL_FILE,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    companion = {
      ok: outcome.ok,
      enabled: outcome.enabled,
      written: outcome.disk.written,
      skipped: outcome.disk.skipped,
      removed: outcome.disk.removed,
      changed: outcome.disk.changed,
      legacy_removed: outcome.legacySweep?.removed ?? [],
      legacy_held: outcome.legacySweep?.held ?? [],
      errors: outcome.disk.errors,
      error: outcome.error,
    };
  } catch (err) {
    companion = {
      ok: false,
      enabled: [],
      written: 0,
      skipped: 0,
      removed: 0,
      changed: [],
      legacy_removed: [],
      legacy_held: [],
      errors: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    hookIndex = opts.store?.writeHookIndex
      ? await opts.store.writeHookIndex({ protocol, teamContext })
      : await syncHookIndex({
          backend,
          workspaceId,
          workspaceRoot: cwd,
          env,
          protocol,
          teamContext,
          // The person's entries travel with every write of the index, or a sync drops them.
          ...(await openPersonalIndexEntries(userKnowledgeStoreFor({ env }), join(pathruleHome(env), "cache", workspaceId), workspaceId, [cwd])),
        });
  } catch (err) {
    hookIndex = {
      ok: false,
      path: null,
      refreshed_episodes: false,
      schema_version: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await session?.close();
  }

  const ok =
    hookScript.ok && files.errors.length === 0 && companion.ok && hookIndex.ok;
  return {
    ok,
    workspace_id: workspaceId,
    workspace_root: cwd,
    hook_script: hookScript,
    files,
    companion,
    hook_index: hookIndex,
    error: ok
      ? undefined
      : !hookScript.ok
        ? "hook_script_install_failed"
        : files.errors.length > 0
          ? "local_file_sync_failed"
          : !companion.ok
            ? "companion_render_failed"
            : "hook_index_sync_failed",
  };
}
