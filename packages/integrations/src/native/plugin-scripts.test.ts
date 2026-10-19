// SPDX-License-Identifier: Apache-2.0
// The plugin's own scripts, run as a provider runs them (a child process, the event on stdin):
// the launcher hands every job to the runtime the manifest names and never installs anything; the
// setup script plans first and changes nothing without approval.

import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { configureScript } from "./plugin-bundle.js";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "assets");
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

const CONFIG = {
  name: "pathrule",
  provider: "claude-code",
  version: "0.7.0",
  minRuntime: "0.7.0",
  launcherContract: 1,
  setupHint: "/pathrule:setup",
  runtime: { package: "@pathrule/cli", version: "0.7.0", integrity: null },
};

async function scripts() {
  const home = await mkdtemp(join(tmpdir(), "pathrule-plugin-"));
  homes.push(home);
  const dir = join(home, "plugin", "scripts");
  await mkdir(dir, { recursive: true });
  const launcher = join(dir, "pathrule-launch");
  const setup = join(dir, "pathrule-setup");
  await writeFile(launcher, configureScript(await readFile(join(ASSETS, "pathrule-launch.cjs"), "utf8"), CONFIG));
  await writeFile(setup, configureScript(await readFile(join(ASSETS, "pathrule-setup.cjs"), "utf8"), CONFIG));
  await chmod(launcher, 0o755);
  await chmod(setup, 0o755);
  return { home, launcher, setup, pathruleHome: join(home, ".pathrule") };
}

function run(
  script: string,
  args: string[],
  env: Record<string, string>,
  stdin = "",
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Through sh, as a provider runs the plugin's command.
    const child = execFile("sh", [script, ...args], { env: { ...process.env, ...env }, timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
    child.stdin!.end(stdin);
  });
}

async function writeManifest(pathruleHome: string, over: Record<string, unknown> = {}) {
  const bin = join(pathruleHome, "bin");
  await mkdir(bin, { recursive: true });
  const hook = join(bin, "pathrule-hook.js");
  await writeFile(
    hook,
    `const raw=require("fs").readFileSync(0,"utf8");process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"X",additionalContext:[process.env.PATHRULE_HOOK_CHANNEL,process.env.PATHRULE_HOOK_PROVIDER,process.env.PATHRULE_HOOK_MCP,JSON.parse(raw).hook_event_name].join("|")}}));process.exit(0);`,
  );
  const cli = join(pathruleHome, "cli.cjs");
  await writeFile(cli, `console.log("cli " + process.argv.slice(2).join(" "));`);
  const mcp = join(pathruleHome, "mcp.cjs");
  await writeFile(mcp, `process.stdin.on("data", (d) => process.stdout.write("echo:" + d)); process.stdin.on("end", () => process.exit(0));`);
  await writeFile(
    join(bin, "runtime.json"),
    JSON.stringify({
      schema_version: 1,
      launcher_contract: 1,
      runtime_version: "0.7.0",
      hook_extension_contract: 1,
      hook_index_schemas: [1, 2],
      hook,
      cli: { node: process.execPath, entry: cli },
      mcp: { command: process.execPath, args: [mcp], env: { PATHRULE_LOCAL: "1" } },
      mode: "local",
      maintenance: { consent: true },
      written_at: "2026-10-10T00:00:00.000Z",
      ...over,
    }),
  );
  return { hook, cli };
}

