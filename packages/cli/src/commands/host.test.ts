// SPDX-License-Identifier: Apache-2.0
// `pathrule host`: started in the background through the CLI's own entry, found by `status`,
// stopped by `stop`, stopping by itself when idle, and run in the foreground with the host plugins
// of the CLI's plugins.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CORE_PACKAGE } from "@pathrule/core/package-instance.js";
import { hostRecordFile, processAlive, readHostRecord } from "@pathrule/host/discovery.js";
import type { HostPlugin } from "@pathrule/host/plugin.js";
import { CLI_PLUGIN_CONTRACT, HOST_PLUGIN_CONTRACT } from "@pathrule/protocol/plugin-contracts.js";

import { CLI_VERSION } from "../cli-version.js";
import type { CommandPlugin } from "../plugin.js";
import { runCli } from "../run.js";
import { parseIdleTimeout } from "./host.js";

const CLI_ENTRY = fileURLToPath(new URL("../index.ts", import.meta.url));
const TSX_LOADER = pathToFileURL(
  join(dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist/loader.mjs"),
).href;
/** This CLI, from its sources: what `host start` launches. */
const SELF = { command: process.execPath, args: ["--import", TSX_LOADER, CLI_ENTRY] };

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

let root: string;
let env: NodeJS.ProcessEnv;

async function run(argv: string[], plugins: CommandPlugin[] = []) {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const exitCode = await runCli(
    [...argv, "--no-color"],
    { cwd: root, env, stdout, stderr, selfCommand: SELF },
    { plugins },
  );
  return { exitCode, stdout: stdout.toString(), stderr: stderr.toString() };
}

async function json(argv: string[]) {
  const result = await run([...argv, "--json"]);
  return { exitCode: result.exitCode, body: JSON.parse(result.stdout) };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pathrule-cli-host-")));
  env = { PATH: process.env.PATH, PATHRULE_HOME: join(root, ".pathrule"), CI: "true" };
});

afterEach(async () => {
  const record = await readHostRecord(env);
  // A foreground host is this test process; only a launched one is killed.
  if (record && record.pid !== process.pid && processAlive(record.pid)) {
    process.kill(record.pid, "SIGKILL");
  }
  rmSync(root, { recursive: true, force: true });
});

