// SPDX-License-Identifier: Apache-2.0
// The host as a real operating-system process: started, reached, stopped by a signal, killed
// without a chance to stop, and replaced.
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { scratchHome, waitFor, type ScratchHome } from "./__fixtures__/helpers.js";
import { connectHost } from "./client.js";
import { hostRecordFile, processAlive, readHostRecord } from "./discovery.js";
import { HOST_EXIT, runHostProcess } from "./process.js";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/run-host.ts", import.meta.url));
/** The package directory: `--import tsx` resolves from the working directory. */
const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

let home: ScratchHome;
const children: ChildProcess[] = [];

interface HostChild {
  child: ChildProcess;
  exited: Promise<number | null>;
  stderr: () => string;
}

function launch(): HostChild {
  const child = spawn(process.execPath, ["--import", "tsx", FIXTURE], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, ...home.env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.push(child);
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  return { child, exited, stderr: () => stderr };
}

async function recordOf(pid: number | undefined) {
  return waitFor(async () => {
    const record = await readHostRecord(home.env);
    return record && record.pid === pid ? record : undefined;
  }, 20_000);
}

beforeEach(() => {
  home = scratchHome();
});

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  home.remove();
});

describe("the host process", { timeout: 60_000 }, () => {
  it("starts, answers, and stops cleanly on SIGTERM", async () => {
    const host = launch();
    await recordOf(host.child.pid);
    const client = await connectHost({ env: home.env });
    const hello = await client!.call("host.hello", {});
    expect(hello.pid).toBe(host.child.pid);

    host.child.kill("SIGTERM");
    expect(await host.exited).toBe(HOST_EXIT.stopped);
    expect(existsSync(hostRecordFile(home.env))).toBe(false);
    expect(host.stderr()).toContain("stopped");
  });

  it("is replaced after it is killed without a chance to stop", async () => {
    const first = launch();
    const left = await recordOf(first.child.pid);
    first.child.kill("SIGKILL");
    await first.exited;
    // The record survives the crash, and points at a process that is gone.
    expect((await readHostRecord(home.env))?.instance_id).toBe(left.instance_id);
    expect(processAlive(left.pid)).toBe(false);
    await expect(connectHost({ env: home.env })).resolves.toBeNull();

    const second = launch();
    const taken = await recordOf(second.child.pid);
    expect(taken.instance_id).not.toBe(left.instance_id);
    const hello = await (await connectHost({ env: home.env }))!.call("host.hello", {});
    expect(hello.pid).toBe(second.child.pid);
    second.child.kill("SIGTERM");
    expect(await second.exited).toBe(HOST_EXIT.stopped);
  });

  it("lets one of two processes that start at once run, and the other exit", async () => {
    const a = launch();
    const b = launch();
    const firstExit = await Promise.race([a.exited.then(() => a), b.exited.then(() => b)]);
    expect(firstExit.child.exitCode).toBe(HOST_EXIT.alreadyRunning);
    expect(firstExit.stderr()).toContain("already running");
    const winner = firstExit === a ? b : a;
    expect((await readHostRecord(home.env))?.pid).toBe(winner.child.pid);
    winner.child.kill("SIGINT");
    expect(await winner.exited).toBe(HOST_EXIT.stopped);
  });
});

describe("runHostProcess", () => {
  it("stops on the signal it is given and returns the exit code", async () => {
    const signals = new EventEmitter() as unknown as Pick<NodeJS.Process, "once" | "off">;
    const lines: string[] = [];
    const run = runHostProcess({ env: home.env, signals, log: (line) => lines.push(line) });
    await waitFor(() => readHostRecord(home.env).then((r) => r ?? undefined));
    (signals as unknown as EventEmitter).emit("SIGTERM", "SIGTERM");
    await expect(run).resolves.toBe(HOST_EXIT.stopped);
    expect(lines).toContain("stopping (SIGTERM)");
    expect((signals as unknown as EventEmitter).listenerCount("SIGTERM")).toBe(0);
  });

  it("stops when its stop signal aborts, and says it is the process's whole job", async () => {
    const signals = new EventEmitter() as unknown as Pick<NodeJS.Process, "once" | "off">;
    const controller = new AbortController();
    const lines: string[] = [];
    const run = runHostProcess({
      env: home.env,
      signals,
      stopSignal: controller.signal,
      log: (line) => lines.push(line),
    });
    const record = await waitFor(() => readHostRecord(home.env).then((r) => r ?? undefined));
    expect(record.standalone).toBe(true);
    controller.abort();
    await expect(run).resolves.toBe(HOST_EXIT.stopped);
    expect(lines).toContain("stopping (stop signal)");
    expect((signals as unknown as EventEmitter).listenerCount("SIGTERM")).toBe(0);
  });

  it("returns alreadyRunning when another host holds the home", async () => {
    const signals = new EventEmitter() as unknown as Pick<NodeJS.Process, "once" | "off">;
    const first = runHostProcess({ env: home.env, signals, log: () => {} });
    await waitFor(() => readHostRecord(home.env).then((r) => r ?? undefined));
    await expect(runHostProcess({ env: home.env, log: () => {} })).resolves.toBe(
      HOST_EXIT.alreadyRunning,
    );
    (signals as unknown as EventEmitter).emit("SIGINT", "SIGINT");
    await expect(first).resolves.toBe(HOST_EXIT.stopped);
  });
});
