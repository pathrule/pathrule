// SPDX-License-Identifier: Apache-2.0
// Disk-marker detection for AI client presence in a workspace. Used by the
// skill materializer + multi-client renderer to decide which agent-target's
// folders to write into when no explicit user selection exists.
//
// Node-only. Import directly from "./disk-detection.js" —
// do NOT re-export through the shared barrel (sandboxed preload + renderer).

import { access, readFile } from "node:fs/promises";
import { constants as FS_CONSTS } from "node:fs";
import { homedir } from "node:os";

import { integrationFor } from "@pathrule/protocol/integration-registry.js";

import { pathWithin, readIntegrationRegistry } from "../native/registry-io.js";
import { join } from "node:path";

import {
  HOOK_CONFIG_LOCATIONS,
  configInstallsPathruleHook,
} from "../client-renderers/hook-installed.js";
import { AGENT_TARGETS, type AgentTargetId } from "@pathrule/core/skills/agent-targets.js";
import { isPathruleManaged } from "@pathrule/core/paths/ownership.js";
import { CODEX_TOML_START as CODEX_TOML_MARKER } from "../pathrule-protocol.js";

/**
 * Marker files whose presence implies the client is wired into this
 * workspace. Pathrule-owned filenames only — bare directories (`.claude`,
 * `.cursor`, `.codex`, `.windsurf`) are excluded so a leftover folder from
 * the AI tool's own state (e.g. `.claude/scheduled_tasks.lock`,
 * `.cursor/mcp.json` written by the user) doesn't keep the renderer
 * re-enabling a client the user has explicitly disabled.
 */
const MARKERS: Record<AgentTargetId, readonly string[]> = {
  "claude-code": ["CLAUDE.md", ".claude/rules/pathrule-protocol.md", ".claude/settings.json"],
  cursor: [".cursorrules", ".cursor/rules/pathrule-protocol.mdc", ".cursor/hooks.json"],
  // AGENTS.md is NOT a marker: it is the cross-agent standard a person keeps for every agent, and taking
  // it for a Codex setup wrote Codex's files into Claude-only projects (see `enginesInUse`).
  codex: ["codex.md", ".codex/hooks.json", ".codex/config.toml"],
  windsurf: [".windsurfrules", ".windsurf/rules/pathrule-protocol.md"],
  // Bare `.github/` is deliberately NOT a marker (every repo has one).
  copilot: [".github/copilot-instructions.md", ".github/hooks/pathrule.json"],
};

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, FS_CONSTS.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan workspaceRoot for any known client marker. Returns the deduplicated
 * list of detected clients. Order: stable by AGENT_TARGETS key order so
 * downstream callers can rely on it for UI sorting.
 */
export async function detectClientsOnDisk(workspaceRoot: string): Promise<AgentTargetId[]> {
  const ids = Object.keys(AGENT_TARGETS) as AgentTargetId[];
  const checks = await Promise.all(
    ids.map(async (id) => {
      for (const marker of MARKERS[id]) {
        if (await exists(join(workspaceRoot, marker))) return id;
      }
      return null;
    }),
  );
  return checks.filter((x): x is AgentTargetId => x !== null);
}

/**
 * Resolve which clients should receive disk writes (skills, companion files)
 * for this workspace + user.
 *
 * Precedence:
 *   1. Explicit selection in `user_workspace_paths.selected_ai_clients` —
 *      treated as the canonical enabled set when non-empty (the user has
 *      toggled at least one tool through onboarding/tray/settings).
 *   2. Disk markers — when no explicit selection exists, every client whose
 *      footprint is visible in the workspace is enabled. This is the
 *      signal-driven default that lets a teammate's `.cursorrules` commit
 *      auto-enable Cursor for everyone who clones the repo.
 *   3. `DEFAULT_ACTIVE_AGENT_TARGETS` — final safety net (claude-code only)
 *      so legacy workspaces with no signal at all keep their existing
 *      behaviour.
 *
 * Anything that came back from selection but isn't a known AgentTargetId is
 * dropped — guards against schema drift if a future client id is removed.
 */
export function resolveEnabledClients(input: {
  selected: readonly string[] | null | undefined;
  detected: readonly AgentTargetId[];
  fallback: readonly AgentTargetId[];
  /**
   * The agents the caller serves (claude-code, codex, opencode). See
   * `requiredTargetsForEngines`.
   */
  activeEngines?: readonly string[];
}): AgentTargetId[] {
  const valid = new Set(Object.keys(AGENT_TARGETS) as AgentTargetId[]);
  const sel = (input.selected ?? []).filter(
    (s): s is AgentTargetId => typeof s === "string" && valid.has(s as AgentTargetId),
  );

  const base = sel.length > 0 ? sel : input.detected.length > 0 ? [...input.detected] : [...input.fallback];
  return withEngineTargets(base, input.activeEngines ?? []);
}

/**
 * Targets that must be enabled for a set of agents to receive anything.
 *
 * OpenCode is not a companion target in its own right: it reads AGENTS.md, which
 * Pathrule writes as part of the `codex` target — so with only `claude-code`
 * ticked, it would get no Pathrule knowledge at all. Delivery must follow the
 * agents actually in use, not an unrelated checkbox.
 */
