// SPDX-License-Identifier: Apache-2.0
// Module-level setter for the resolved absolute hook command path.
//
// Renderer-safe (no node:os). Each Node entry point — the CLI,
// MCP server, build scripts — calls setHookCommand(absolutePath) at
// startup. Mergers in pathrule-protocol.ts and client-config-writer.ts
// read this value at write time. If a merger runs before the setter
// is called we throw a loud error rather than silently embedding a
// tilde path that AI clients without shell-spawn (Codex) cannot
// resolve.

let resolvedHookCommand: string | null = null;

/**
 * Cross-platform absolute path test. Renderer-safe (no `node:path` import).
 * POSIX leading slash, Windows drive letter, or Windows UNC are accepted.
 */
function looksAbsolute(p: string): boolean {
  if (p.startsWith("/")) return true; // POSIX
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true; // Windows drive (C:\, D:/)
  if (p.startsWith("\\\\")) return true; // Windows UNC (\\server\share)
  return false;
}

export function setHookCommand(absolutePath: string): void {
  if (typeof absolutePath !== "string" || absolutePath.length === 0) {
    throw new Error("setHookCommand requires a non-empty string");
  }
  if (absolutePath.startsWith("~")) {
    throw new Error(
      `setHookCommand requires an absolute path; got ${absolutePath}. ` +
        "Tilde paths are not expanded by Codex's hook spawn (no shell), " +
        "so they ENOENT silently. Resolve homedir() in the caller.",
    );
  }
  if (!looksAbsolute(absolutePath)) {
    throw new Error(
      `setHookCommand requires an absolute path; got ${absolutePath}. ` +
        "Relative paths (e.g. bin/pathrule-hook.js) resolve against the AI " +
        "client's working directory at hook spawn time, which is not stable.",
    );
  }
  resolvedHookCommand = absolutePath;
}

export function getHookCommand(): string {
  if (resolvedHookCommand === null) {
    throw new Error(
      "Pathrule hook command not configured. Each Node entry point " +
        "(the CLI, the host, the MCP server, build scripts) must call " +
        "setHookCommand(absolutePath) at startup before invoking any " +
        "merger (ensureClaudeSettingsHook, ensureCodexHooks, etc.).",
    );
  }
  return resolvedHookCommand;
}

/** Test-only reset hook. Do not call from production code. */
export function __resetHookCommandForTests(): void {
  resolvedHookCommand = null;
}
