// SPDX-License-Identifier: Apache-2.0
// A Pathrule CLI run from a temporary package cache (`npx @pathrule/cli integrations`, `pnpm dlx`,
// `bunx`) must not record itself as the runtime: the hooks and the MCP server would point into a
// cache that is cleaned up later. Before it changes anything, it makes the same runtime version
// available under <PATHRULE_HOME>/runtime/<version> (the plugin's own setup script does the install,
// with the person's approval) and hands the rest of the command to that runtime.
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureScript } from "@pathrule/integrations/native/plugin-bundle.js";

import { CLI_VERSION } from "../cli-version.js";
import { resolveCliEntrypoint } from "../install-local.js";
import { nativePluginAssets } from "./plugin-assets.js";

const EPHEMERAL = /[\\/](_npx|dlx|\.bun[\\/]install[\\/]cache|bunx-[^\\/]*)[\\/]/;

/** Whether this CLI runs from a package manager's temporary cache. */
export function runsFromTemporaryCache(env: NodeJS.ProcessEnv = process.env, entry?: string): boolean {
  if (env.PATHRULE_STABLE_RUNTIME === "1") return false;
  let path = entry;
  if (!path) {
    try {
      path = resolveCliEntrypoint();
    } catch {
      return false;
    }
  }
  return EPHEMERAL.test(path) || path.startsWith(join(tmpdir(), "/"));
}

export interface StableRuntime {
  node: string;
  entry: string;
}

/** Make this version's runtime available on disk (approved by the caller). */
export async function provisionStableRuntime(
  env: NodeJS.ProcessEnv,
  stderr: { write(chunk: string): unknown },
): Promise<{ ok: true; runtime: StableRuntime } | { ok: false; message: string; recovery: string | null }> {
  const assets = await nativePluginAssets();
  const script = configureScript(assets.setup, {
    name: "pathrule",
    provider: "claude-code",
    version: CLI_VERSION,
    minRuntime: CLI_VERSION,
    launcherContract: 1,
    setupHint: "pathrule integrations",
    // This very version, fetched by npm under the person's own registry settings; npm checks every
    // package's integrity against the registry and the CLI's shrinkwrap.
    runtime: { package: "@pathrule/cli", version: CLI_VERSION, integrity: null },
  });
  const dir = join(tmpdir(), `pathrule-provision-${process.pid}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "pathrule-setup.cjs");
  await writeFile(file, script, { mode: 0o700 });
  try {
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, [file, "provision", "--yes", "--json"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => stderr.write(d.toString("utf8")));
      child.on("close", (code) => resolve({ code, stdout }));
      child.on("error", () => resolve({ code: 1, stdout }));
    });
    let parsed: { ok?: boolean; runtime?: StableRuntime; error?: { message?: string; recovery?: string | null } } = {};
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      parsed = {};
    }
    if (result.code === 0 && parsed.ok && parsed.runtime?.entry) {
      return { ok: true, runtime: { node: parsed.runtime.node, entry: parsed.runtime.entry } };
    }
    return {
      ok: false,
      message: parsed.error?.message ?? "the runtime install did not finish",
      recovery: parsed.error?.recovery ?? null,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Run the same command in the stable runtime. JSON output is captured and returned as text. */
export function runInStableRuntime(
  runtime: StableRuntime,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  capture: boolean,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(runtime.node, [runtime.entry, ...args], {
      env: { ...env, PATHRULE_STABLE_RUNTIME: "1" },
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let stdout = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
    child.on("error", () => resolve({ code: 1, stdout }));
  });
}
