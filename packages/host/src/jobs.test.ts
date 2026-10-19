// SPDX-License-Identifier: Apache-2.0
// The host's background jobs (open-core step 4h4): the local file work only Studio started before.
import { existsSync } from "node:fs";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { scratchHome, sleep, waitFor, type ScratchHome } from "./__fixtures__/helpers.js";
import { startHost } from "./host.js";
import { rotateHookFiles } from "./jobs.js";

const DAY = 24 * 60 * 60 * 1000;

let home: ScratchHome;
let pathruleHome: string;

beforeEach(() => {
  home = scratchHome();
  pathruleHome = home.env.PATHRULE_HOME!;
});

afterEach(() => home.remove());

/** A file under the Pathrule home, last written `ageMs` ago. */
async function file(relative: string, ageMs: number): Promise<string> {
  const path = join(pathruleHome, relative);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "x");
  const when = new Date(Date.now() - ageMs);
  await utimes(path, when, when);
  return path;
}

describe("hook file rotation", () => {
  it("removes week-old hook logs and day-old session ledgers in the home it is given", async () => {
    const oldLog = await file("logs/hooks-2026-09-01.log", 8 * DAY);
    const freshLog = await file("logs/hooks-2026-10-07.log", DAY);
    const otherLog = await file("logs/host.log", 30 * DAY);
    const oldLedger = await file("cache/ws-1/session-abc.json", DAY + 60_000);
    const freshLedger = await file("cache/ws-1/session-def.json", 60_000);
    const index = await file("cache/ws-1/hook-index.json", 30 * DAY);

    expect(await rotateHookFiles(home.env)).toEqual({ logs: 1, sessions: 1 });

    expect(existsSync(oldLog)).toBe(false);
    expect(existsSync(oldLedger)).toBe(false);
    for (const kept of [freshLog, otherLog, freshLedger, index])
      expect(existsSync(kept)).toBe(true);
  });

  it("finds nothing to do in a home without logs or a cache", async () => {
    expect(await rotateHookFiles(home.env)).toEqual({ logs: 0, sessions: 0 });
  });
});

describe("the host's background jobs", () => {
  it("run in a host that is its process's whole job", async () => {
    const oldLog = await file("logs/hooks-2026-09-01.log", 8 * DAY);
    // Without an engine the scan promotes nothing, so an old detected file goes: the scan ran.
    await file("cache/ws-1/fail-patterns.jsonl", 0);
    const detected = await file("cache/ws-1/fail-patterns.json", 0);

    const host = await startHost({ env: home.env, standalone: true, log: () => {} });
    try {
      await waitFor(() => (existsSync(oldLog) || existsSync(detected) ? undefined : true));
    } finally {
      await host.stop();
    }
  });

  it("do not run in a host embedded in another process (Studio's, or a command's)", async () => {
    const oldLog = await file("logs/hooks-2026-09-01.log", 8 * DAY);
    await file("cache/ws-1/fail-patterns.jsonl", 0);
    const detected = await file("cache/ws-1/fail-patterns.json", 0);

    const host = await startHost({ env: home.env, log: () => {} });
    try {
      await sleep(300);
      expect(existsSync(oldLog)).toBe(true);
      expect(existsSync(detected)).toBe(true);
    } finally {
      await host.stop();
    }
  });
});
