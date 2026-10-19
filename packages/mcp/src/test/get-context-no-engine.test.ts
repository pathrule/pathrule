// SPDX-License-Identifier: Apache-2.0
// get_context with no engine: the ranking decisions run their open defaults (no proactive signal, the
// fixed work-episode budget), and a repeat answer has the same shape. Offline, against a LocalBackend.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalBackend } from "@pathrule/core";
import { getContextTool } from "../tools/get-context.js";
import { setProjectLearningBudgetForTest } from "../tools/get-context-learning.js";
import { resetLocalBackends } from "../local-runtime.js";

const saved = { home: process.env.PATHRULE_HOME, local: process.env.PATHRULE_LOCAL, principal: process.env.PATHRULE_LOCAL_PRINCIPAL };
const prevCwd = process.cwd();
let home = "";
let root = "";

beforeEach(async () => {
  setProjectLearningBudgetForTest(30_000);
  home = mkdtempSync(join(tmpdir(), "pathrule-gc-engine-home-"));
  root = mkdtempSync(join(tmpdir(), "pathrule-gc-engine-root-"));
  process.env.PATHRULE_HOME = home;
  process.env.PATHRULE_LOCAL = "1";
  process.env.PATHRULE_LOCAL_PRINCIPAL = "tester";
  process.chdir(root);
  const canonicalRoot = process.cwd();
  writeFileSync(join(canonicalRoot, "package.json"), '{"name":"engine-fallback-fixture"}');
  const wid = "ws-gc-engine";
  const seed = LocalBackend.openForWorkspace(wid, process.env);
  seed.registerWorkspace({ workspaceId: wid, name: "demo", localRootPath: canonicalRoot });
  const node = await seed.ensureNodeForPath(wid, "/");
  await seed.writeMemory({ workspaceId: wid, nodeId: node.id, title: "Deploy ritual", content: "Run the release gate before pushing.", source: "claude" });
  seed.close();
  await resetLocalBackends();
});

afterEach(async () => {
  setProjectLearningBudgetForTest(null);
  await resetLocalBackends();
  process.chdir(prevCwd);
  for (const [key, value] of [["PATHRULE_HOME", saved.home], ["PATHRULE_LOCAL", saved.local], ["PATHRULE_LOCAL_PRINCIPAL", saved.principal]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const ask = async () => (await getContextTool.handler({ user_intent: "how do I deploy" } as never)) as Record<string, unknown>;

describe("get_context with no engine", () => {
  it("answers from the store with no proactive signal, and a repeat has the same shape", async () => {
    const plain = await ask();
    expect(plain.ok).not.toBe(false);
    expect(JSON.stringify(plain)).toContain("Deploy ritual");
    expect(plain.proactive_signal).toBeUndefined();
    expect(plain).not.toHaveProperty("proactive_signals");
    expect(plain).not.toHaveProperty("knowledge_gaps");
    // A repeat call in the same process omits what the caller already holds; compare like with like.
    const warm = await ask();
    const again = await ask();
    expect(again.ok).not.toBe(false);
    expect(Object.keys(again).sort()).toEqual(Object.keys(warm).sort());
  });
});
