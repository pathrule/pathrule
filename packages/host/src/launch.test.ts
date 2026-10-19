// SPDX-License-Identifier: Apache-2.0
// Launching the host as a process of its own: started detached and reached, reused when it already
// runs, one host when two surfaces launch at once, a failed launch explained by the host's log,
// and a launched host that outlives its launcher and stops by itself when idle.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { scratchHome, waitFor, type ScratchHome } from "./__fixtures__/helpers.js";
import { connectHost } from "./client.js";
import { processAlive, readHostRecord } from "./discovery.js";
import { HostLaunchError, hostLogFile, launchHost, type HostLaunchCommand } from "./launch.js";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/run-host.ts", import.meta.url));
/** The package directory: `--import tsx` resolves from the working directory. */
const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
/** tsx's loader by URL: a launched host does not run in the package directory. */
const TSX_LOADER = pathToFileURL(
  join(dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist/loader.mjs"),
).href;

let home: ScratchHome;
const pids = new Set<number>();

// Every fixture host stops after 30 s without a request. A host this suite does not kill (the one
// that lost a concurrent launch, still starting while teardown removed its home) used to serve
// forever: one leaked process per run, eight found on 2026-10-08.
function fixture(env: NodeJS.ProcessEnv = {}): HostLaunchCommand {
  return {
    command: process.execPath,
    args: ["--import", TSX_LOADER, FIXTURE],
    env: { HOST_FIXTURE_IDLE_MS: "30000", ...env },
  };
}

async function launched(options: Parameters<typeof launchHost>[0]) {
  const result = await launchHost(options);
  pids.add(result.client.record.pid);
  return result;
}

beforeEach(() => {
  home = scratchHome();
});

afterEach(async () => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  pids.clear();
  home.remove();
});

describe("launching the host", { timeout: 60_000 }, () => {
  it("starts a detached host and reaches it", async () => {
    const { client, launched: started } = await launched({ env: home.env, launch: fixture() });
    expect(started).toBe(true);
    const hello = await client.call("host.hello", {});
    expect(hello.pid).not.toBe(process.pid);
    expect(readFileSync(hostLogFile(home.env), "utf8")).toContain("ready on 127.0.0.1");
  });

  it("reuses the running host instead of starting another", async () => {
    const first = await launched({ env: home.env, launch: fixture() });
    const second = await launched({ env: home.env, launch: fixture() });
    expect(second.launched).toBe(false);
    expect(second.client.record.instance_id).toBe(first.client.record.instance_id);
  });

  it("leaves one host when two surfaces launch at once", async () => {
    const [a, b] = await Promise.all([
      launched({ env: home.env, launch: fixture() }),
      launched({ env: home.env, launch: fixture() }),
    ]);
    expect(a.client.record.instance_id).toBe(b.client.record.instance_id);
    // The process that lost the claim has exited.
    await waitFor(async () => {
      const record = await readHostRecord(home.env);
      return record?.instance_id === a.client.record.instance_id ? true : undefined;
    });
  });

  it("explains a host that fails to start with its log", async () => {
    const failure = await launchHost({
      env: home.env,
      launch: fixture({ HOST_FIXTURE_FAIL: "no store" }),
    }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(HostLaunchError);
    expect((failure as HostLaunchError).message).toContain("exited with code 1");
    expect((failure as HostLaunchError).logTail).toContain("fixture failure: no store");
  });

  it("gives up on a host that never answers", async () => {
    const failure = await launchHost({
      env: home.env,
      launch: { command: process.execPath, args: ["-e", "setTimeout(() => {}, 5000)"] },
      waitMs: 300,
    }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(HostLaunchError);
    expect((failure as HostLaunchError).message).toContain("did not answer within 300 ms");
  });

  it("outlives its launcher, then stops by itself when idle", async () => {
    // The launcher is a separate process that exits as soon as the host answers.
    const launcher = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        // Top-level await in an -e script needs module input before Node 22.
        "--input-type=module",
        "-e",
        `const { launchHost } = await import(${JSON.stringify(new URL("./launch.ts", import.meta.url).href)});
         const { client } = await launchHost({ launch: ${JSON.stringify(fixture({ HOST_FIXTURE_IDLE_MS: "1500" }))} });
         process.stdout.write(String(client.record.pid));`,
      ],
      { cwd: PACKAGE_DIR, env: { ...process.env, ...home.env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    launcher.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => launcher.once("exit", resolve));
    expect(code).toBe(0);
    const pid = Number(out);
    pids.add(pid);
    expect(processAlive(pid)).toBe(true);
    expect(await connectHost({ env: home.env })).not.toBeNull();
    // Idle for 1.5 s with nobody asking: it stops and leaves no record.
    await waitFor(() => (processAlive(pid) ? undefined : true), 15_000);
    expect(await readHostRecord(home.env)).toBeNull();
  });
});
