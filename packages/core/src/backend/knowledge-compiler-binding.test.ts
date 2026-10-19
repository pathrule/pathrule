// SPDX-License-Identifier: Apache-2.0
// Binding mode: what Claude's path-scoped rules carry. Rules in full, and every memory that has Agent IR
// atoms as those atom lines; a memory without atoms (documentation) stays out, whatever its length.
import { describe, expect, it } from "vitest";
import { captureGroundedAtom } from "@pathrule/agent-ir/atoms/grounded-capture.js";
import { LocalBackend } from "./local/local-backend.js";

async function setup() {
  let n = 0;
  const b = new LocalBackend(":memory:", { genId: () => `id-${++n}`, now: () => "2026-10-15T00:00:00.000Z" });
  b.registerWorkspace({ workspaceId: "ws", localRootPath: "/repo" });
  const node = await b.ensureNodeForPath("ws", "/fastapi", "folder");
  const rule = await b.writeMemory({ workspaceId: "ws", nodeId: node.id, title: "operationIds are snake_case", content: "Every operationId is snake_case. A prefix `Billing` becomes `billing_` in front of the id." });
  for (const fact of ["Every operationId is snake_case.", "A prefix `Billing` becomes `billing_` in front of the id."]) {
    const c = captureGroundedAtom({ kind: "context", fact: [fact] }, { kind: "memory", id: rule.id, title: rule.title, content: rule.content }, "2026-10-15T00:00:00.000Z");
    if (!c.ok) throw new Error(c.message);
    await b.recordGroundedAtom("ws", c.atom);
  }
  await b.writeMemory({ workspaceId: "ws", nodeId: node.id, title: "Tutorial: first steps", content: "Create a file main.py and run it with uvicorn." });
  return { b, ruleId: rule.id };
}

