// SPDX-License-Identifier: Apache-2.0
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { scanFailPatterns, startFailPatternDetector } from "./fail-patterns.js";

let cache = "";

const line = (minutesAgo: number, signature = "aaa") =>
  JSON.stringify({
    ts: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    tool: "Bash",
    file_path: "src/a.ts",
    error_signature: signature,
    error_preview: "boom",
  });

async function events(ws: string, lines: string[]): Promise<void> {
  await mkdir(join(cache, ws), { recursive: true });
  await writeFile(join(cache, ws, "fail-patterns.jsonl"), lines.join("\n") + "\n");
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  cache = await mkdtemp(join(tmpdir(), "pr-host-failures-"));
});

afterEach(async () => {
  await rm(cache, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("the failure-pattern scan", () => {
  it("removes a stale detected file where the hook records failures", async () => {
    await events("ws-1", [line(1), line(2), "{not json", line(3)]);
    await writeFile(join(cache, "ws-1", "fail-patterns.json"), "{}");
    await scanFailPatterns(cache);
    expect(await exists(join(cache, "ws-1", "fail-patterns.json"))).toBe(false);
    // The hook's own record is left as it is.
    expect(await readFile(join(cache, "ws-1", "fail-patterns.jsonl"), "utf8")).toContain("boom");
  });

  it("leaves a workspace without events alone, and skips stray files", async () => {
    await mkdir(join(cache, "ws-quiet"), { recursive: true });
    await writeFile(join(cache, "ws-quiet", "fail-patterns.json"), "{}");
    await writeFile(join(cache, ".DS_Store"), "x");
    await events("ws-1", [line(1)]);
    await scanFailPatterns(cache);
    expect(await readFile(join(cache, "ws-quiet", "fail-patterns.json"), "utf8")).toBe("{}");
  });

  it("does nothing when the cache directory does not exist", async () => {
    await expect(scanFailPatterns(join(cache, "missing"))).resolves.toBeUndefined();
  });

  it("scans at start, in the Pathrule home's cache unless told otherwise", async () => {
    const home = join(cache, "home");
    cache = join(home, "cache");
    await events("ws-1", [line(1)]);
    await writeFile(join(cache, "ws-1", "fail-patterns.json"), "{}");
    const stop = startFailPatternDetector({ env: { PATHRULE_HOME: home } });
    try {
      for (let i = 0; i < 50 && (await exists(join(cache, "ws-1", "fail-patterns.json"))); i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(await exists(join(cache, "ws-1", "fail-patterns.json"))).toBe(false);
    } finally {
      stop();
      cache = join(home, "..");
    }
  });
});