describe("pathrule host", { timeout: 60_000 }, () => {
  it("says when no host runs", async () => {
    const text = await run(["host", "status"]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("No Pathrule host is running.");
    expect((await json(["host", "status"])).body).toMatchObject({
      ok: true,
      command: "host status",
      data: { running: false },
    });
    expect((await run(["host", "stop"])).stdout).toContain("No Pathrule host is running.");
  });

  it("starts one in the background, finds it, and stops it", async () => {
    const started = await json(["host", "start"]);
    expect(started.exitCode).toBe(0);
    expect(started.body.data).toMatchObject({
      running: true,
      launched: true,
      version: `cli ${CLI_VERSION}`,
      plugins: [],
    });
    const pid = started.body.data.pid as number;
    expect(pid).not.toBe(process.pid);
    expect(started.body.data.idle).toBeUndefined();

    const again = await run(["host", "start"]);
    expect(again.stdout).toContain(`Already running: the Pathrule host (pid ${pid})`);
    const status = await run(["host", "status"]);
    expect(status.stdout).toContain(`The Pathrule host is running (pid ${pid}, cli ${CLI_VERSION}`);

    const stopped = await json(["host", "stop"]);
    expect(stopped.body.data).toEqual({ running: false, pid, how: "stopped" });
    expect(processAlive(pid)).toBe(false);
    expect(await readHostRecord(env)).toBeNull();
  });

  it("starts one that stops by itself when idle", async () => {
    const started = await json(["host", "start", "--idle-timeout", "0.02"]);
    expect(started.body.data.idle).toEqual({ timeoutMs: 1_200, heldBy: [] });
    const pid = started.body.data.pid as number;
    const deadline = Date.now() + 20_000;
    while (processAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(processAlive(pid)).toBe(false);
    expect(await readHostRecord(env)).toBeNull();
  });

  it("runs in the foreground with the host plugins of the CLI's plugins", async () => {
    let activated = 0;
    const hostPlugin: HostPlugin = {
      name: "worker",
      contract: HOST_PLUGIN_CONTRACT,
      sharedPackages: [CORE_PACKAGE],
      activate: (context) => {
        activated += 1;
        context.keepAlive("busy");
      },
    };
    const cliPlugin: CommandPlugin = {
      name: "worker",
      contract: CLI_PLUGIN_CONTRACT,
      sharedPackages: [],
      hostPlugins: async () => [hostPlugin],
    };
    const running = run(["host", "run", "--idle-timeout", "0.01"], [cliPlugin]);
    const deadline = Date.now() + 10_000;
    while (!(await readHostRecord(env)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const status = await json(["host", "status"]);
    expect(status.body.data).toMatchObject({
      running: true,
      pid: process.pid,
      plugins: [{ name: "worker", state: "active" }],
      idle: { timeoutMs: 600, heldBy: ["worker: busy"] },
    });
    expect(activated).toBe(1);
    // Held by its plugin, it outlasts the idle timeout until it is stopped.
    await new Promise((r) => setTimeout(r, 900));
    expect(await readHostRecord(env)).not.toBeNull();
    const stopped = await run(["host", "stop"]);
    expect(stopped.stdout).toContain(`The Pathrule host (pid ${process.pid}) stopped.`);
    const result = await running;
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("[pathrule-host] plugin worker active");
  });

  it("never signals a host that runs inside another program, and signals a standalone one", async () => {
    const writeRecord = (pid: number, standalone: boolean) => {
      mkdirSync(dirname(hostRecordFile(env)), { recursive: true });
      writeFileSync(
        hostRecordFile(env),
        JSON.stringify({
          schema_version: 1,
          rpc: 1,
          pid,
          port: 1,
          token: "t",
          version: standalone ? "cli test" : "studio test",
          instance_id: `i-${pid}`,
          started_at: new Date().toISOString(),
          ...(standalone ? { standalone: true } : {}),
        }),
      );
    };
    // A host inside this very process that does not answer: stopping it must not stop the process.
    writeRecord(process.pid, false);
    const embedded = await json(["host", "stop"]);
    expect(embedded.exitCode).toBe(1);
    expect(embedded.body.error.code).toBe("host_did_not_stop");
    expect(embedded.body.error.message).toContain("runs inside another program");

    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    writeRecord(child.pid!, true);
    const standalone = await json(["host", "stop"]);
    expect(standalone.body.data).toEqual({ running: false, pid: child.pid, how: "terminated" });
    await exited;
  });

  it("refuses what it cannot do", async () => {
    expect((await run(["host"])).exitCode).toBe(64);
    expect((await run(["host", "nope"])).stderr).toContain("Usage: pathrule host");
    const badIdle = await json(["host", "start", "--idle-timeout", "soon"]);
    expect(badIdle.exitCode).toBe(64);
    expect(badIdle.body.error.code).toBe("invalid_idle_timeout");
    const foreground = await json(["host", "run"]);
    expect(foreground.exitCode).toBe(64);
    expect(foreground.body.error.code).toBe("json_not_supported");
  });
});

describe("parseIdleTimeout", () => {
  it("reads minutes in both forms, and nothing when absent", () => {
    expect(parseIdleTimeout(["run"])).toBeUndefined();
    expect(parseIdleTimeout(["start", "--idle-timeout", "10"])).toBe(600_000);
    expect(parseIdleTimeout(["start", "--idle-timeout=0.5"])).toBe(30_000);
    expect(() => parseIdleTimeout(["start", "--idle-timeout"])).toThrow("minutes above 0");
    expect(() => parseIdleTimeout(["start", "--idle-timeout", "0"])).toThrow("minutes above 0");
  });
});