describe("binding knowledge (Claude path-scoped rules)", () => {
  it("carries a memory's atom lines, as instructions, and leaves memories without atoms out", async () => {
    const { b, ruleId } = await setup();
    const nodes = (await b.buildKnowledgePayload("ws", "binding"))!;
    // Typed memories start in the root file, named with their area, so they hold from the first turn.
    const root = nodes.find((n) => n.dir_path === "/")!;
    expect(root.memory_ids).toEqual([ruleId]);
    expect(root.markdown).toContain("### operationIds are snake_case (fastapi)");
    expect(root.markdown).toContain("`Billing` becomes `billing_`");
    expect(root.markdown).not.toContain("advisory");
    expect(root.markdown).not.toContain("Fact:");
    expect(root.markdown).not.toContain("uvicorn");
    expect(nodes.find((n) => n.dir_path === "/fastapi")).toBeUndefined();
    b.close();
  });

  it("keeps the most recently changed knowledge when the root budget is short", async () => {
    let n = 0;
    let clock = 0;
    const b = new LocalBackend(":memory:", { genId: () => `id-${String(++n).padStart(3, "0")}`, now: () => new Date(Date.UTC(2026, 9, 15, 0, 0, ++clock)).toISOString() });
    b.registerWorkspace({ workspaceId: "ws", localRootPath: "/repo" });
    const root = await b.ensureNodeForPath("ws", "/", "folder");
    const typed = async (title: string, content: string) => {
      const m = await b.writeMemory({ workspaceId: "ws", nodeId: root.id, title, content });
      const c = captureGroundedAtom({ kind: "context", fact: [content] }, { kind: "memory", id: m.id, title, content }, "2026-10-15T00:00:00.000Z");
      if (!c.ok) throw new Error(c.message);
      await b.recordGroundedAtom("ws", c.atom);
      return m;
    };
    for (let i = 0; i < 24; i += 1) await typed(`Reference ${i}`, `Reference note ${i}: ${"background ".repeat(30).trim()}.`);
    // Written last, with the id that sorts last: by id alone it is the one the budget drops.
    const lesson = await typed("Running the team suite", `Run the team suite as ACME_TEAM_SUITE=1 go test ./acmetest: ${"without it TestMain panics ".repeat(12).trim()}.`);
    const rootNode = (await b.buildKnowledgePayload("ws", "binding"))!.find((x) => x.dir_path === "/")!;
    expect(rootNode.truncated).toBe(true);
    expect(rootNode.memory_ids).toContain(lesson.id);
    b.close();
  });

  it("spills what the root cannot hold into the memory's own area file", async () => {
    let n = 0;
    const b = new LocalBackend(":memory:", { genId: () => `id-${String(++n).padStart(3, "0")}`, now: () => "2026-10-16T00:00:00.000Z" });
    b.registerWorkspace({ workspaceId: "ws", localRootPath: "/repo" });
    const api = await b.ensureNodeForPath("ws", "/api", "folder");
    for (let i = 0; i < 30; i += 1) {
      const content = `Rule ${i} for the api: ${"detail ".repeat(40).trim()}.`;
      const m = await b.writeMemory({ workspaceId: "ws", nodeId: api.id, title: `Api rule ${i}`, content });
      const c = captureGroundedAtom({ kind: "context", fact: [content] }, { kind: "memory", id: m.id, title: m.title, content }, "2026-10-16T00:00:00.000Z");
      if (!c.ok) throw new Error(c.message);
      await b.recordGroundedAtom("ws", c.atom);
    }
    const nodes = (await b.buildKnowledgePayload("ws", "binding"))!;
    const root = nodes.find((x) => x.dir_path === "/")!, area = nodes.find((x) => x.dir_path === "/api")!;
    expect(root.memory_ids.length).toBeGreaterThan(0);
    expect(area.memory_ids.length).toBeGreaterThan(0);
    expect(root.memory_ids.length + area.memory_ids.length).toBe(30);
    expect(root.truncated).toBe(false);
    expect(area.markdown).toContain("### Api rule");
    expect(area.markdown).not.toContain("(api)");
    b.close();
  });

  it("marks the sentences that describe the code's layout, and leaves decisions as they are", async () => {
    let n = 0;
    const b = new LocalBackend(":memory:", { genId: () => `id-${++n}`, now: () => "2026-10-16T00:00:00.000Z" });
    b.registerWorkspace({ workspaceId: "ws", localRootPath: "/repo" });
    const root = await b.ensureNodeForPath("ws", "/", "folder");
    const typed = async (title: string, content: string) => {
      const m = await b.writeMemory({ workspaceId: "ws", nodeId: root.id, title, content });
      const c = captureGroundedAtom({ kind: "context", fact: [content] }, { kind: "memory", id: m.id, title, content }, "2026-10-16T00:00:00.000Z");
      if (!c.ok) throw new Error(c.message);
      await b.recordGroundedAtom("ws", c.atom);
    };
    await typed("Platform limits are generated", "Platform limits live in `config/limits.json`. To add or change one, edit that file and run `python3 scripts/gen_limits.py`, which writes `acme/_limits_gen.py`. Never edit the generated module by hand; read values with `acme.limits.limit(name)`.");
    await typed("Scripts", "`scripts/` holds maintenance scripts run by hand: `gen_limits.py` regenerates the limits module.");
    await typed("Error type domain", "Error types created from now on use `https://errors.acme.io/` instead of `https://errors.acme.dev/`; existing ones keep their URLs for now.");
    await typed("Response headers", "Every response header that the toolkit itself adds must be listed in the tuple `ADDED_HEADERS` in `acme/headers.py`.");
    const md = (await b.buildKnowledgePayload("ws", "binding"))!.find((x) => x.dir_path === "/")!.markdown;
    expect(md).toContain("- Platform limits live in `config/limits.json` (as of writing). To add or change one, edit that file and run `python3 scripts/gen_limits.py`, which writes `acme/_limits_gen.py` (as of writing). Never edit the generated module by hand; read values with `acme.limits.limit(name)`.");
    expect(md).toContain("- `scripts/` holds maintenance scripts run by hand: `gen_limits.py` regenerates the limits module (as of writing).");
    expect(md).toContain("- Error types created from now on use `https://errors.acme.io/` instead of `https://errors.acme.dev/`; existing ones keep their URLs for now.\n");
    expect(md).toContain("- Every response header that the toolkit itself adds must be listed in the tuple `ADDED_HEADERS` in `acme/headers.py`.\n");
    expect(md).toContain('"As of writing" marks where something lived');
    b.close();
  });

  it("leaves the full and slim projections as they were", async () => {
    const { b } = await setup();
    const full = (await b.buildKnowledgePayload("ws"))!.find((n) => n.dir_path === "/fastapi")!;
    expect(full.markdown).toContain("uvicorn");
    b.close();
  });
});
