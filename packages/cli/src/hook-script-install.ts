// SPDX-License-Identifier: Apache-2.0
// CLI-side hook script materializer.
//
// This module ships the hook script source as a build-time embedded constant
// and writes it to ~/.pathrule/bin/ on every `pathrule sync`. Run from source
// (`pnpm --filter @pathrule/cli dev`), nothing is embedded and it reads the
// checkout's own files, the same ones a build embeds.
//
// Windows invocation contract (chosen here):
//   - We DO NOT register the bare .js path as the hook command. AI clients
//     that spawn hooks without a shell (Codex on Windows) cannot execute a
//     .js file directly.
//   - We DO write a `.cmd` shim next to the .js file. The shim is
//     `@node "%~dp0pathrule-hook.js" %*`, which is the standard npm-style
//     wrapper and is directly executable by spawn-without-shell callers.
//   - setHookCommand receives the .cmd path on Windows, the .js path on
//     POSIX.
//
// The chosen format is fixture-tested by hook-script-install.test.ts so a
// later refactor cannot silently fall back to a bare .js path on Windows.

import { chmod, readFile, rm, stat } from "node:fs/promises";

import { pathruleHome } from "@pathrule/core/storage/paths.js";
import { setHookCommand } from "@pathrule/integrations/hook-supervisor/hook-command.js";
import { atomicWrite } from "@pathrule/core/storage/atomic-write.js";

import { writeRuntimeManifest } from "@pathrule/integrations/native/runtime-manifest-io.js";
import { HOOK_EXTENSION_CONTRACT } from "@pathrule/protocol/hook-extension.js";
import { SUPPORTED_HOOK_INDEX_SCHEMAS } from "@pathrule/protocol/hook-index.js";

import { CLI_VERSION } from "./cli-version.js";
import { cliSelfCommand } from "./local/self-command.js";
import { cliPlatform } from "./platform.js";
import { cliHookExtensions } from "./plugin.js";

declare const __BUILD_HOOK_SCRIPT_SOURCE__: string;
declare const __BUILD_EMBED_HELPER_SOURCE__: string;

// In tests / dev / type-checking the define is not substituted; fall back
// to an empty string so we can mock or read the source from disk.
const EMBEDDED_HOOK_SCRIPT: string =
  typeof __BUILD_HOOK_SCRIPT_SOURCE__ === "string" ? __BUILD_HOOK_SCRIPT_SOURCE__ : "";
// The prompt-embedding helper the hook spawns for relevance ranking. Written
// next to the hook; if absent the hook degrades to lexical ranking.
const EMBEDDED_EMBED_HELPER: string =
  typeof __BUILD_EMBED_HELPER_SOURCE__ === "string" ? __BUILD_EMBED_HELPER_SOURCE__ : "";

/**
 * A hook file from this checkout, for a CLI run from source where no build embedded it. Empty
 * outside a checkout (a build always embeds), and the caller then reports the missing source.
 */
async function fromCheckout(file: string): Promise<string> {
  try {
    return await readFile(
      new URL(`../../integrations/src/hook-supervisor/${file}`, import.meta.url),
      "utf8",
    );
  } catch {
    return "";
  }
}

/**
 * Hook extensions no release installs any more. An old install may have left one beside the hook,
 * which no longer loads it; the installer removes it so the bin directory holds only what runs.
 */
const RETIRED_HOOK_EXTENSIONS = ["pathrule-hook-engine.cjs"] as const;

const WINDOWS_CMD_SHIM = `@echo off
node "%~dp0pathrule-hook.js" %*
`;

export interface HookScriptInstallResult {
  /** Path written to disk for the .js script. */
  scriptPath: string;
  /** When on win32, path of the .cmd shim. */
  shimPath: string | null;
  /** The path registered with setHookCommand. */
  hookCommandPath: string;
  /** True when we actually wrote / rewrote the script. */
  changed: boolean;
}

export interface HookScriptInstallOptions {
  /** Override the embedded script source (tests only). */
  scriptSource?: string;
  /** Override the embedded embed-query.cjs source (tests only). */
  embedHelperSource?: string;
  /** Override the embedded hook extensions, file name -> source (tests only). */
  extensionSources?: Record<string, string>;
}

/**
 * Pure path resolver used by both the runtime installer and tests. Keeps
 * `joinPathForPlatform` consistent across the .js path, the .cmd shim,
 * and the bin dir so tests can lock the Windows shape without touching
 * the filesystem.
 */
export function resolveCliHookScriptPaths(env: NodeJS.ProcessEnv = process.env): {
  binDir: string;
  scriptPath: string;
  shimPath: string | null;
  hookCommandPath: string;
  embedHelperPath: string;
} {
  const platform = cliPlatform(env);
  const home = pathruleHome(env);
  const binDir = joinPathForPlatform(platform, home, "bin");
  const scriptPath = joinPathForPlatform(platform, binDir, "pathrule-hook.js");
  const shimPath =
    platform === "win32" ? joinPathForPlatform(platform, binDir, "pathrule-hook.cmd") : null;
  const hookCommandPath = platform === "win32" && shimPath ? shimPath : scriptPath;
  const embedHelperPath = joinPathForPlatform(platform, binDir, "embed-query.cjs");
  return { binDir, scriptPath, shimPath, hookCommandPath, embedHelperPath };
}

