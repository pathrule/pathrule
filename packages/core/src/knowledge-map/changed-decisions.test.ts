// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { LocalBackend } from "../backend/local/local-backend.js";
import { CHANGED_DECISION_LINE_MAX, changedDecisionStubs, selectChangedDecision, writtenText } from "./changed-decisions.js";

const DOMAIN = {
  id: "m1",
  title: "New error types use errors.acme.io",
  content: "The error catalogue moved to a new domain. Error types created from now on use `https://errors.acme.io/` instead of `https://errors.acme.dev/`; existing ones keep their URLs for now.",
  node_path: "/acme/problem.py",
};
const LIMITS = { id: "m2", title: "Limits moved", content: "Instead of `config/limits.json`, the generator now reads `config/limits/limits.json`.", node_path: "/" };
const WORDS = { id: "m3", title: "Wording", content: "We say `clients` instead of `users` in the docs.", node_path: "/docs" };

describe("changed decisions held to the edit", () => {
  it("compiles 'X instead of Y' and 'instead of Y … X' into stubs naming the old value, scoped to the memory's directory", () => {
    const stubs = changedDecisionStubs([DOMAIN, LIMITS, WORDS]);
    expect(stubs.map((s) => [s.scope, s.superseded])).toEqual([
      ["acme", "https://errors.acme.dev/"],
      ["", "config/limits.json"],
    ]);
    expect(stubs[0]!.ref).toMatch(/^cd_[0-9a-f]{8}$/);
    expect(stubs[0]!.line).toContain('`https://errors.acme.dev/` was replaced by `https://errors.acme.io/` (memory "New error types use errors.acme.io")');
    expect(stubs[0]!.line).toContain('"Error types created from now on use `https://errors.acme.io/` instead of `https://errors.acme.dev/`; existing ones keep their URLs for now."');
    expect(stubs[0]!.line).toMatch(/The newer value for new work; the old one only where the decision keeps it\.$/);
    expect(stubs[0]!.line.length).toBeLessThanOrEqual(CHANGED_DECISION_LINE_MAX);
    expect(stubs[1]!.line).toContain("was replaced by `config/limits/limits.json`");
  });

  it("selects the first undelivered stub whose scope holds the file and whose old value the edit writes, ignoring removed patch lines", () => {
    const index = { changed_decisions: changedDecisionStubs([DOMAIN, LIMITS]) };
    const [domain, limits] = index.changed_decisions;
    expect(selectChangedDecision(index, "acme/app.py", 'problem(410, "Gone", slug, base="https://errors.acme.dev/")', new Set())).toBe(domain);
    expect(selectChangedDecision(index, "cli/main.py", 'base="https://errors.acme.dev/"', new Set())).toBeNull();
    expect(selectChangedDecision(index, "acme/app.py", 'base="https://errors.acme.io/"', new Set())).toBeNull();
    expect(selectChangedDecision(index, "acme/app.py", 'base="https://errors.acme.dev/"', new Set([domain!.ref]))).toBeNull();
    expect(selectChangedDecision(index, "scripts/gen.py", '-SOURCE = "config/limits.json"\n+SOURCE = "config/limits/limits.json"', new Set())).toBeNull();
    expect(selectChangedDecision(index, "scripts/gen.py", 'SOURCE = "config/limits.json"', new Set())).toBe(limits);
    expect(writtenText("-a\n+b\nc")).toBe("+b\nc");
  });

  it("reaches the hook index from the store", async () => {
    const b = new LocalBackend(":memory:");
    b.registerWorkspace({ workspaceId: "ws", localRootPath: "/repo" });
    const node = await b.ensureNodeForPath("ws", "/acme", "folder");
    await b.writeMemory({ workspaceId: "ws", nodeId: node.id, title: DOMAIN.title, content: DOMAIN.content });
    await b.writeMemory({ workspaceId: "ws", nodeId: node.id, title: "Plain", content: "Nothing changed here." });
    const index = await b.buildHookIndexPayload("ws");
    expect(index?.changed_decisions?.map((s) => s.superseded)).toEqual(["https://errors.acme.dev/"]);
    b.close();
  });
});
