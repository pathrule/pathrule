// SPDX-License-Identifier: Apache-2.0
// Where a stored belief about a person applies, and whether it may reach an agent: the open rules,
// tested on atoms built directly. Learning a belief (judging, strengthening, globalizing) is Pathrule
// Intelligence and is tested with the engine.
import { describe, expect, it } from "vitest";

import {
  effectiveUserWorkspace,
  isUserKnowledgeDeliverable,
  userKnowledgeApplies,
  type UserEvidence,
  type UserKnowledgeAtom,
} from "./user-knowledge.js";
import { narrowUserKnowledge, rejectUserKnowledge, supersedeUserKnowledge } from "./user-knowledge-lifecycle.js";

const NOW = "2026-10-05T12:00:00.000Z";

function ev(workspace_id: string | null, message_id: string): UserEvidence {
  return { kind: "correction", quote: "Change it incrementally.", observed_at: NOW, surface: "studio", workspace_id, thread_id: message_id, message_id };
}

function atom(evidence: UserEvidence[], over: Partial<UserKnowledgeAtom> = {}): UserKnowledgeAtom {
  return {
    id: "a1",
    kind: "user_knowledge",
    primitive: "selection",
    scope: "user",
    claim: "Prefer incremental refactors over rewrites.",
    claim_evidence: ["Change it incrementally"],
    trigger_evidence: [],
    source_type: "INFERRED",
    evidence,
    confidence: "medium",
    status: "active",
    applies_to_workspace_id: null,
    applies_to_path: null,
    created_at: NOW,
    updated_at: NOW,
    last_observed_at: NOW,
    superseded_by: null,
    fingerprint: "a1",
    ...over,
  };
}

describe("where a belief applies", () => {
  it("stays with the one workspace its evidence came from", () => {
    const a = atom([ev("ws-a", "m1"), ev("ws-a", "m2")]);
    expect(effectiveUserWorkspace(a)).toBe("ws-a");
    expect(userKnowledgeApplies(a, { workspace_id: "ws-a", path: null })).toBe(true);
    expect(userKnowledgeApplies(a, { workspace_id: "ws-b", path: null })).toBe(false);
  });

  it("travels once a second workspace shows it, and when no workspace recorded it", () => {
    expect(effectiveUserWorkspace(atom([ev("ws-a", "m1"), ev("ws-b", "m2")]))).toBeNull();
    expect(userKnowledgeApplies(atom([ev(null, "m1")]), { workspace_id: "ws-z", path: null })).toBe(true);
  });

  it("follows the person's word in both directions", () => {
    const freed = narrowUserKnowledge(atom([ev("ws-a", "m1")]), { workspace_id: null }, { now: NOW });
    expect(userKnowledgeApplies(freed, { workspace_id: "ws-b", path: null })).toBe(true);
    const pinned = narrowUserKnowledge(freed, { workspace_id: "ws-a" }, { now: NOW });
    expect(userKnowledgeApplies(pinned, { workspace_id: "ws-b", path: null })).toBe(false);
  });

  it("finds a workspace recorded by its root path only through an exact alias", () => {
    const a = atom([ev("/Users/me/proj", "m1")]);
    expect(userKnowledgeApplies(a, { workspace_id: "4b1d", path: null, workspace_aliases: ["/Users/me/proj/"] })).toBe(true);
    expect(userKnowledgeApplies(a, { workspace_id: "4b1d", path: null })).toBe(false);
  });

  it("narrows to a path with ancestor semantics", () => {
    const a = narrowUserKnowledge(atom([ev("ws-a", "m1")]), { path: "/apps/web" }, { now: NOW });
    expect(userKnowledgeApplies(a, { workspace_id: "ws-a", path: "/apps/web/button.tsx" })).toBe(true);
    expect(userKnowledgeApplies(a, { workspace_id: "ws-a", path: "/apps/api" })).toBe(false);
    expect(userKnowledgeApplies(a, { workspace_id: "ws-a", path: null })).toBe(false);
  });

  it("leaves a behavioural belief's own scope alone", () => {
    expect(effectiveUserWorkspace(atom([ev("ws-a", "m1")], { basis: "edits" }))).toBeNull();
  });
});

describe("whether a belief may reach an agent", () => {
  it("only when it is active, current and not a low-confidence guess", () => {
    const a = atom([ev("ws-a", "m1")]);
    expect(isUserKnowledgeDeliverable(a)).toBe(true);
    expect(isUserKnowledgeDeliverable({ ...a, confidence: "low" })).toBe(false);
    expect(isUserKnowledgeDeliverable({ ...a, status: "candidate" })).toBe(false);
    expect(isUserKnowledgeDeliverable(rejectUserKnowledge(a, { now: NOW }))).toBe(false);
    expect(isUserKnowledgeDeliverable(supersedeUserKnowledge(a, "a2", { now: NOW }))).toBe(false);
  });
});

describe("a belief narrowed to a path, compiled for an index written before the working path is known", () => {
  it("is left out without carryPathScope and travels marked with its path with it", async () => {
    const { compileUserPreferenceEntries } = await import("./user-delivery.js");
    const narrowed = narrowUserKnowledge(atom([ev("ws-a", "m1"), ev("ws-a", "m2")]), { path: "packages/app" }, { now: NOW });
    const where = { workspace_id: "ws-a", path: null };
    expect(compileUserPreferenceEntries([narrowed], where)).toEqual([]);
    expect(compileUserPreferenceEntries([narrowed], where, undefined, { carryPathScope: true })).toEqual([
      expect.objectContaining({ id: "a1", path: "/packages/app" }),
    ]);
    // An unscoped belief is compiled exactly as before.
    const open = atom([ev("ws-a", "m1"), ev("ws-a", "m2")]);
    expect(compileUserPreferenceEntries([open], where, undefined, { carryPathScope: true })).toEqual(
      compileUserPreferenceEntries([open], where),
    );
  });
});