describe("the launcher", () => {
  it("without a runtime: one setup notice at session start, nothing on other events, never a failure", async () => {
    const s = await scripts();
    const env = { PATHRULE_HOME: s.pathruleHome };
    const start = await run(s.launcher, ["hook"], env, JSON.stringify({ hook_event_name: "SessionStart" }));
    expect(start.code).toBe(0);
    expect(JSON.parse(start.stdout).hookSpecificOutput.additionalContext).toContain("/pathrule:setup");
    const tool = await run(s.launcher, ["hook"], env, JSON.stringify({ hook_event_name: "PreToolUse" }));
    expect(tool.code).toBe(0);
    expect(tool.stdout.trim()).toBe("{}");
  });

  it("with a runtime: runs the canonical hook in process, naming the plugin channel, provider and MCP", async () => {
    const s = await scripts();
    await writeManifest(s.pathruleHome);
    const out = await run(s.launcher, ["hook", "--mcp=none"], { PATHRULE_HOME: s.pathruleHome }, JSON.stringify({ hook_event_name: "UserPromptSubmit" }));
    expect(JSON.parse(out.stdout).hookSpecificOutput.additionalContext).toBe("plugin|claude-code|none|UserPromptSubmit");
  });

  it("refuses a runtime older than the plugin needs, with the reason", async () => {
    const s = await scripts();
    await writeManifest(s.pathruleHome, { runtime_version: "0.6.0" });
    const out = await run(s.launcher, ["hook"], { PATHRULE_HOME: s.pathruleHome }, JSON.stringify({ hook_event_name: "SessionStart" }));
    expect(JSON.parse(out.stdout).hookSpecificOutput.additionalContext).toContain("older than the 0.7.0");
    const status = await run(s.launcher, ["status", "--json"], { PATHRULE_HOME: s.pathruleHome });
    expect(JSON.parse(status.stdout).runtime).toMatchObject({ ok: false, reason: "runtime_too_old" });
  });

  it("starts the runtime's MCP server over stdio, and the runtime's CLI", async () => {
    const s = await scripts();
    await writeManifest(s.pathruleHome);
    const mcp = await run(s.launcher, ["mcp"], { PATHRULE_HOME: s.pathruleHome }, "ping");
    expect(mcp.stdout).toBe("echo:ping");
    const cli = await run(s.launcher, ["cli", "search", "auth"], { PATHRULE_HOME: s.pathruleHome });
    expect(cli.stdout.trim()).toBe("cli search auth");
  });

  it("starts the runtime's own MCP server when the manifest records no launch: the server names no edition", async () => {
    const s = await scripts();
    const { cli } = await writeManifest(s.pathruleHome, { mcp: undefined, mode: undefined });
    await writeFile(cli, `console.log("cli " + process.argv.slice(2).join(" ") + " " + process.env.PATHRULE_MCP_CHANNEL);`);
    const mcp = await run(s.launcher, ["mcp"], { PATHRULE_HOME: s.pathruleHome });
    expect(mcp.code).toBe(0);
    expect(mcp.stdout.trim()).toBe("cli mcp run plugin");
    const status = JSON.parse((await run(s.launcher, ["status", "--json"], { PATHRULE_HOME: s.pathruleHome })).stdout);
    expect(status.runtime).toMatchObject({ ok: true, mcp: true });
    expect(status.runtime).not.toHaveProperty("mode");
  });

  it("the MCP server explains a missing runtime instead of hanging", async () => {
    const s = await scripts();
    const out = await run(s.launcher, ["mcp"], { PATHRULE_HOME: s.pathruleHome });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("/pathrule:setup");
  });
});

describe("the setup script", () => {
  // A POSIX PATH and a symlinked `node`: Windows resolves `node.exe` through PATHEXT instead.
  it.skipIf(process.platform === "win32")("plans a provisioning when no runtime is here, and applies nothing without --yes", async () => {
    const s = await scripts();
    // Only node on PATH: a machine with a `pathrule` beside node (npm link) must not be found.
    const bin = join(s.home, "bin");
    await mkdir(bin, { recursive: true });
    await symlink(process.execPath, join(bin, "node"));
    const env = { PATHRULE_HOME: s.pathruleHome, PATH: ["/usr/bin", "/bin", bin].join(":") };
    const plan = await run(s.setup, ["plan", "--json"], env);
    const parsed = JSON.parse(plan.stdout);
    expect(parsed.approval_required).toBe(true);
    expect(parsed.plan.runtime.action).toBe("provision");
    expect(parsed.plan.steps.join("\n")).toContain("@pathrule/cli@0.7.0");
    expect(parsed.plan.steps.join("\n")).toContain("better-sqlite3");
    const apply = await run(s.setup, ["apply", "--json"], env);
    expect(apply.code).toBe(2);
    expect(JSON.parse(apply.stdout).ok).toBe(false);
  });

  it("reuses a compatible runtime the manifest names", async () => {
    const s = await scripts();
    await writeManifest(s.pathruleHome);
    const plan = JSON.parse((await run(s.setup, ["plan", "--json"], { PATHRULE_HOME: s.pathruleHome })).stdout);
    expect(plan.plan.runtime).toMatchObject({ action: "reuse", source: "runtime-manifest", version: "0.7.0" });
    const status = JSON.parse((await run(s.setup, ["status", "--json"], { PATHRULE_HOME: s.pathruleHome })).stdout);
    // A manifest an older runtime wrote with one machine-wide mode still reads; status names none.
    expect(status.runtime).toMatchObject({ ok: true, version: "0.7.0" });
    expect(status.runtime).not.toHaveProperty("mode");
  });

  it("hands an approved apply to the runtime's own integrations attach", async () => {
    const s = await scripts();
    const { cli } = await writeManifest(s.pathruleHome);
    await writeFile(
      cli,
      `const args=process.argv.slice(2);console.log(JSON.stringify({schema_version:1,ok:true,command:"integrations attach",cwd:process.cwd(),data:{summary:["attached " + args.join(" ")]}}));`,
    );
    const out = JSON.parse((await run(s.setup, ["apply", "--yes", "--json", "--mode", "local"], { PATHRULE_HOME: s.pathruleHome })).stdout);
    expect(out.ok).toBe(true);
    const line = out.result.summary[0] as string;
    expect(line).toContain("integrations attach --provider claude-code --channel native-plugin --plugin-version 0.7.0");
    expect(line).toContain("--local");
    expect(line).toContain("--maintenance");
  });
});
