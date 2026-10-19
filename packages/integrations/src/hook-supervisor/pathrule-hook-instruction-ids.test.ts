// SPDX-License-Identifier: Apache-2.0
// A memory Claude already holds as a path-scoped rule (.claude/rules/pathrule/) is not sent again by
// the prompt channel, but only while the folder's manifest holds the version the index has: a memory
// written or changed after the last render (measured on PathruleBench v2, 2026-10-15: decisions an agent
// saved reached neither the files nor the hook) is an ordinary candidate.
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WS = "88888888-8888-8888-8888-888888888888";
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true }))); });

async function promptWith(manifest: Record<string, string> | null, root?: string[]): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "pathrule-hook-instr-"));
  homes.push(home);
  const hook = join(home, "bin", "pathrule-hook.js");
  await mkdir(dirname(hook), { recursive: true });
  await copyFile(HOOK, hook);
  const wsRoot = join(home, "project");
  await mkdir(join(wsRoot, "src", "billing"), { recursive: true });
  if (manifest) {
    await mkdir(join(wsRoot, ".claude", "rules", "pathrule"), { recursive: true });
    await writeFile(join(wsRoot, ".claude", "rules", "pathrule", "manifest.json"), JSON.stringify({ memories: manifest, ...(root ? { root } : {}) }));
  }
  const cache = join(home, "cache", WS);
  await mkdir(cache, { recursive: true });
  const stub = (id: string, title: string) => ({ id, title, preview: title, node_path: "/src/billing", content_hash: `h-${id}` });
  await writeFile(join(cache, "hook-index.json"), JSON.stringify({
    workspace_id: WS, workspace_root: wsRoot, generated_at: "2026-10-15T00:00:00.000Z", session_digest: "",
    path_memories: { "/src/billing": [stub("m-rule", "Invoice totals rounding rule"), stub("m-doc", "Invoice totals rounding notes")] },
    path_rules: {}, project_rules: [], recent_subjects: [], hot_paths: [{ path: "/src/billing", count: 3 }],
    instruction_memory_hashes: { "m-rule": "b-1" },
    project_advisories: [{ ref: "a-rule", group: "m-rule", line: "- Fact: ADVISORY_OF_RULE. [context]" }, { ref: "a-doc", group: "m-doc", line: "- Fact: ADVISORY_OF_DOC. [context]" }],
  }));
  await writeFile(join(cache, "warehouse.json"), JSON.stringify({
    "m-rule": { type: "memory", title: "Invoice totals rounding rule", body: "RULE_BODY invoice totals rounding banker", content_hash: "h-m-rule" },
    "m-doc": { type: "memory", title: "Invoice totals rounding notes", body: "DOC_BODY invoice totals rounding history", content_hash: "h-m-doc" },
  }));
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [hook], { env: { ...process.env, PATHRULE_HOME: home, PATHRULE_HOOK_EVENT: "UserPromptSubmit", PATHRULE_NAVIGATION: "on" }, timeout: 10_000 }, (error, stdout) => {
      if (error && typeof error.code === "number" && error.code !== 0) return reject(new Error(stdout));
      try { resolve(JSON.parse(stdout.trim())?.hookSpecificOutput?.additionalContext ?? ""); } catch { resolve(stdout); }
    });
    child.stdin!.end(JSON.stringify({ cwd: wsRoot, session_id: "s1", hook_event_name: "UserPromptSubmit", prompt: "Fix the invoice totals rounding in billing." }));
  });
}

describe("memories Claude holds as path-scoped rules", () => {
  it("are not sent again while the manifest holds their version", async () => {
    const out = await promptWith({ "m-rule": "b-1" });
    expect(out).not.toContain("RULE_BODY");
    expect(out).toContain("DOC_BODY");
  });

  it("are ordinary candidates when the folder is absent", async () => {
    const out = await promptWith(null);
    expect(out).toContain("RULE_BODY");
    expect(out).toContain("DOC_BODY");
  });

  it("have their atom lines sent as advisories only while the folder does not hold them", async () => {
    const held = await promptWith({ "m-rule": "b-1" });
    expect(held).not.toContain("ADVISORY_OF_RULE");
    expect(held).toContain("ADVISORY_OF_DOC");
    expect(await promptWith(null)).toContain("ADVISORY_OF_RULE");
  });

  it("are sent when the files predate them", async () => {
    expect(await promptWith({})).toContain("RULE_BODY");
  });

  it("are sent when the files hold an older version", async () => {
    expect(await promptWith({ "m-rule": "b-0" })).toContain("RULE_BODY");
  });

  it("are sent when only an area file holds them, which loads only on a read under that path", async () => {
    const home = await mkdtemp(join(tmpdir(), "pathrule-hook-instr-"));
    homes.push(home);
    // The same setup, with a manifest whose root list leaves m-rule to its area file.
    const out = await promptWith({ "m-rule": "b-1" }, []);
    expect(out).toContain("RULE_BODY");
  });
});
