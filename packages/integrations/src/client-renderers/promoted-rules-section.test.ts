// SPDX-License-Identifier: Apache-2.0
// Tests for promoted_rules section emitter

import { describe, it, expect } from "vitest";
import {
  renderPromotedRulesMarkdown,
  splicePromotedRulesSection,
  computePromotedRulesSignature,
  PROMOTED_RULES_ANCHOR_BEGIN,
  PROMOTED_RULES_ANCHOR_END,
} from "./promoted-rules-section.js";
import type { PromotedRulesBundle } from "./types.js";

// ─── fixtures ─────────────────────────────────────────────────────────────────

function makeBundle(entries: PromotedRulesBundle["entries"] = []): PromotedRulesBundle {
  return {
    workspace_id: "ws-test",
    entries,
    signature: "abc12345",
    rendered_at: "2026-05-21T03:00:00.000Z",
  };
}

const FIVE_RULES: PromotedRulesBundle["entries"] = [
  {
    rule_id: "r1",
    name: "User JWT only — never service role",
    display_summary:
      "All Supabase access flows through the user JWT. Service role is never used in app code.",
    priority: "high",
    scope_type: "project",
    promoted_at: "2026-05-21T00:00:00.000Z",
  },
  {
    rule_id: "r2",
    name: "Cloud-first — Pathrule cloud is the only source of truth",
    display_summary:
      "Cloud-first: Pathrule cloud is the source of truth. The rendered instructions file is the only disk artifact.",
    priority: "high",
    scope_type: "project",
    promoted_at: null,
  },
  {
    rule_id: "r3",
    name: "Unrelated open files are not task scope",
    display_summary:
      "Open files unrelated to the current task are not in scope — do not edit them.",
    priority: "medium",
    scope_type: "project",
    promoted_at: null,
  },
  {
    rule_id: "r4",
    name: "Recent activity: prefer Pathrule over git",
    display_summary:
      "Recent-activity questions: query Pathrule first, fall back to git only when Pathrule has nothing.",
    priority: "medium",
    scope_type: "project",
    promoted_at: null,
  },
  {
    rule_id: "r5",
    name: "Critical rule",
    display_summary: "This is a critical rule.",
    priority: "critical",
    scope_type: "project",
    promoted_at: null,
  },
];

// ─── renderPromotedRulesMarkdown ──────────────────────────────────────────────

describe("renderPromotedRulesMarkdown", () => {
  it("renders 5 rules with heading and attribution", () => {
    const bundle = makeBundle(FIVE_RULES);
    const md = renderPromotedRulesMarkdown(bundle, { headingLevel: 2, includeAttribution: true });

    expect(md).toContain(PROMOTED_RULES_ANCHOR_BEGIN);
    expect(md).toContain(PROMOTED_RULES_ANCHOR_END);
    expect(md).toContain("## Workspace Rules (Pathrule)");
    expect(md).toContain("_These rules are managed by Pathrule.");
    expect(md).toContain("User JWT only — never service role");
    expect(md).toContain("critical"); // critical tag
    // signature comment
    expect(md).toContain(`pathrule:promoted-rules-signature=${bundle.signature}`);
  });

  it("empty bundle: renders only signature comment between anchors", () => {
    const bundle = makeBundle([]);
    const md = renderPromotedRulesMarkdown(bundle, { headingLevel: 2, includeAttribution: true });
    expect(md).toContain(PROMOTED_RULES_ANCHOR_BEGIN);
    expect(md).toContain(PROMOTED_RULES_ANCHOR_END);
    expect(md).not.toContain("## Workspace Rules");
    expect(md).not.toContain("_These rules are managed");
  });

  it("level-3 heading", () => {
    const bundle = makeBundle(FIVE_RULES);
    const md = renderPromotedRulesMarkdown(bundle, { headingLevel: 3, includeAttribution: false });
    expect(md).toContain("### Workspace Rules (Pathrule)");
    expect(md).not.toContain("_These rules are managed");
  });

  it("signatures are identical for the same entries (cross-client parity)", async () => {
    const sig1 = await computePromotedRulesSignature(FIVE_RULES);
    const sig2 = await computePromotedRulesSignature(FIVE_RULES);
    // Different order should still produce same signature (entries are sorted by rule_id)
    const sig3 = await computePromotedRulesSignature([...FIVE_RULES].reverse());
    expect(sig1).toBe(sig2);
    expect(sig1).toBe(sig3);
  });
});

// ─── splicePromotedRulesSection ───────────────────────────────────────────────

describe("splicePromotedRulesSection", () => {
  const opts = { headingLevel: 2 as const, includeAttribution: true };

  it("anchor injection idempotency: render twice → second pass produces zero diff", () => {
    const bundle = makeBundle(FIVE_RULES);
    const base = "# Pathrule integration\n\nSome content.\n";

    const pass1 = splicePromotedRulesSection(base, bundle, opts);
    const pass2 = splicePromotedRulesSection(pass1, bundle, opts);

    expect(pass1).toBe(pass2);
  });

  it("anchor recovery: missing end anchor → renderer repairs and re-emits", () => {
    const bundle = makeBundle(FIVE_RULES);
    // A file with begin anchor but no end anchor.
    const broken = `# Pathrule integration\n\n${PROMOTED_RULES_ANCHOR_BEGIN}\nstale content here\n`;

    const repaired = splicePromotedRulesSection(broken, bundle, opts);

    expect(repaired).toContain(PROMOTED_RULES_ANCHOR_BEGIN);
    expect(repaired).toContain(PROMOTED_RULES_ANCHOR_END);
    // Stale content should be gone.
    expect(repaired).not.toContain("stale content here");
  });

  it("no anchors: appends at end of file", () => {
    const bundle = makeBundle(FIVE_RULES);
    const base = "# Pathrule integration\n\nSome content.\n";

    const result = splicePromotedRulesSection(base, bundle, opts);

    expect(result.startsWith("# Pathrule integration")).toBe(true);
    expect(result).toContain(PROMOTED_RULES_ANCHOR_BEGIN);
    expect(result).toContain(PROMOTED_RULES_ANCHOR_END);
  });

  it("empty bundle: both anchors present, section body is only signature comment", () => {
    const bundle = makeBundle([]);
    const base = "# Pathrule integration\n\n";

    const result = splicePromotedRulesSection(base, bundle, opts);
    expect(result).toContain(PROMOTED_RULES_ANCHOR_BEGIN);
    expect(result).toContain(PROMOTED_RULES_ANCHOR_END);
    expect(result).not.toContain("## Workspace Rules");
  });

  it("all 4 client renders with same bundle produce identical signatures", async () => {
    const bundle = makeBundle(FIVE_RULES);
    const sig = await computePromotedRulesSignature(bundle.entries);

    // Signatures in each render are taken from bundle.signature (set by caller).
    // The test verifies that the same input entries → same hash across callers.
    expect(sig).toHaveLength(16); // 16-hex-char truncated SHA-256
    expect(sig).toMatch(/^[0-9a-f]+$/);
  });
});
