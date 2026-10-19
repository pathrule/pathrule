// SPDX-License-Identifier: Apache-2.0
// `pathrule integrations` end to end in a scratch HOME, with a recording `claude` on PATH in place of
// Claude Code's CLI (the real one runs in the native verification script): approval before any
// change, the plugin installed through the provider's own commands, the person's settings kept,
// idempotent repeats, diagnosis, and removal of exactly what was recorded.
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../run.js";

class MemoryWriter {
  chunks: string[] = [];
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(String(chunk));
    return true;
  }
  toString() {
    return this.chunks.join("");
  }
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});


/** PATH with only `bin` and the system's own tools; on Windows also what cmd.exe needs to start. */
function testPath(bin: string): NodeJS.ProcessEnv {
  if (process.platform !== "win32") return { PATH: `${bin}:/usr/bin:/bin` };
  const system = process.env.SystemRoot ?? "C:\\Windows";
  return {
    PATH: [bin, join(system, "System32")].join(delimiter),
    SystemRoot: system,
    ComSpec: process.env.ComSpec ?? join(system, "System32", "cmd.exe"),
    PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
  };
}

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "pathrule-integrations-cli-"));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  const calls = join(root, "claude-calls.log");
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(bin, { recursive: true });
  const claude = join(bin, "claude");
  await writeFile(claude, `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\necho '{"outcome":"ok"}'\n`);
  await chmod(claude, 0o755);
  // Windows finds and runs the `.cmd` shim npm installs, as it does for the real `claude`.
  await writeFile(`${claude}.cmd`, `@echo off\r\necho %*>> "${calls}"\r\necho {"outcome":"ok"}\r\n`);
  await writeFile(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      model: "opus",
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "/old/.pathrule/bin/pathrule-hook.js" }] }] },
    }),
  );
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATHRULE_HOME: join(home, ".pathrule"),
    ...testPath(bin),
    NODE_ENV: "test",
  };
  return { root, home, env, calls };
}

async function cli(env: NodeJS.ProcessEnv, argv: string[]) {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const code = await runCli(argv, { cwd: env.HOME as string, env, stdout, stderr });
  return { code, stdout: stdout.toString(), stderr: stderr.toString() };
}

describe("pathrule integrations", () => {
  it("lists the agents it found and what it supports", async () => {
    const s = await scratch();
    const out = await cli(s.env, ["integrations", "list", "--json"]);
    expect(out.code).toBe(0);
    const providers = JSON.parse(out.stdout).data.providers as Array<{ id: string; detected: boolean; support: string }>;
    expect(providers.find((p) => p.id === "claude-code")).toMatchObject({ detected: true, support: "native-plugin" });
    expect(providers.find((p) => p.id === "opencode")).toMatchObject({ support: "native-plugin" });
  });

  it("changes nothing without approval, then installs, keeps the person's settings, and repeats idempotently", async () => {
    const s = await scratch();
    const plan = await cli(s.env, ["integrations", "add", "claude-code", "--json"]);
    expect(plan.code).toBe(2);
    expect(JSON.parse(plan.stdout).error.code).toBe("approval_required");
    await expect(readFile(s.calls, "utf8")).rejects.toThrow();

    const applied = await cli(s.env, ["integrations", "add", "claude-code", "--local", "--yes", "--json"]);
    expect(applied.code).toBe(0);
    const calls = await readFile(s.calls, "utf8");
    expect(calls).toContain(`plugin marketplace add ${join(s.home, ".pathrule", "integrations", "marketplace")} --scope user --json`);
    expect(calls).toContain("plugin install pathrule@pathrule --scope user --json");
    const settings = JSON.parse(await readFile(join(s.home, ".claude", "settings.json"), "utf8"));
    expect(settings.model).toBe("opus");
    expect(JSON.stringify(settings)).not.toContain("pathrule-hook.js");
    const manifest = JSON.parse(await readFile(join(s.home, ".pathrule", "bin", "runtime.json"), "utf8"));
    expect(manifest).toMatchObject({ maintenance: { consent: true } });
    // One MCP server for every project, whatever its edition: no machine-wide mode, no edition in the launch.
    expect(manifest).not.toHaveProperty("mode");
    expect(manifest.mcp.args.slice(-2)).toEqual(["mcp", "run"]);
    expect(manifest.mcp.env).not.toHaveProperty("PATHRULE_LOCAL");

    const again = await cli(s.env, ["integrations", "add", "claude-code", "--local", "--yes", "--json"]);
    expect(again.code).toBe(0);
    const registry = JSON.parse(await readFile(join(s.home, ".pathrule", "integrations", "registry.json"), "utf8"));
    expect(registry.integrations).toHaveLength(1);

    const doctor = await cli(s.env, ["integrations", "doctor", "--json"]);
    expect(JSON.parse(doctor.stdout).data.findings.filter((f: { level: string }) => f.level === "error")).toEqual([]);
  });

  it("refuses an agent it does not know, and removes exactly what it installed", async () => {
    const s = await scratch();
    const unknown = await cli(s.env, ["integrations", "add", "windsurf", "--yes", "--json"]);
    expect(unknown.code).toBe(64);
    expect(JSON.parse(unknown.stdout).error.message).toContain('unknown agent "windsurf"');

    await cli(s.env, ["integrations", "add", "claude-code", "--local", "--yes", "--json"]);
    const removed = await cli(s.env, ["integrations", "remove", "claude-code", "--yes", "--json"]);
    expect(removed.code).toBe(0);
    const calls = await readFile(s.calls, "utf8");
    expect(calls).toContain("plugin uninstall pathrule@pathrule --scope user --json");
    expect(calls).toContain("plugin marketplace remove pathrule");
    const registry = JSON.parse(await readFile(join(s.home, ".pathrule", "integrations", "registry.json"), "utf8"));
    expect(registry.integrations).toEqual([]);
    // The person's own settings survive the removal too.
    expect(JSON.parse(await readFile(join(s.home, ".claude", "settings.json"), "utf8")).model).toBe("opus");
  });
});