export function requiredTargetsForEngines(engines: readonly string[]): AgentTargetId[] {
  const out = new Set<AgentTargetId>();
  for (const engine of engines) {
    switch (engine) {
      case "claude-code":
        out.add("claude-code");
        break;
      // AGENTS.md readers: the codex target owns that file.
      case "codex":
      case "opencode":
        out.add("codex");
        break;
      default:
        // Any other id has no channel of its own.
        break;
    }
  }
  return [...out];
}

/**
 * The agents a sync serves when its caller names none: Claude Code, and the
 * AGENTS.md readers through the codex target. A sync that names its agents (a
 * native integration does) serves exactly those instead.
 *
 * The name is historical: this was the list of engines Studio could launch.
 * Studio is gone, and its grok, kimi and antigravity engines went with it; they
 * mapped to the same codex target, so dropping them changes no target. The name
 * stays because the Cloud edition's render pipeline imports it.
 */
export const STUDIO_ENGINE_IDS = ["claude-code", "codex", "opencode"] as const;

/**
 * The agents a local sync serves when the caller names none: Claude Code always (the hook's client),
 * and Codex (whose AGENTS.md OpenCode reads too) only when Pathrule was set up for Codex here. A CLI
 * installed somewhere on the machine says nothing about this repository. Serving every engine wrote
 * full-body AGENTS.md files into Claude-only repositories, which Claude Code then read on every turn
 * (measured on PathruleBench v3, 2026-10-16: 34k characters a chain).
 *
 * The person's own AGENTS.md is not that footprint: it is a cross-agent standard, and taking it for one
 * wrote Codex's files into a project whose setup named only Claude Code.
 */
export async function enginesInUse(workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  return (await pathruleCodexFootprint(workspaceRoot, env).catch(() => false)) ? ["claude-code", "codex"] : ["claude-code"];
}

/** Pathrule's own Codex wiring in this project: its hook entry, its config block, its region, or a recorded integration. */
async function pathruleCodexFootprint(root: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const read = (rel: string) => readFile(join(root, rel), "utf8").catch(() => "");
  if (configInstallsPathruleHook(await read(".codex/hooks.json"))) return true;
  if ((await read(".codex/config.toml")).includes(CODEX_TOML_MARKER)) return true;
  for (const file of ["AGENTS.md", "codex.md"]) if (isPathruleManaged(await read(file))) return true;
  const record = integrationFor(await readIntegrationRegistry(env), "codex", root, pathWithin);
  return !!record && record.status === "installed";
}

/** Union of an enabled set with whatever the active engines require. */
export function withEngineTargets(
  enabled: readonly AgentTargetId[],
  engines: readonly string[],
): AgentTargetId[] {
  const out = new Set<AgentTargetId>(enabled);
  for (const target of requiredTargetsForEngines(engines)) out.add(target);
  return [...out];
}

/**
 * Which clients have Pathrule's HOOK installed for this workspace.
 *
 * Distinct from `detectClientsOnDisk`, and the difference is the whole point:
 * that function answers "is this client wired into the workspace at all" from
 * marker files, several of which Pathrule itself writes. This one answers "will
 * something actually deliver the protocol at runtime", which only a real hook
 * entry in the client's own config can prove.
 *
 * Read-only. Any failure resolves to NOT installed, because a wrong "installed"
 * takes the protocol off disk with nothing replacing it, while a wrong "not
 * installed" only leaves a file bigger than it needed to be.
 */
export async function detectInstalledHooks(
  workspaceRoot: string,
  opts: { home?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<AgentTargetId[]> {
  const home = opts.home ?? homedir();
  const out: AgentTargetId[] = [];
  // A native plugin's hooks live in the provider's plugin cache, not in a settings file: the
  // integration registry is what proves them. Only a recorded integration counts, so a plugin
  // installed but never set up keeps the protocol on disk (a duplicate, never a gap).
  // An explicit home (tests, another user's tree) reads the registry under that home.
  const env = opts.env ?? (opts.home ? { ...process.env, PATHRULE_HOME: join(home, ".pathrule") } : process.env);
  const registry = await readIntegrationRegistry(env);
  for (const provider of ["claude-code", "codex"] as const) {
    const record = integrationFor(registry, provider, workspaceRoot, pathWithin);
    if (record && record.channel === "native-plugin" && record.status === "installed") out.push(provider);
  }
  for (const id of Object.keys(HOOK_CONFIG_LOCATIONS) as AgentTargetId[]) {
    const locations = HOOK_CONFIG_LOCATIONS[id];
    let installed = false;
    for (const loc of locations) {
      const base = loc.scope === "user" ? home : workspaceRoot;
      let body: string;
      try {
        body = await readFile(join(base, loc.path), "utf8");
      } catch {
        continue;
      }
      if (configInstallsPathruleHook(body)) {
        installed = true;
        break;
      }
    }
    if (installed && !out.includes(id)) out.push(id);
  }
  return out;
}