/**
 * Ensure the Pathrule hook script lives at PATHRULE_HOME/bin/, generate
 * a Windows shim when needed, and tell the in-process hook merger which
 * absolute path to write into AI-client config files.
 */
export async function installCliHookScript(
  env: NodeJS.ProcessEnv = process.env,
  opts: HookScriptInstallOptions = {},
): Promise<HookScriptInstallResult> {
  const { binDir, scriptPath, shimPath, hookCommandPath, embedHelperPath } =
    resolveCliHookScriptPaths(env);
  const platform = cliPlatform(env);
  const source = opts.scriptSource ?? (EMBEDDED_HOOK_SCRIPT || (await fromCheckout("pathrule-hook.js")));

  if (!source || source.length === 0) {
    throw new Error(
      "Pathrule hook script source is empty. The CLI bundle did not embed " +
        "__BUILD_HOOK_SCRIPT_SOURCE__ — check tsup.config.ts and the " +
        "scripts/build-time-cli-defines.mjs loader.",
    );
  }

  // atomicWrite (via writeIfChanged) creates the parent dir, so no explicit mkdir.
  const changed = await writeIfChanged(scriptPath, source);

  // Write the embed helper next to the hook. Best-effort: an empty source (dev /
  // type-check, where the define is not substituted) just skips the write — the
  // hook then degrades to lexical ranking rather than failing the whole sync.
  const embedSource =
    opts.embedHelperSource ?? (EMBEDDED_EMBED_HELPER || (await fromCheckout("embed-query.cjs")));
  if (embedSource && embedSource.length > 0) {
    await writeIfChanged(embedHelperPath, embedSource);
  }
  // The extensions sit beside the hook, which loads them from its own directory. The installed
  // plugins ship them; without any the hook runs its open defaults, so an empty set is a complete
  // install, not a broken one.
  for (const [name, body] of Object.entries(opts.extensionSources ?? cliHookExtensions())) {
    if (!/^[A-Za-z0-9._-]+\.cjs$/.test(name) || !body) continue;
    if ((RETIRED_HOOK_EXTENSIONS as readonly string[]).includes(name)) continue;
    await writeIfChanged(joinPathForPlatform(platform, binDir, name), body);
  }
  for (const name of RETIRED_HOOK_EXTENSIONS) {
    await rm(joinPathForPlatform(platform, binDir, name), { force: true });
  }
  if (platform !== "win32") {
    // Best-effort executable bit so users running the script directly get
    // a friendly error instead of "permission denied".
    try {
      await chmod(scriptPath, 0o755);
    } catch {
      /* non-fatal on filesystems that don't honor chmod */
    }
  } else if (shimPath) {
    await writeIfChanged(shimPath, WINDOWS_CMD_SHIM);
  }

  setHookCommand(hookCommandPath);
  await recordRuntimeManifest(scriptPath, env);

  return { scriptPath, shimPath, hookCommandPath, changed };
}

/**
 * Describe the runtime that just installed the hook, for provider plugins' launchers
 * (protocol/runtime-manifest.ts). Written only when this process knows how it runs itself as a
 * plain `node <entry>`; a library use or a development run (an entry behind loader flags) writes
 * nothing. The mode, the MCP launch and the maintenance consent are kept as setup recorded them.
 */
async function recordRuntimeManifest(hookPath: string, env: NodeJS.ProcessEnv): Promise<void> {
  const self = cliSelfCommand();
  const entry = self?.args.length === 1 ? self.args[0] : undefined;
  if (!self || !entry || !/\.(c|m)?js$/.test(entry)) return;
  try {
    await writeRuntimeManifest(
      {
        runtimeVersion: CLI_VERSION,
        hookExtensionContract: HOOK_EXTENSION_CONTRACT,
        hookIndexSchemas: [...SUPPORTED_HOOK_INDEX_SCHEMAS],
        hookPath,
        cli: { node: self.command, entry, ...(self.env ? { env: stringEnv(self.env) } : {}) },
      },
      env,
    );
  } catch {
    // The hook works without it; only a plugin launcher needs it, and `pathrule integrations
    // repair` writes it again.
  }
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === "string") out[key] = value;
  return out;
}

async function writeIfChanged(target: string, body: string): Promise<boolean> {
  try {
    const existing = await readFile(target, "utf8");
    if (existing === body) return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await atomicWrite(target, body);
  return true;
}

function joinPathForPlatform(platform: NodeJS.Platform, base: string, segment: string): string {
  const sep = platform === "win32" ? "\\" : "/";
  const cleanBase = base.replace(/[\\/]+$/, "");
  const cleanSegment = segment.replace(/^[\\/]+/, "");
  return `${cleanBase}${sep}${cleanSegment}`;
}

/** Exported only for tests. */
export const __WINDOWS_CMD_SHIM_FOR_TESTS = WINDOWS_CMD_SHIM;

/** Exported for tests that need to know whether the build embedded the script. */
export function getEmbeddedHookScriptSourceForTests(): string {
  return EMBEDDED_HOOK_SCRIPT;
}

/** Force the install to verify the on-disk script body once (used by sync()). */
export async function hookScriptInstallSanityProbe(scriptPath: string): Promise<boolean> {
  try {
    const info = await stat(scriptPath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}
