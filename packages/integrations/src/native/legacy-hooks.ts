// SPDX-License-Identifier: Apache-2.0
// Pathrule's hook entries in provider settings files: the legacy channel a native plugin replaces.
//
// A plugin's hooks and a settings file's hooks both run (Claude Code runs a plugin's copy beside an
// identical settings entry), so when a plugin takes over, Pathrule's own settings entries go. Only
// entries whose command is Pathrule's hook are touched; every other entry, and every other key of
// the file, stays as the person wrote it. A file that is not valid JSON is reported and never
// rewritten.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { IntegrationProviderId } from "@pathrule/protocol/integration-registry.js";

import { ensureClaudeSettingsHook, ensureCodexHooks, ensureCursorHooks } from "../pathrule-protocol.js";

export interface LegacyHookFile {
  path: string;
  scope: "user" | "project";
  /** Pathrule hook entries the file holds. */
  entries: number;
  /** The file exists but is not valid JSON: never rewritten. */
  unreadable: boolean;
}

/** Codex's user config directory: CODEX_HOME when set, else ~/.codex. */
export function codexHome(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME && env.CODEX_HOME.trim() !== "" ? env.CODEX_HOME : join(home, ".codex");
}

export function legacyHookPaths(
  provider: IntegrationProviderId,
  options: { home: string; projectRoot: string | null; env?: NodeJS.ProcessEnv },
): Array<{ path: string; scope: "user" | "project" }> {
  const out: Array<{ path: string; scope: "user" | "project" }> = [];
  if (provider === "claude-code") {
    out.push({ path: join(options.home, ".claude", "settings.json"), scope: "user" });
    if (options.projectRoot) {
      out.push({ path: join(options.projectRoot, ".claude", "settings.json"), scope: "project" });
      out.push({ path: join(options.projectRoot, ".claude", "settings.local.json"), scope: "project" });
    }
  } else if (provider === "codex") {
    out.push({ path: join(codexHome(options.home, options.env), "hooks.json"), scope: "user" });
    if (options.projectRoot) out.push({ path: join(options.projectRoot, ".codex", "hooks.json"), scope: "project" });
  } else if (provider === "cursor") {
    // `pathrule install cursor` and a sync wrote Pathrule's entries into Cursor's own hook files.
    out.push({ path: join(options.home, ".cursor", "hooks.json"), scope: "user" });
    if (options.projectRoot) out.push({ path: join(options.projectRoot, ".cursor", "hooks.json"), scope: "project" });
  }
  return out;
}

const HOOK_SCRIPT_MARKER = "pathrule-hook";

function countPathruleEntries(parsed: unknown): number {
  const hooks = (parsed as { hooks?: unknown } | null)?.hooks;
  if (!hooks || typeof hooks !== "object") return 0;
  let n = 0;
  for (const matchers of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(matchers)) continue;
    for (const m of matchers) {
      const list = (m as { hooks?: unknown }).hooks;
      if (!Array.isArray(list)) continue;
      for (const h of list) {
        const cmd = (h as { command?: unknown }).command;
        if (typeof cmd === "string" && (cmd.includes(HOOK_SCRIPT_MARKER) || cmd.includes("pathrule_log_activity"))) n += 1;
      }
    }
  }
  return n;
}

/** Which settings files hold Pathrule hook entries for `provider`. */
export async function findLegacyHooks(
  provider: IntegrationProviderId,
  options: { home: string; projectRoot: string | null; env?: NodeJS.ProcessEnv },
): Promise<LegacyHookFile[]> {
  const found: LegacyHookFile[] = [];
  for (const { path, scope } of legacyHookPaths(provider, options)) {
    let body: string;
    try {
      body = await readFile(path, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      if (body.includes(HOOK_SCRIPT_MARKER)) found.push({ path, scope, entries: 0, unreadable: true });
      continue;
    }
    const entries = countPathruleEntries(parsed);
    if (entries > 0) found.push({ path, scope, entries, unreadable: false });
  }
  return found;
}

/**
 * The file's body with Pathrule's hook entries removed, or null when the body is not valid JSON
 * (never rewritten) or holds none.
 */
export function withoutPathruleHooks(provider: IntegrationProviderId, body: string): string | null {
  // Pathrule never wrote hook entries into Gemini's or OpenCode's settings.
  if (provider === "gemini" || provider === "opencode") return null;
  try {
    JSON.parse(body);
  } catch {
    return null;
  }
  const result =
    provider === "claude-code"
      ? ensureClaudeSettingsHook(body, { uninstall: true })
      : provider === "codex"
        ? ensureCodexHooks(body, { uninstall: true })
        : ensureCursorHooks(body, { uninstall: true });
  return result.changed ? result.body : null;
}
