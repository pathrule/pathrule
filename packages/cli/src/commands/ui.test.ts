// SPDX-License-Identifier: Apache-2.0
// `pathrule ui`: its arguments, the link it prints and opens, its record in the Pathrule home, a
// second run that reuses the running console, a stale record, and a clean stop.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseCliArgs } from "../args.js";
import { CLI_VERSION } from "../cli-version.js";
import { readUiRecord, uiRecordFile } from "../local/ui/instance.js";
import type { CliCommandContext, CliRuntime } from "../plugin.js";
import { runCli } from "../run.js";
import { parseUiArgs, runUiCommand } from "./ui.js";

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
const running: Array<{ stop: AbortController; done: Promise<number> }> = [];

function runtime(
  opened: string[] = [],
): CliRuntime & { stdout: MemoryWriter; stderr: MemoryWriter } {
  return {
    cwd: root,
    env,
    stdout: new MemoryWriter(),
    stderr: new MemoryWriter(),
    openUrl: async (url) => {
      opened.push(url);
    },
  };
}

function context(argv: string[], rt: CliRuntime): CliCommandContext {
  const parsed = parseCliArgs(["ui", ...argv, "--no-color"], env);
  return {
    command: "ui",
    args: parsed.positional.slice(1),
    flags: parsed.flags,
    runtime: rt,
    mode: {
      json: parsed.flags.json,
      color: false,
      interactive: false,
      noOpen: parsed.flags.noOpen,
    },
  };
}

/** Starts a console in this process; resolves with its printed link once it serves. */
async function startConsole(argv: string[], rt = runtime()) {
  const stop = new AbortController();
  const done = runUiCommand(context(argv, rt), { signal: stop.signal });
  running.push({ stop, done });
  const deadline = Date.now() + 20_000;
  let match: RegExpExecArray | null = null;
  while (!(match = /(http:\/\/127\.0\.0\.1:(\d+)\/#launch=[\w-]+)/.exec(rt.stdout.toString()))) {
    if (Date.now() > deadline) throw new Error(`no link: ${rt.stdout}${rt.stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { url: match[1]!, port: Number(match[2]), stop, done, rt };
}

function exchange(url: string): Promise<number> {
  const link = new URL(url);
  const body = JSON.stringify({ launchToken: link.hash.slice("#launch=".length) });
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: Number(link.port),
        method: "POST",
        path: "/api/session",
        headers: {
          origin: link.origin,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pathrule-cli-ui-")));
  env = { PATH: process.env.PATH, PATHRULE_HOME: join(root, ".pathrule"), CI: "true" };
});

afterEach(async () => {
  for (const { stop, done } of running.splice(0)) {
    stop.abort();
    await done;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("parseUiArgs", () => {
  it("takes a port number and nothing else", () => {
    expect(parseUiArgs([])).toEqual({ port: 0 });
    expect(parseUiArgs(["--port", "4410"])).toEqual({ port: 4410 });
    expect(parseUiArgs(["--port=0"])).toEqual({ port: 0 });
    for (const args of [
      ["--port"],
      ["--port", "abc"],
      ["--port", "127.0.0.1:80"],
      ["--port", "-1"],
      ["--port", "65536"],
      ["--port", "1e3"],
      ["--host", "0.0.0.0"],
      ["extra"],
    ]) {
      expect(() => parseUiArgs(args), args.join(" ")).toThrow();
    }
  });
});

describe("pathrule ui", { timeout: 60_000 }, () => {
  it("refuses a bad port with the usage line", async () => {
    const rt = runtime();
    expect(await runCli(["ui", "--port", "host:80", "--no-color"], rt)).toBe(64);
    expect(rt.stderr.toString()).toContain("Usage: pathrule ui [--port <n>] [--no-open] [--json]");
    const json = runtime();
    expect(await runCli(["ui", "--port", "70000", "--json"], json)).toBe(64);
    expect(JSON.parse(json.stdout.toString())).toMatchObject({
      ok: false,
      command: "ui",
      error: { code: "invalid_ui_args" },
    });
  });

  it("serves, opens its link, records itself, and stops cleanly", async () => {
    const opened: string[] = [];
    const first = await startConsole([], runtime(opened));
    expect(opened).toEqual([first.url]);
    expect(first.rt.stdout.toString()).toContain("The link works once, within 2 minutes.");
    // The record: 0600, this process, its port, no token on screen.
    const record = await readUiRecord(env);
    expect(record).toMatchObject({ pid: process.pid, port: first.port, version: CLI_VERSION });
    expect(statSync(uiRecordFile(env)).mode & 0o777).toBe(0o600);
    expect(first.rt.stdout.toString()).not.toContain(record!.controlToken);
    expect(await exchange(first.url)).toBe(200);
    expect(await exchange(first.url)).toBe(401);

    first.stop.abort();
    expect(await first.done).toBe(0);
    expect(first.rt.stdout.toString()).toContain("The Local Console stopped.");
    expect(await readUiRecord(env)).toBeNull();
  });

  it("hands a second run a fresh link to the running console", async () => {
    const first = await startConsole(["--no-open", "--json"]);
    const envelope = JSON.parse(first.rt.stdout.toString());
    expect(envelope).toMatchObject({
      ok: true,
      command: "ui",
      data: { port: first.port, pid: process.pid, reused: false, assetsBuilt: expect.any(Boolean) },
    });

    const opened: string[] = [];
    const second = runtime(opened);
    expect(await runCli(["ui", "--json"], second)).toBe(0);
    const reused = JSON.parse(second.stdout.toString());
    expect(reused).toMatchObject({ ok: true, data: { port: first.port, reused: true } });
    expect(reused.data.url).not.toBe(first.url);
    expect(opened).toEqual([reused.data.url]);
    expect(await exchange(reused.data.url)).toBe(200);

    const text = runtime();
    expect(await runCli(["ui", "--no-open", "--no-color"], text)).toBe(0);
    expect(text.stdout.toString()).toContain(
      `The Local Console is already running (pid ${process.pid}): http://127.0.0.1:${first.port}/#launch=`,
    );
    // Still one console, still its record.
    expect((await readUiRecord(env))?.port).toBe(first.port);
  });

  it("replaces a record whose process is gone, or that does not answer", async () => {
    mkdirSync(env.PATHRULE_HOME!, { recursive: true });
    writeFileSync(
      uiRecordFile(env),
      JSON.stringify({ pid: 2_147_483_646, port: 1, controlToken: "dead", version: "0.0.0" }),
    );
    const fresh = await startConsole(["--no-open"]);
    expect(await readUiRecord(env)).toMatchObject({ pid: process.pid, port: fresh.port });
    fresh.stop.abort();
    await fresh.done;

    // A live pid whose console does not answer: this process, on a port nothing listens on.
    writeFileSync(
      uiRecordFile(env),
      JSON.stringify({
        pid: process.pid,
        port: fresh.port,
        controlToken: "silent",
        version: "0.0.0",
      }),
    );
    const rt = runtime();
    const replaced = await startConsole(["--no-open"], rt);
    expect(rt.stderr.toString()).toContain("did not answer");
    expect(await readUiRecord(env)).toMatchObject({ pid: process.pid, port: replaced.port });
    expect((await readUiRecord(env))?.controlToken).not.toBe("silent");
  });
});
