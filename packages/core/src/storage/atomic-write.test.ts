// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { atomicWrite, readIfExists, serializeByPath } from "./atomic-write.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pathrule-atomic-write-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("atomicWrite", () => {
  it("never publishes a torn file when two writers race with bodies of different length", async () => {
    // The exact shape that broke ~/.claude.json: two bodies two bytes apart. With a
    // shared `${target}.tmp` the shorter one landed on the longer one's tail and
    // the file read as valid JSON followed by a stray "}\n".
    const target = join(dir, ".claude.json");
    const long = `${JSON.stringify({ mcpServers: { figma: { url: "https://mcp.figma.com/mcp" } } }, null, 2)}\n`;
    const short = `${JSON.stringify({ mcpServers: { vercel: { url: "https://mcp.vercel.com" } } }, null, 2)}\n`;
    expect(Buffer.byteLength(long) - Buffer.byteLength(short)).toBe(2);
    for (let round = 0; round < 200; round++) {
      await Promise.all([atomicWrite(target, long), atomicWrite(target, short)]);
      expect([long, short]).toContain(await readFile(target, "utf8"));
    }
    expect(await readdir(dir)).toEqual([".claude.json"]);
  });

  it("applies the requested mode before the file becomes visible", async () => {
    const target = join(dir, "secret.json");
    await atomicWrite(target, "{}\n", { mode: 0o600 });
    if (process.platform !== "win32") expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it("removes its temp file when the rename fails", async () => {
    // A non-empty directory where the file should be makes the rename fail after
    // the temp file was written.
    const target = join(dir, "occupied");
    await mkdir(join(target, "child"), { recursive: true });
    await expect(atomicWrite(target, "x")).rejects.toThrow();
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("serializeByPath", () => {
  it("keeps every read-modify-write when many run at once", async () => {
    const target = join(dir, "bag.json");
    await writeFile(target, "{}\n");
    const names = Array.from({ length: 25 }, (_, i) => `server-${i}`);
    await Promise.all(
      names.map((name) =>
        serializeByPath(target, async () => {
          const bag = JSON.parse((await readIfExists(target)) ?? "{}") as Record<string, true>;
          bag[name] = true;
          await atomicWrite(target, `${JSON.stringify(bag)}\n`);
        }),
      ),
    );
    expect(Object.keys(JSON.parse(await readFile(target, "utf8"))).sort()).toEqual([...names].sort());
  });

  it("treats two spellings of one path as the same file", async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = serializeByPath(join(dir, "a.json"), async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push("first");
    });
    const second = serializeByPath(join(dir, ".", "sub", "..", "a.json"), async () => {
      order.push("second");
    });
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });

  it("runs the next update after one that failed, and reports both outcomes", async () => {
    const target = join(dir, "c.json");
    const failed = serializeByPath(target, async () => {
      throw new Error("boom");
    });
    const after = serializeByPath(target, async () => "ran");
    await expect(failed).rejects.toThrow("boom");
    await expect(after).resolves.toBe("ran");
  });
});
