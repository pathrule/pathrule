// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryKnowledgeBackend } from "@pathrule/core";
import { updateRuleHandler, writeRuleHandler } from "@pathrule/core/tools/rules.js";
import { describe, expect, it } from "vitest";

import { checkApprovalHash, decideCheck, listRuleChecks } from "./check-approval.js";

const WS = "11111111-1111-4111-8111-111111111111";
const COMMAND = "northstar-check audit --token s3cr3t-value";

async function world() {
  const home = mkdtempSync(join(tmpdir(), "check-approval-"));
  const root = mkdtempSync(join(tmpdir(), "check-approval-root-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "vitest run" } }));
  const backend = new InMemoryKnowledgeBackend({ principal: "tester" });
  const ctx = { backend, userId: "tester", workspaceId: WS };
  const written = await writeRuleHandler(ctx, {
    node_path: "/",
    name: "Audit services",
    content: "# Audit\n\nRun the audit after changing services.",
    scope_type: "project",
    priority: "medium",
    check: { scope_path: "/services", command: COMMAND, message: "Run the audit before finishing." },
  } as never);
  if (!written.ok) throw new Error(JSON.stringify(written.error));
  const [row] = await listRuleChecks(backend, WS);
  const env = { PATHRULE_HOME: home } as NodeJS.ProcessEnv;
  const shown: string[] = [];
  const decide = (ask: ((q: string) => Promise<string>) | null) =>
    decideCheck({ backend, workspaceId: WS, userId: "tester", root, ruleId: row!.rule_id, checkId: row!.check_id, env, ask, show: (l) => shown.push(...l) });
  const log = () => readFileSync(join(home, "logs", "check-approvals.jsonl"), "utf8");
  return { backend, ctx, row: row!, decide, shown, log };
}

describe("a person's decision on a CHECK", () => {
  it("shows the exact command, its path and what approving does, and treats anything but yes as no", async () => {
    const w = await world();
    expect(w.row.status).toBe("proposed");
    for (const answer of ["", "y", "no", "YES please"]) {
      expect((await w.decide(async () => answer)).decision).toBe("declined");
    }
    expect(w.shown.join("\n")).toContain(`Command (exact words): ${COMMAND}`);
    expect(w.shown.join("\n")).toContain("Pathrule never runs this command");
    expect(w.shown.join("\n")).toContain("Applies under: /services");
    expect((await listRuleChecks(w.backend, WS))[0]!.status).toBe("proposed");
  });

  it("approves nothing without a terminal", async () => {
    const w = await world();
    expect((await w.decide(null)).decision).toBe("no_terminal");
    expect((await listRuleChecks(w.backend, WS))[0]!.status).toBe("proposed");
  });

  it("approves on yes, binds the approval to what was shown, and logs the hash but never the command's words", async () => {
    const w = await world();
    expect((await w.decide(async () => " Yes ")).decision).toBe("approved");
    const [after] = await listRuleChecks(w.backend, WS);
    expect(after!.status).toBe("active");
    expect(after!.approval_hash).toBe(w.row.approval_hash);
    const entries = w.log().trim().split("\n").map((l) => JSON.parse(l));
    expect(entries.at(-1)).toMatchObject({ decision: "approved", approval_hash: w.row.approval_hash, scope_path: "/services" });
    expect(w.log()).not.toContain("s3cr3t-value");
    expect(w.log()).not.toContain("northstar-check");
    expect((await w.decide(async () => "yes")).decision).toBe("already_active");
  });

  it("refuses a yes when the check changed after it was shown", async () => {
    const w = await world();
    const rule = (await w.backend.readRule(w.row.rule_id))!;
    const decision = await w.decide(async () => {
      // Between the question and the answer, the stored check's path changes.
      await w.backend.updateRule({
        id: rule.id,
        constraints: (rule.constraints ?? []).map((a) => ({ ...a, scope_path: "/" }) as never),
      });
      return "yes";
    });
    expect(decision.decision).toBe("changed");
    expect((await listRuleChecks(w.backend, WS))[0]!.status).toBe("proposed");
  });

  it("an approval never carries over to another command: core refuses a new command beside an approved one", async () => {
    const w = await world();
    await w.decide(async () => "yes");
    const updated = await updateRuleHandler(w.ctx, {
      rule_id: w.row.rule_id,
      patch: { check: { scope_path: "/services", command: "northstar-check audit --fast", message: "Run the fast audit." } },
    } as never);
    expect(updated.ok).toBe(false);
    const rows = await listRuleChecks(w.backend, WS);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ command: COMMAND, status: "active", approval_hash: w.row.approval_hash });
    expect(checkApprovalHash(WS, w.row.rule_id, { ...((await w.backend.readRule(w.row.rule_id))!.constraints![0] as object), requires: { kind: "command", command: "other", fingerprint: "x" } } as never)).not.toBe(w.row.approval_hash);
  });
});
