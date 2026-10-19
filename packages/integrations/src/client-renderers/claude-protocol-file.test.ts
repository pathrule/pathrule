// SPDX-License-Identifier: Apache-2.0
// The file we stop writing has to be removed, not abandoned. Nothing sweeps
// `.claude/rules/pathrule-protocol.md`, so a leftover copy keeps reaching turn
// zero and drifts from the protocol the hook injects.
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CLAUDE_PROTOCOL_FILE,
  syncClaudeProtocolFile,
} from "./claude-protocol-file.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), "pathrule-protofile-"));
  roots.push(r);
  return r;
}

const exists = async (p: string) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

describe("syncClaudeProtocolFile", () => {
  it("writes the protocol when the file is the channel", async () => {
    const r = await root();
    expect(await syncClaudeProtocolFile(r, { signed: false })).toBe("written");
    const body = await readFile(join(r, CLAUDE_PROTOCOL_FILE), "utf8");
    expect(body).toContain("pathrule_get_context");
  });

  it("creates the directory it needs", async () => {
    const r = await root();
    await syncClaudeProtocolFile(r, { signed: false });
    expect(await exists(join(r, ".claude", "rules"))).toBe(true);
  });

  it("removes a stale copy when the hook took the channel over", async () => {
    const r = await root();
    await syncClaudeProtocolFile(r, { signed: false });
    expect(await syncClaudeProtocolFile(r, { signed: true })).toBe("removed");
    expect(await exists(join(r, CLAUDE_PROTOCOL_FILE))).toBe(false);
  });

  it("is idempotent in both directions", async () => {
    const r = await root();
    expect(await syncClaudeProtocolFile(r, { signed: true })).toBe("absent");
    expect(await syncClaudeProtocolFile(r, { signed: true })).toBe("absent");
    expect(await syncClaudeProtocolFile(r, { signed: false })).toBe("written");
    // Second pass reports "unchanged", not "written": the file was already
    // correct, so nothing was touched. It used to rewrite unconditionally, which
    // made every sync move the mtime of a turn-zero file.
    expect(await syncClaudeProtocolFile(r, { signed: false })).toBe("unchanged");
  });

  it("touches nothing else in .claude/rules", async () => {
    const r = await root();
    await mkdir(join(r, ".claude", "rules"), { recursive: true });
    await writeFile(join(r, ".claude", "rules", "team-conventions.md"), "# ours\n");
    await syncClaudeProtocolFile(r, { signed: false });
    await syncClaudeProtocolFile(r, { signed: true });
    expect(await readFile(join(r, ".claude", "rules", "team-conventions.md"), "utf8")).toBe("# ours\n");
  });

  it("does not rewrite an identical file — a turn-zero file must not churn", async () => {
    const r = await root();
    expect(await syncClaudeProtocolFile(r, { signed: false })).toBe("written");
    const target = join(r, CLAUDE_PROTOCOL_FILE);
    const before = (await stat(target)).mtimeMs;
    await new Promise((res) => setTimeout(res, 20));

    expect(await syncClaudeProtocolFile(r, { signed: false })).toBe("unchanged");
    expect((await stat(target)).mtimeMs, "mtime moved on an unchanged file").toBe(before);
  });

  it("rewrites when the content actually changed", async () => {
    const r = await root();
    await syncClaudeProtocolFile(r, { signed: false });
    const target = join(r, CLAUDE_PROTOCOL_FILE);
    await writeFile(target, "# stale\n", "utf8");
    expect(await syncClaudeProtocolFile(r, { signed: false })).toBe("written");
    expect(await readFile(target, "utf8")).toContain("Pathrule");
  });
});
