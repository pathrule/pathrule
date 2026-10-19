// SPDX-License-Identifier: Apache-2.0
// Acceptance criteria 1, 2 and 7 at the HANDLER boundary, which is the layer that
// actually decides authority. The pure gate is covered in
// knowledge/constraint.test.ts; what matters here is that the surface an agent calls
// cannot produce an enforceable constraint, and that a separate approval can.
//
// A small fake backend rather than a real edition: the question under test is what the
// handlers stamp and refuse, and a storage engine would only add noise.

import { beforeEach, describe, expect, it } from "vitest";

import { compileRuleConstraints } from "@pathrule/agent-ir/atoms/constraint.js";
import type { Rule } from "@pathrule/protocol/content-types.js";
import type { ToolContext } from "./types.js";
import {
  approveRuleCheckHandler,
  approveRuleConstraintHandler,
  updateRuleHandler,
  writeRuleHandler,
} from "./rules.js";
import type { PackageScripts } from "@pathrule/agent-ir/verification/script-resolution.js";
import type { StructuredConstraintIntent } from "@pathrule/agent-ir/atoms/constraint-compiler.js";

const RULE_33_CONSTRAINT = {
  mode: "forbid" as const,
  pattern: "cursor:\\s*pointer",
  flags: "i",
  message: "Use a real <button> or <a>; they carry the pointer cursor and the semantics.",
};

let store: Map<string, Rule>;

