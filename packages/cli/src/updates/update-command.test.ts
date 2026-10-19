// SPDX-License-Identifier: Apache-2.0
// `pathrule update` through the real router, as a person reads it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  cliComponent,
  offline,
  release,
  serving,
  signedBody,
  testManifest,
  trustTestReleaseKey,
} from "@pathrule/core/release/__fixtures__/signed-manifest.js";

import { CLI_VERSION } from "../cli-version.js";
import { runCli } from "../run.js";

class Writer {
  chunks: string[] = [];
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(String(chunk));
    return true;
  }
  toString() {
    return this.chunks.join("");
  }
}

let untrust: () => void;
beforeAll(() => {
  untrust = trustTestReleaseKey();
});
afterAll(() => untrust());

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pathrule-update-cmd-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

async function update(fetchImpl: typeof fetch, argv: string[] = ["update", "--no-color"]) {
  const stdout = new Writer();
  const stderr = new Writer();
  const exitCode = await runCli(argv, {
    cwd: "/repo",
    env: { PATHRULE_HOME: home, HOME: home },
    stdout,
    stderr,
    fetch: fetchImpl,
  });
  return { exitCode, stdout: stdout.toString(), stderr: stderr.toString() };
}

const offering = (version: string) =>
  signedBody(
    testManifest({
      cli: cliComponent({
        npm: {
          latest: release(version, { release_notes_url: "https://pathrule.io/changelog#v" }),
        },
      }),
    }),
  );

describe("pathrule update", () => {
  it("says it is up to date", async () => {
    const result = await update(serving(offering(CLI_VERSION)));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`[ok] Pathrule ${CLI_VERSION} is up to date.`);
  });

  it("names the release, its notes and how to install it, never guessing for an unplaced install", async () => {
    const result = await update(serving(offering("99.0.0")));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Pathrule 99.0.0 is available. You're using ${CLI_VERSION}.`);
    expect(result.stdout).toContain("Release notes: https://pathrule.io/changelog#v");
    // The test runner is no package manager's install: the command is shown, not run.
    expect(result.stdout).toContain("(with npm: npm install -g @pathrule/cli@99.0.0)");
    expect(result.stdout).not.toContain("Updating with");
  });

  it("fails visibly offline when asked, without a stack trace", async () => {
    const result = await update(offline);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      "Could not check for updates: the release service did not answer; try again when you are online.",
    );
  });

  it("ignores release information that does not verify, and says so", async () => {
    const tampered = JSON.parse(offering("99.0.0"));
    tampered.signed.components.cli.channels.npm.latest.version = "100.0.0";
    const result = await update(serving(JSON.stringify(tampered)));
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("the release information did not verify, so it was ignored");
    expect(result.stdout).not.toContain("100.0.0");
  });

  it("checks only with --check, and keeps --json machine-readable", async () => {
    const check = await update(serving(offering("99.0.0")), ["update", "--check", "--no-color"]);
    expect(check.stdout).toContain("Pathrule 99.0.0 is available.");
    const json = await update(serving(offering("99.0.0")), ["update", "--json"]);
    const envelope = JSON.parse(json.stdout);
    expect(envelope).toMatchObject({
      ok: true,
      command: "update",
      data: { latest_version: "99.0.0", update_available: true, runnable: false },
    });
    expect(json.stderr).toBe("");
  });
});
