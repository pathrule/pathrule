// SPDX-License-Identifier: Apache-2.0
// The update notice through the real router: who sees it, where it goes, and how often.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  cliComponent,
  release,
  serving,
  signedBody,
  testManifest,
  trustTestReleaseKey,
} from "@pathrule/core/release/__fixtures__/signed-manifest.js";
import { fetchReleaseManifest } from "@pathrule/core/release/release-feed.js";
import { CLI_PLUGIN_CONTRACT } from "@pathrule/protocol/plugin-contracts.js";

import { CLI_VERSION } from "../cli-version.js";
import { installCliPlugins, type CommandPlugin } from "../plugin.js";
import { runCli } from "../run.js";

class Writer {
  chunks: string[] = [];
  constructor(readonly isTTY: boolean) {}
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(String(chunk));
    return true;
  }
  toString() {
    return this.chunks.join("");
  }
}

const NEWER = "99.0.0";

let untrust: () => void;
beforeAll(() => {
  untrust = trustTestReleaseKey();
});
afterAll(() => untrust());

let home: string;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "pathrule-notice-"));
  // What a background check left on disk: a verified manifest with a newer CLI on npm.
  const body = signedBody(testManifest({ cli: cliComponent({ npm: { latest: release(NEWER) } }) }));
  await fetchReleaseManifest({
    env: { PATHRULE_HOME: home },
    fetchImpl: serving(body),
    userAgent: "test",
  });
});
afterEach(() => {
  installCliPlugins([]);
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const official: CommandPlugin = {
  name: "official",
  contract: CLI_PLUGIN_CONTRACT,
  sharedPackages: [],
  passiveUpdateNotice: true,
};

async function run(
  argv: string[],
  options: { terminal?: boolean; env?: NodeJS.ProcessEnv; plugins?: CommandPlugin[] } = {},
) {
  const terminal = options.terminal ?? true;
  const stdout = new Writer(terminal);
  const stderr = new Writer(terminal);
  const exitCode = await runCli(
    argv,
    {
      cwd: "/repo",
      env: { PATHRULE_HOME: home, HOME: home, ...options.env },
      stdout,
      stderr,
      stdinIsTTY: terminal,
      stderrIsTTY: terminal,
      fetch: (() => {
        throw new Error("a passive notice never fetches");
      }) as typeof fetch,
    },
    { plugins: options.plugins ?? [official] },
  );
  return { exitCode, stdout: stdout.toString(), stderr: stderr.toString() };
}

const NOTICE = `Pathrule ${NEWER} is available. You're using ${CLI_VERSION}.`;

describe("the update notice after a command", () => {
  it("reaches a person at a terminal, on stderr, once a day", async () => {
    const first = await run(["version"]);
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toContain(NOTICE);
    expect(first.stdout).toBe(`${CLI_VERSION}\n`);
    const second = await run(["version"]);
    expect(second.stderr).not.toContain(NOTICE);
  });

  it("never reaches a pipe, --json, CI or a dumb terminal, and never stdout", async () => {
    for (const result of [
      await run(["version"], { terminal: false }),
      await run(["version", "--json"]),
      await run(["version"], { env: { CI: "true" } }),
      await run(["version"], { env: { TERM: "dumb" } }),
    ]) {
      expect(result.stderr).not.toContain(NOTICE);
      expect(result.stdout).not.toContain(NOTICE);
    }
  });

  it("stays quiet with updates disabled", async () => {
    expect(
      (await run(["version"], { env: { PATHRULE_DISABLE_UPDATES: "1" } })).stderr,
    ).not.toContain(NOTICE);
  });

  it("reaches a released install under either policy, plugin or not (owner decision 2026-10-13)", async () => {
    expect((await run(["version"], { plugins: [] })).stderr).toContain(NOTICE);
    rmSync(join(home, "updates", "state.json"), { force: true });
    const body = signedBody(
      testManifest({ cli: cliComponent({ npm: { latest: release(NEWER) } }) }),
    );
    await fetchReleaseManifest({
      env: { PATHRULE_HOME: home },
      fetchImpl: serving(body),
      userAgent: "test",
    });
    // The earlier `manual` is today's `notify`: it says what is available.
    expect(
      (await run(["version"], { plugins: [], env: { PATHRULE_UPDATE_POLICY: "manual" } })).stderr,
    ).toContain(NOTICE);
  });
});