function seedRule(overrides: Partial<Rule> = {}): Rule {
  const rule: Rule = {
    id: "rule-33",
    workspaceId: "ws-1",
    name: "Never use cursor: pointer",
    content: "Never use cursor: pointer on a div. Use a real button or anchor.",
    scopeType: "project",
    priority: "medium",
    versionId: "v-1",
    versionNumber: 1,
    createdBy: "user-1",
    lastEditedBy: "user-1",
    lastEditedAt: "2026-09-03T00:00:00.000Z",
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
  store.set(rule.id, rule);
  return rule;
}

function makeCtx(): ToolContext {
  const backend = {
    isDemoWorkspace: async () => false,
    ensureNodeForPath: async (workspaceId: string) => ({ id: "node-1", workspace_id: workspaceId }),
    checkContentDedup: async () => ({ duplicate: null, similar: [] }),
    readRule: async (id: string) => store.get(id) ?? null,
    writeRule: async (input: Record<string, unknown>) => {
      const rule = seedRule({
        id: "rule-new",
        name: String(input["name"]),
        content: String(input["content"]),
        constraints: input["constraints"] as Rule["constraints"],
      });
      return rule;
    },
    updateRule: async (input: Record<string, unknown>) => {
      const current = store.get(String(input["id"]))!;
      const next: Rule = {
        ...current,
        ...(input["constraints"] ? { constraints: input["constraints"] as Rule["constraints"] } : {}),
        ...(input["content"] !== undefined ? { content: String(input["content"]) } : {}),
      };
      store.set(next.id, next);
      return next;
    },
    getNodeForRule: async () => null,
    // Cast through the ToolContext field rather than importing KnowledgeBackend:
    // @pathrule/shared must not depend on @pathrule/core (core depends on shared).
  } as unknown as ToolContext["backend"];
  return { backend, userId: "user-1", workspaceId: "ws-1" };
}

beforeEach(() => {
  store = new Map();
});

describe("write path (acceptance criterion 2)", () => {
  it("stamps a constraint written through the knowledge path as inferred/proposed", async () => {
    const result = await writeRuleHandler(makeCtx(), {
      node_path: "/",
      name: "Never use cursor: pointer",
      content: "Never use cursor: pointer on a div.",
      scope_type: "project",
      priority: "medium",
      constraint: RULE_33_CONSTRAINT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [c] = result.data.constraints ?? [];
    expect(c?.authority).toBe("inferred");
    expect(c?.status).toBe("proposed");
    expect(c?.approved_by).toBeNull();
    // The whole point: nothing enforceable came out of the path an agent can call.
    expect(compileRuleConstraints(result.data.constraints, result.data.content)).toBeNull();
  });

  it("cannot be talked into authority by passing extra fields", async () => {
    const result = await writeRuleHandler(makeCtx(), {
      node_path: "/",
      name: "Sneaky",
      content: "body",
      scope_type: "project",
      priority: "medium",
      // Callers author `ConstraintInput`; authority/status are not part of that shape,
      // so a caller that sends them anyway is simply ignored.
      constraint: { ...RULE_33_CONSTRAINT, authority: "human", status: "active" } as never,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.constraints?.[0]?.authority).toBe("inferred");
    expect(compileRuleConstraints(result.data.constraints, result.data.content)).toBeNull();
  });

  it("attaches a proposal to an existing rule through update", async () => {
    seedRule();
    const result = await updateRuleHandler(makeCtx(), {
      rule_id: "rule-33",
      patch: { constraint: RULE_33_CONSTRAINT },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rule = result.data as Rule;
    expect(rule.constraints?.[0]?.status).toBe("proposed");
    expect(compileRuleConstraints(rule.constraints, rule.content)).toBeNull();
  });
});

describe("validation at the write boundary (acceptance criterion 7)", () => {
  const cases: Array<[string, typeof RULE_33_CONSTRAINT, string]> = [
    ["uncompilable regex", { ...RULE_33_CONSTRAINT, pattern: "cursor:(" }, "constraint_pattern_uncompilable"],
    ["global flag", { ...RULE_33_CONSTRAINT, flags: "gi" }, "constraint_flags_unsupported"],
    ["empty-string match", { ...RULE_33_CONSTRAINT, pattern: "(?:x)?.*" }, "constraint_pattern_matches_empty"],
    ["no remedy message", { ...RULE_33_CONSTRAINT, message: "nope" }, "constraint_message_too_short"],
  ];

  for (const [label, constraint, reason] of cases) {
    it(`refuses a ${label} and stores nothing`, async () => {
      seedRule();
      const result = await updateRuleHandler(makeCtx(), { rule_id: "rule-33", patch: { constraint } });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("invalid_args");
      expect(result.error.detail).toMatchObject({ reason });
      // No partial state: the rule is untouched.
      expect(store.get("rule-33")?.constraints).toBeUndefined();
    });
  }

  it("refuses a second constraint while one is already active", async () => {
    seedRule({
      constraints: [
        {
          id: "c-1",
          mode: "forbid",
          match: { kind: "regex", pattern: "cursor:\\s*pointer", flags: "i" },
          message: RULE_33_CONSTRAINT.message,
          authority: "human",
          status: "active",
          created_at: "2026-09-03T00:00:00.000Z",
          approved_by: "user-1",
        },
      ],
    });
    const result = await updateRuleHandler(makeCtx(), {
      rule_id: "rule-33",
      patch: { constraint: { ...RULE_33_CONSTRAINT, pattern: "float\\s+money" } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_args");
  });
});

describe("the AUTO gate", () => {
  const PROSE = 'Never apply `cursor: pointer` (or the Tailwind `cursor-pointer` class) anywhere in the app UI.';
  /**
   * The rule body the policy is quoted FROM. `explicit` provenance is only honoured
   * against prose that is already stored, so every AUTO test here seeds it first: that
   * is the contract, not test scaffolding.
   */
  const BODY = `# Cursor\n\n${PROSE}\n\nUse hover background or opacity instead.`;
  const seedWithProse = (overrides: Partial<Rule> = {}) => seedRule({ content: BODY, ...overrides });
  const INTENT: StructuredConstraintIntent = {
    source_text: PROSE,
    forbidden_forms: [
      { literal: "cursor: pointer", form_kind: "css_declaration" },
      { literal: "cursor-pointer", form_kind: "class_name" },
    ],
    positive_examples: [".cta { cursor: pointer; }", 'style={{ cursor: "pointer" }}'],
    negative_examples: [".cta { cursor: default; }", "const cursorPointer = 1;"],
    message: "Use hover background, colour or opacity to signal interactivity, not the cursor.",
  };

  it("activates a verified representation of an EXPLICIT policy with no approval", async () => {
    seedWithProse();
    const result = await updateRuleHandler(makeCtx(), {
      rule_id: "rule-33",
      patch: { constraint_intent: INTENT },
      policy_provenance: "explicit",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const atom = (result.data as Rule).constraints?.[0] as {
      authority?: string;
      status?: string;
      approved_by?: string | null;
    };
    expect(atom.authority).toBe("verified");
    expect(atom.status).toBe("active");
    // Nobody approved this; a machine proved it. Recording a person would be the same
    // conflation the enum split exists to end.
    expect(atom.approved_by).toBeNull();
    // And it really is enforceable, without any approval call.
    expect(compileRuleConstraints((result.data as Rule).constraints, (result.data as Rule).content)).not.toBeNull();
  });

  it("leaves an INFERRED policy proposed even when the representation verifies", async () => {
    // Verification licenses the representation. It does not license a policy nobody stated.
    seedRule();
    const result = await updateRuleHandler(makeCtx(), {
      rule_id: "rule-33",
      patch: { constraint_intent: INTENT },
      policy_provenance: "inferred",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const atom = (result.data as Rule).constraints?.[0] as { authority?: string; status?: string };
    expect(atom.authority).toBe("inferred");
    expect(atom.status).toBe("proposed");
    expect(compileRuleConstraints((result.data as Rule).constraints, (result.data as Rule).content)).toBeNull();
  });

  it("defaults to the safe answer when provenance is not asserted", async () => {
    seedRule();
    const result = await updateRuleHandler(makeCtx(), {
      rule_id: "rule-33",
      patch: { constraint_intent: INTENT },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as Rule).constraints?.[0]?.status).toBe("proposed");
  });

  it("refuses the write outright when the representation cannot be verified", async () => {
    // An explicit policy does not license a representation nobody could check, and the
    // refusal names the oracle that failed rather than weakening the pattern.
    seedWithProse();
    const result = await updateRuleHandler(makeCtx(), {
      rule_id: "rule-33",
      patch: {
        constraint_intent: {
          ...INTENT,
          positive_examples: [...INTENT.positive_examples, "cursor is a pointer"],
        },
      },
      policy_provenance: "explicit",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toMatchObject({ reason: "POSITIVE_COVERAGE_FAILED" });
    expect(store.get("rule-33")?.constraints).toBeUndefined();
  });

  const UNGROUNDED: StructuredConstraintIntent = {
    ...INTENT,
    forbidden_forms: [{ literal: "cursor: grab", form_kind: "css_declaration" }],
    positive_examples: [".a { cursor: grab; }"],
    negative_examples: [".a { cursor: default; }"],
  };

  it("refuses a literal the STORED rule body does not contain, for an explicit policy", async () => {
    // The surface-level anchor, which fires before the compiler is even asked: a ban
    // nobody wrote down cannot be claimed as an explicit human policy.
    seedWithProse();
    const result = await updateRuleHandler(makeCtx(), {
      rule_id: "rule-33",
      patch: { constraint_intent: UNGROUNDED },
      policy_provenance: "explicit",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toMatchObject({
      reason: "LITERAL_NOT_IN_RULE_BODY",
      literal: "cursor: grab",
    });
  });

  it("refuses an ungrounded literal in the COMPILER too, whatever the provenance", async () => {
    // Independent of the anchor above: the compiler checks the literal against the
    // source_text it claims to come from, so an inferred policy cannot smuggle one in
    // either. Two layers, because this is the check that stops invented prohibitions.
    seedWithProse();
    const result = await updateRuleHandler(makeCtx(), {
      rule_id: "rule-33",
      patch: { constraint_intent: UNGROUNDED },
      policy_provenance: "inferred",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toMatchObject({ reason: "INSUFFICIENT_GROUNDING" });
    expect(store.get("rule-33")?.constraints).toBeUndefined();
  });

  it("refuses an explicit claim from a call that CREATES the rule", async () => {
    // There is no prose predating a rule being written, so the claim is unprovable.
    const result = await writeRuleHandler(makeCtx(), {
      node_path: "/",
      name: "Never use cursor: pointer",
      content: BODY,
      scope_type: "project",
      priority: "medium",
      constraint_intent: INTENT,
      policy_provenance: "explicit",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toMatchObject({ reason: "POLICY_NOT_PREDATED" });
  });

  it("refuses an explicit claim from a call that also rewrites the body", async () => {
    // Authoring the text and citing it in the same breath proves nothing.
    seedWithProse();
    const result = await updateRuleHandler(makeCtx(), {
      rule_id: "rule-33",
      patch: { content: `${BODY}\n\nAlso never use \`cursor: grab\`.`, constraint_intent: INTENT },
      policy_provenance: "explicit",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toMatchObject({ reason: "POLICY_AUTHORED_IN_SAME_CALL" });
  });

  it("refuses an explicit claim whose source_text is not an excerpt of the body", async () => {
    seedWithProse();
    const result = await updateRuleHandler(makeCtx(), {
      rule_id: "rule-33",
      patch: {
        constraint_intent: { ...INTENT, source_text: "The team agreed to ban cursor: pointer." },
      },
      policy_provenance: "explicit",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toMatchObject({ reason: "SOURCE_TEXT_NOT_IN_RULE_BODY" });
  });

  it("activates a path-only constraint with no pattern at all", async () => {
    seedRule({
      content: "Scope all mobile companion files at /packages/mobile, never under Pathrule/**.",
    });
    const result = await updateRuleHandler(makeCtx(), {
      rule_id: "rule-33",
      patch: {
        constraint_intent: {
          source_text: "Scope all mobile companion files at /packages/mobile, never under Pathrule/**.",
          forbidden_forms: [],
          scope_path: "/packages/mobile/Pathrule",
          file_extensions: [".md"],
          positive_examples: ["/packages/mobile/Pathrule/CLAUDE.md"],
          negative_examples: ["/packages/mobile/CLAUDE.md"],
          message: "Scope mobile knowledge at /packages/mobile, never under Pathrule/.",
        },
      },
      policy_provenance: "explicit",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const compiled = compileRuleConstraints((result.data as Rule).constraints, (result.data as Rule).content);
    expect(compiled?.block_pattern).toBeUndefined();
    expect(compiled?.block_path).toEqual({
      scope_path: "/packages/mobile/Pathrule",
      file_extensions: [".md"],
      message: "Scope mobile knowledge at /packages/mobile, never under Pathrule/.",
    });
  });

  it("supersedes a previous AUTO-active constraint instead of stacking a second one", async () => {
    seedWithProse();
    const first = await updateRuleHandler(makeCtx(), {
      rule_id: "rule-33",
      patch: { constraint_intent: INTENT },
      policy_provenance: "explicit",
    });
    if (!first.ok) throw new Error("first AUTO should have been accepted");
    const firstId = (first.data as Rule).constraints![0]!.id;

    // Same prose, narrower representation. The rule must end with ONE active atom.
    const second = await updateRuleHandler(makeCtx(), {
      rule_id: "rule-33",
      patch: {
        constraint_intent: {
          ...INTENT,
          forbidden_forms: [{ literal: "cursor-pointer", form_kind: "class_name" }],
          positive_examples: ['<div className="cursor-pointer">'],
          negative_examples: ['<div className="cursor-not-allowed">'],
        },
      },
      policy_provenance: "explicit",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const atoms = (second.data as Rule).constraints ?? [];
    expect(atoms).toHaveLength(1);
    expect(atoms[0]!.id).not.toBe(firstId);
    // And the surviving representation is the new one, not the stale one.
    expect(compileRuleConstraints(atoms, (second.data as Rule).content)?.block_pattern?.source).toContain("cursor-pointer");
  });

  it("will not overwrite a HUMAN-approved active constraint", async () => {
    // A person's decision is not the compiler's to replace.
    seedWithProse({
      constraints: [
        {
          id: "c-human",
          mode: "forbid",
          match: { kind: "regex", pattern: "cursor:\\s*pointer", flags: "i" },
          message: RULE_33_CONSTRAINT.message,
          authority: "human",
          status: "active",
          created_at: "2026-09-03T00:00:00.000Z",
          approved_by: "user-1",
        },
      ],
    });
    const result = await updateRuleHandler(makeCtx(), {
      rule_id: "rule-33",
      patch: { constraint_intent: INTENT },
      policy_provenance: "explicit",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("human-approved active constraint");
    expect(store.get("rule-33")?.constraints?.[0]?.status).toBe("active");
  });

  it("demotes an AUTO-active constraint when the body is rewritten without re-proving it", async () => {
    // The stale case. The representation was proved against prose that no longer exists,
    // so it stops enforcing rather than blocking on a ban the rule may no longer state.
    seedWithProse();
    const armed = await updateRuleHandler(makeCtx(), {
      rule_id: "rule-33",
      patch: { constraint_intent: INTENT },
      policy_provenance: "explicit",
    });
    if (!armed.ok) throw new Error("AUTO should have been accepted");
    expect(compileRuleConstraints((armed.data as Rule).constraints, (armed.data as Rule).content)).not.toBeNull();

    const edited = await updateRuleHandler(makeCtx(), {
      rule_id: "rule-33",
      patch: { content: "# Cursor\n\nPointer cursors are fine now. Use them freely." },
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    const atom = (edited.data as Rule).constraints?.[0];
    expect(atom?.authority).toBe("inferred");
    expect(atom?.status).toBe("proposed");
    expect(atom?.approved_by).toBeNull();
    // Nothing enforceable survives the edit.
    expect(compileRuleConstraints((edited.data as Rule).constraints, (edited.data as Rule).content)).toBeNull();
  });

  it("stores the prose it was proved against, so the pair can be re-proved later", async () => {
    // The stored half of the grounding contract. Without it a verified atom is a pattern
    // with no way back to the policy that licensed it, and the compile gate has nothing
    // to check.
    seedWithProse();
    const result = await updateRuleHandler(makeCtx(), {
      rule_id: "rule-33",
      patch: { constraint_intent: INTENT },
      policy_provenance: "explicit",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const atom = (result.data as Rule).constraints?.[0] as { grounding?: { source_text?: string } };
    expect(atom.grounding?.source_text).toBe(PROSE);
    expect(BODY).toContain(atom.grounding!.source_text!);
  });

  it("keeps an AUTO-active constraint when the edit leaves its source sentence intact", async () => {
    // Demotion is grounding-aware, not "the body changed". Disarming a constraint because
    // somebody appended an unrelated paragraph to the same rule is invalidation sensitive
    // enough to teach people not to edit rules, and it protects nothing.
    seedWithProse();
    const armed = await updateRuleHandler(makeCtx(), {
      rule_id: "rule-33",
      patch: { constraint_intent: INTENT },
      policy_provenance: "explicit",
    });
    if (!armed.ok) throw new Error("AUTO should have been accepted");

    const edited = await updateRuleHandler(makeCtx(), {
      rule_id: "rule-33",
      patch: { content: `${BODY}\n\nPrefer a hover background to an opacity change.` },
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    const atom = (edited.data as Rule).constraints?.[0];
    expect(atom?.authority).toBe("verified");
    expect(atom?.status).toBe("active");
    expect(
      compileRuleConstraints((edited.data as Rule).constraints, (edited.data as Rule).content),
    ).not.toBeNull();
  });

  it("does not enforce a stale atom even when the DB still calls it active", async () => {
    // The bypass case at this boundary: the atom list is exactly what the handler left,
    // and only the body moved. Every mutation path that does not know constraints exist
    // produces this state, so the projection has to be the thing that refuses it.
    seedWithProse();
    const armed = await updateRuleHandler(makeCtx(), {
      rule_id: "rule-33",
      patch: { constraint_intent: INTENT },
      policy_provenance: "explicit",
    });
    if (!armed.ok) throw new Error("AUTO should have been accepted");
    const stale = (armed.data as Rule).constraints;
    expect(stale?.[0]?.status).toBe("active");

    // Same stored atoms, a body that no longer states the ban.
    expect(compileRuleConstraints(stale, "Pointer cursors are fine now. Use them freely.")).toBeNull();
  });

  it("leaves a HUMAN-approved constraint alone when the body is rewritten", async () => {
    // Its authority came from a person, not from a grounding in this prose, so the
    // demotion must not reach it.
    seedWithProse({
      constraints: [
        {
          id: "c-human",
          mode: "forbid",
          match: { kind: "regex", pattern: "cursor:\\s*pointer", flags: "i" },
          message: RULE_33_CONSTRAINT.message,
          authority: "human",
          status: "active",
          created_at: "2026-09-03T00:00:00.000Z",
          approved_by: "user-1",
        },
      ],
    });
    const edited = await updateRuleHandler(makeCtx(), {
      rule_id: "rule-33",
      patch: { content: "# Cursor\n\nRewritten body." },
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect((edited.data as Rule).constraints?.[0]?.status).toBe("active");
  });

  it("a rewrite that produces identical text is not a rewrite", async () => {
    seedWithProse();
    const armed = await updateRuleHandler(makeCtx(), {
      rule_id: "rule-33",
      patch: { constraint_intent: INTENT },
      policy_provenance: "explicit",
    });
    if (!armed.ok) throw new Error("AUTO should have been accepted");
    const same = await updateRuleHandler(makeCtx(), {
      rule_id: "rule-33",
      patch: { content: BODY, priority: "high" },
    });
    expect(same.ok).toBe(true);
    if (!same.ok) return;
    expect((same.data as Rule).constraints?.[0]?.status).toBe("active");
  });

  it("does not disturb the existing PROPOSE flow for a hand-written constraint", async () => {
    // Regression: the pre-compiler path still lands inferred/proposed exactly as before.
    seedRule();
    const result = await updateRuleHandler(makeCtx(), {
      rule_id: "rule-33",
      patch: { constraint: RULE_33_CONSTRAINT },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as Rule).constraints?.[0]?.authority).toBe("inferred");
    expect((result.data as Rule).constraints?.[0]?.status).toBe("proposed");
  });
});

describe("CHECK authoring-time resolution", () => {
  const SCRIPTS: PackageScripts[] = [
    { name: "pathrule", dir: "/", scripts: {} },
    { name: "@pathrule/app", dir: "/packages/app", scripts: { test: "vitest run", "test:watch": "vitest" } },
  ];
  const CHECK = {
    scope_path: "/packages/app",
    command: "pnpm --filter @pathrule/app test:watch",
    message: "The app suite has to pass, and it must be a one-shot run rather than a watch.",
  };

  it("refuses a watch requirement at the WRITE boundary when the surface can resolve", async () => {
    seedRule();
    const result = await updateRuleHandler(makeCtx(), {
      rule_id: "rule-33",
      patch: { check: CHECK },
      workspace_scripts: SCRIPTS,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toMatchObject({ reason: "check_command_non_terminating" });
    expect(store.get("rule-33")?.constraints).toBeUndefined();
  });

  it("accepts it when the surface cannot resolve, and records that it could not", async () => {
    // The remote MCP has no repo filesystem. This must not be a silent pass.
    seedRule();
    const result = await updateRuleHandler(makeCtx(), { rule_id: "rule-33", patch: { check: CHECK } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const atom = (result.data as Rule).constraints?.[0] as { requires?: { resolved?: unknown } };
    expect(atom.requires?.resolved).toBeUndefined();
  });

  it("refuses at APPROVAL even when the proposal claimed it was fine", async () => {
    // The load-bearing placement. A proposer with no filesystem, or an agent supplying a
    // flattering resolution, cannot get past the approver's own read of the repo.
    seedRule();
    const proposal = await updateRuleHandler(makeCtx(), { rule_id: "rule-33", patch: { check: CHECK } });
    if (!proposal.ok) throw new Error("proposal should have been accepted");
    const checkId = ((proposal.data as Rule).constraints![0] as { id: string }).id;

    // Forge a flattering resolution directly onto the stored atom.
    const current = store.get("rule-33")!;
    store.set("rule-33", {
      ...current,
      constraints: (current.constraints ?? []).map((a) =>
        (a as { id: string }).id === checkId
          ? ({
              ...(a as object),
              requires: {
                ...((a as { requires: object }).requires as object),
                resolved: { status: "resolved", runs: "vitest run", chain: [], reason: null },
              },
            } as never)
          : a,
      ),
    });

    const approved = await approveRuleCheckHandler(makeCtx(), {
      rule_id: "rule-33",
      check_id: checkId,
      confirm: true,
      workspace_scripts: SCRIPTS,
    });
    expect(approved.ok).toBe(false);
    if (approved.ok) return;
    expect(approved.error.detail).toMatchObject({ reason: "check_command_non_terminating" });
  });

  it("stamps the APPROVER's resolution over whatever the proposal stored", async () => {
    seedRule();
    const good = { ...CHECK, command: "pnpm --filter @pathrule/app test" };
    const proposal = await updateRuleHandler(makeCtx(), { rule_id: "rule-33", patch: { check: good } });
    if (!proposal.ok) throw new Error("proposal should have been accepted");
    const checkId = ((proposal.data as Rule).constraints![0] as { id: string }).id;

    const approved = await approveRuleCheckHandler(makeCtx(), {
      rule_id: "rule-33",
      check_id: checkId,
      confirm: true,
      workspace_scripts: SCRIPTS,
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    const atom = approved.data.constraints?.[0] as { requires?: { resolved?: { runs?: string } } };
    expect(atom.requires?.resolved?.runs).toBe("vitest run");
  });

  it("records unresolved when the approver supplied no repo data", async () => {
    seedRule();
    const good = { ...CHECK, command: "pnpm --filter @pathrule/app test" };
    const proposal = await updateRuleHandler(makeCtx(), { rule_id: "rule-33", patch: { check: good } });
    if (!proposal.ok) throw new Error("proposal should have been accepted");
    const checkId = ((proposal.data as Rule).constraints![0] as { id: string }).id;
    const approved = await approveRuleCheckHandler(makeCtx(), {
      rule_id: "rule-33",
      check_id: checkId,
      confirm: true,
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    const atom = approved.data.constraints?.[0] as { requires?: { resolved?: { status?: string; reason?: string } } };
    expect(atom.requires?.resolved?.status).toBe("unresolved");
    expect(atom.requires?.resolved?.reason).toContain("no package.json data");
  });
});

describe("approval (acceptance criterion 1)", () => {
  async function proposeOnRule33() {
    seedRule();
    const result = await updateRuleHandler(makeCtx(), {
      rule_id: "rule-33",
      patch: { constraint: RULE_33_CONSTRAINT },
    });
    if (!result.ok) throw new Error("proposal should have been accepted");
    return (result.data as Rule).constraints![0]!.id;
  }

  it("turns a proposal into human/active and only then compiles", async () => {
    const constraintId = await proposeOnRule33();
    const approved = await approveRuleConstraintHandler(makeCtx(), {
      rule_id: "rule-33",
      constraint_id: constraintId,
      confirm: true,
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    const c = approved.data.constraints?.[0];
    expect(c?.authority).toBe("human");
    expect(c?.status).toBe("active");
    expect(c?.approved_by).toBe("user-1");
    expect(compileRuleConstraints(approved.data.constraints, approved.data.content)).toEqual({
      enforcement: "strict",
      block_pattern: {
        source: "cursor:\\s*pointer",
        flags: "i",
        message: RULE_33_CONSTRAINT.message,
      },
    });
  });

  it("refuses to approve without an explicit confirmation", async () => {
    const constraintId = await proposeOnRule33();
    const result = await approveRuleConstraintHandler(makeCtx(), {
      rule_id: "rule-33",
      constraint_id: constraintId,
      confirm: false as true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_args");
  });

  it("refuses to approve a constraint that does not exist on the rule", async () => {
    await proposeOnRule33();
    const result = await approveRuleConstraintHandler(makeCtx(), {
      rule_id: "rule-33",
      constraint_id: "c-does-not-exist",
      confirm: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("not_found");
  });

  it("refuses to approve a stored proposal whose pattern no longer validates", async () => {
    seedRule({
      constraints: [
        {
          id: "c-broken",
          mode: "forbid",
          match: { kind: "regex", pattern: "cursor:(", flags: "" },
          message: RULE_33_CONSTRAINT.message,
          authority: "inferred",
          status: "proposed",
          created_at: "2026-09-03T00:00:00.000Z",
          approved_by: null,
        },
      ],
    });
    const result = await approveRuleConstraintHandler(makeCtx(), {
      rule_id: "rule-33",
      constraint_id: "c-broken",
      confirm: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toMatchObject({ reason: "constraint_pattern_uncompilable" });
  });
});
