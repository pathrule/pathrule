// SPDX-License-Identifier: Apache-2.0
/**
 * The frozen attribution corpus and the hard safety metrics for V30.
 *
 *   FALSE_USAGE_ATTRIBUTION   = 0  (never ATTRIBUTED without forcing evidence)
 *   FALSE_SUCCESS_ATTRIBUTION = 0  (never SUCCEEDED without a narrow verifier)
 *
 * Precision over recall: a case that should be UNKNOWN/NOT_OBSERVED must not be attributed, even at
 * the cost of missing a real use. The corpus is deliberately broad (usage, ambiguity, outcome,
 * condition, error-signature families) and is hashed so a silent semantic drift breaks the build.
 */
import { describe, it, expect } from "vitest";
import {
  attributeUsage,
  classifyCommandOutcome,
  classifyCheckOutcome,
  classifyErrorPersistenceOutcome,
  observeCondition,
  errorSignature,
  type DeliveredAdvisory,
  type ObservedEvent,
  type UsageStatus,
  type UsageReason,
  type ConditionStatus,
} from "./outcome.js";

const adv = (
  atom_id: string,
  action_literals: string[],
  scope: string | null = null,
  condition_literals: string[] = [],
): DeliveredAdvisory => ({ atom_id, scope, action_literals, variant: "trouble", condition_literals });
const statusOf = (rs: ReturnType<typeof attributeUsage>, id: string): UsageStatus => rs.find((r) => r.atom_id === id)!.status;
const reasonOf = (rs: ReturnType<typeof attributeUsage>, id: string): UsageReason => rs.find((r) => r.atom_id === id)!.reason;

interface UsageCase {
  name: string;
  group: "positive" | "negative" | "ambiguous" | "unknown";
  delivered: DeliveredAdvisory[];
  event: ObservedEvent;
  expect: Record<string, UsageStatus>;
  reason?: Record<string, UsageReason>;
}

// ── USAGE ATTRIBUTION CORPUS ─────────────────────────────────────────────────────────────────────
const USAGE: UsageCase[] = [
  // strong positives (ATTRIBUTED) ────────────────────────────────────────────────────────────────
  { name: "literal inserted in an in-scope edit", group: "positive",
    delivered: [adv("a1", ["safeFoo()"], "/apps/web")],
    event: { kind: "edit", path: "/apps/web/button.tsx", before: "const x = foo();", after: "const x = safeFoo();" },
    expect: { a1: "ATTRIBUTED" }, reason: { a1: "literal_inserted" } },
  { name: "method-call literal inserted", group: "positive",
    delivered: [adv("a2", ["spawnManaged("], "/packages/app")],
    event: { kind: "edit", path: "/packages/app/x.ts", before: "spawn(cmd)", after: "spawnManaged(cmd)" },
    expect: { a2: "ATTRIBUTED" }, reason: { a2: "literal_inserted" } },
  { name: "config key/value inserted", group: "positive",
    delivered: [adv("a3", ['"strict": true'], "/packages/tsconfig")],
    event: { kind: "edit", path: "/packages/tsconfig/base.json", before: "{}", after: '{ "strict": true }' },
    expect: { a3: "ATTRIBUTED" } },
  { name: "import statement inserted (multi-word but code-shaped)", group: "positive",
    delivered: [adv("a4", ['import { z } from "./z"'], "/apps/web")],
    event: { kind: "edit", path: "/apps/web/a.ts", before: "// top", after: 'import { z } from "./z"\n// top' },
    expect: { a4: "ATTRIBUTED" } },
  { name: "root-scope advisory matches any path", group: "positive",
    delivered: [adv("a5", ["guardRail()"], "/")],
    event: { kind: "edit", path: "/anywhere/deep/file.ts", before: "raw()", after: "guardRail()" },
    expect: { a5: "ATTRIBUTED" } },
  { name: "null-scope advisory matches any path (global)", group: "positive",
    delivered: [adv("a6", ["withRetry("], null)],
    event: { kind: "edit", path: "/svc/a.ts", before: "call(", after: "withRetry(" },
    expect: { a6: "ATTRIBUTED" } },
  { name: "insertion detected in a large multi-line diff", group: "positive",
    delivered: [adv("a7", ["assertNever(x)"], "/apps/web")],
    event: { kind: "edit", path: "/apps/web/switch.ts", before: "case 'a': return 1;\ncase 'b': return 2;", after: "case 'a': return 1;\ncase 'b': return 2;\ndefault: assertNever(x)" },
    expect: { a7: "ATTRIBUTED" } },
  { name: "command fingerprint matches an executed command (exit 0)", group: "positive",
    delivered: [adv("a8", ["pnpm test"])],
    event: { kind: "command", command: "pnpm test", exit_code: 0 },
    expect: { a8: "ATTRIBUTED" }, reason: { a8: "command_fingerprint_match" } },
  { name: "command normalization: `pnpm run build` matches remedy `pnpm build`", group: "positive",
    delivered: [adv("a9", ["pnpm build"])],
    event: { kind: "command", command: "pnpm run build", exit_code: 0 },
    expect: { a9: "ATTRIBUTED" } },
  { name: "command normalization: env prefix is stripped", group: "positive",
    delivered: [adv("a10", ["pnpm test"])],
    event: { kind: "command", command: "NODE_ENV=test pnpm test", exit_code: 0 },
    expect: { a10: "ATTRIBUTED" } },
  { name: "command normalization: sudo wrapper is peeled", group: "positive",
    delivered: [adv("a11", ["pnpm test"])],
    event: { kind: "command", command: "sudo pnpm test", exit_code: 1 },
    expect: { a11: "ATTRIBUTED" } },
  { name: "command still attributed on non-zero exit (usage != success)", group: "positive",
    delivered: [adv("a12", ["pnpm test"])],
    event: { kind: "command", command: "pnpm test", exit_code: 1 },
    expect: { a12: "ATTRIBUTED" } },

  // strong negatives (NOT_OBSERVED / POSSIBLE) ────────────────────────────────────────────────────
  { name: "unrelated edit, literal absent", group: "negative",
    delivered: [adv("b1", ["safeFoo()"], "/apps/web")],
    event: { kind: "edit", path: "/apps/web/button.tsx", before: "const x = 1;", after: "const x = 2;" },
    expect: { b1: "NOT_OBSERVED" }, reason: { b1: "no_literal_match" } },
  { name: "sibling path edit is never evidence even if the literal matches", group: "negative",
    delivered: [adv("b2", ["safeFoo()"], "/apps/web")],
    event: { kind: "edit", path: "/apps/api/server.ts", before: "x", after: "safeFoo()" },
    expect: { b2: "NOT_OBSERVED" }, reason: { b2: "out_of_scope" } },
  { name: "deeper sibling under a different top segment is out of scope", group: "negative",
    delivered: [adv("b3", ["safeFoo()"], "/apps/web/components")],
    event: { kind: "edit", path: "/apps/web/pages/index.tsx", before: "x", after: "safeFoo()" },
    expect: { b3: "NOT_OBSERVED" }, reason: { b3: "out_of_scope" } },
  { name: "similar but different command does not match (fingerprint differs)", group: "negative",
    delivered: [adv("b4", ["pnpm test"])],
    event: { kind: "command", command: "pnpm test:watch", exit_code: 0 },
    expect: { b4: "NOT_OBSERVED" }, reason: { b4: "command_no_fingerprint_match" } },
  { name: "scoped command run does not satisfy an unscoped remedy command", group: "negative",
    delivered: [adv("b5", ["pnpm test"])],
    event: { kind: "command", command: "pnpm --filter @pathrule/web test", exit_code: 0 },
    expect: { b5: "NOT_OBSERVED" }, reason: { b5: "command_no_fingerprint_match" } },
  { name: "cwd difference changes the fingerprint (no match)", group: "negative",
    delivered: [adv("b6", ["pnpm test"])],
    event: { kind: "command", command: "cd packages/web && pnpm test", exit_code: 0 },
    expect: { b6: "NOT_OBSERVED" }, reason: { b6: "command_no_fingerprint_match" } },
  { name: "piped command is unfingerprintable, fail closed", group: "negative",
    delivered: [adv("b7", ["pnpm test"])],
    event: { kind: "command", command: "pnpm test 2>&1 | tail -5", exit_code: 0 },
    expect: { b7: "NOT_OBSERVED" }, reason: { b7: "command_unfingerprintable" } },
  { name: "chained two-verification command is unfingerprintable, fail closed", group: "negative",
    delivered: [adv("b8", ["pnpm test"])],
    event: { kind: "command", command: "pnpm lint && pnpm test", exit_code: 0 },
    expect: { b8: "NOT_OBSERVED" }, reason: { b8: "command_unfingerprintable" } },
  { name: "literal already present before the edit is POSSIBLE, never ATTRIBUTED", group: "negative",
    delivered: [adv("b9", ["safeFoo()"], "/apps/web")],
    event: { kind: "edit", path: "/apps/web/x.ts", before: "safeFoo(); // old", after: "safeFoo(); // touched a comment" },
    expect: { b9: "POSSIBLE" }, reason: { b9: "literal_present_not_inserted" } },
  { name: "a write shows only final content, so a present literal is POSSIBLE", group: "negative",
    delivered: [adv("b10", ["safeFoo()"], "/apps/web")],
    event: { kind: "write", path: "/apps/web/x.ts", after: "export const y = safeFoo();" },
    expect: { b10: "POSSIBLE" }, reason: { b10: "literal_present_not_inserted" } },
  { name: "too-short literal is coincidence, not evidence", group: "negative",
    delivered: [adv("b11", ["x)"], "/apps/web")],
    event: { kind: "edit", path: "/apps/web/x.ts", before: "a", after: "x)" },
    expect: { b11: "NOT_OBSERVED" }, reason: { b11: "literal_too_short" } },
  { name: "literal removed (in before, not after) is not usage", group: "negative",
    delivered: [adv("b12", ["legacyCall()"], "/apps/web")],
    event: { kind: "edit", path: "/apps/web/x.ts", before: "legacyCall()", after: "newCall()" },
    expect: { b12: "NOT_OBSERVED" }, reason: { b12: "no_literal_match" } },
  { name: "literal in a comment that already existed is POSSIBLE not ATTRIBUTED", group: "negative",
    delivered: [adv("b13", ["useMemoDeep()"], "/apps/web")],
    event: { kind: "edit", path: "/apps/web/x.ts", before: "// call useMemoDeep() here\nfoo()", after: "// call useMemoDeep() here\nbar()" },
    expect: { b13: "POSSIBLE" } },
  { name: "unfingerprintable executed command with no exit still not attributed", group: "negative",
    delivered: [adv("b14", ["pnpm test"])],
    event: { kind: "command", command: "echo hi | pnpm test", exit_code: null },
    expect: { b14: "NOT_OBSERVED" }, reason: { b14: "command_unfingerprintable" } },
  { name: "edit in scope but no literal present at all", group: "negative",
    delivered: [adv("b15", ["wrapWithBoundary("], "/apps/web")],
    event: { kind: "edit", path: "/apps/web/x.ts", before: "a()", after: "b()" },
    expect: { b15: "NOT_OBSERVED" }, reason: { b15: "no_literal_match" } },

  // ambiguous ──────────────────────────────────────────────────────────────────────────────────
  { name: "two delivered remedies both inserted by one edit -> both AMBIGUOUS", group: "ambiguous",
    delivered: [adv("c1", ["safeFoo()"], "/apps/web"), adv("c2", ["guard()"], "/apps/web")],
    event: { kind: "edit", path: "/apps/web/x.ts", before: "raw", after: "safeFoo(); guard();" },
    expect: { c1: "AMBIGUOUS", c2: "AMBIGUOUS" }, reason: { c1: "multiple_strong_matches", c2: "multiple_strong_matches" } },
  { name: "two remedies with the same command -> both AMBIGUOUS", group: "ambiguous",
    delivered: [adv("c3", ["pnpm test"]), adv("c4", ["pnpm test"])],
    event: { kind: "command", command: "pnpm test", exit_code: 0 },
    expect: { c3: "AMBIGUOUS", c4: "AMBIGUOUS" } },
  { name: "duplicate/near-duplicate remedies (run vs bare) both match one command -> AMBIGUOUS", group: "ambiguous",
    delivered: [adv("c5", ["pnpm build"]), adv("c6", ["pnpm run build"])],
    event: { kind: "command", command: "pnpm build", exit_code: 0 },
    expect: { c5: "AMBIGUOUS", c6: "AMBIGUOUS" } },
  { name: "genuinely overlapping literals both inserted -> AMBIGUOUS, none chosen", group: "ambiguous",
    delivered: [adv("c7", ["Config()"], "/apps/web"), adv("c8", ["parseConfig()"], "/apps/web")],
    event: { kind: "edit", path: "/apps/web/x.ts", before: "load()", after: "parseConfig()" },
    expect: { c7: "AMBIGUOUS", c8: "AMBIGUOUS" } },
  { name: "near-miss literal is not a substring, so the specific literal wins with no false ambiguity", group: "positive",
    delivered: [adv("c16", ["parseConfig("], "/apps/web"), adv("c17", ["parseConfigStrict("], "/apps/web")],
    event: { kind: "edit", path: "/apps/web/x.ts", before: "load()", after: "parseConfigStrict()" },
    expect: { c16: "NOT_OBSERVED", c17: "ATTRIBUTED" } },
  { name: "three remedies, only one inserted -> that one ATTRIBUTED, others NOT_OBSERVED", group: "positive",
    delivered: [adv("c9", ["onlyThis()"], "/apps/web"), adv("c10", ["notThis()"], "/apps/web"), adv("c11", ["norThat()"], "/apps/web")],
    event: { kind: "edit", path: "/apps/web/x.ts", before: "raw", after: "onlyThis()" },
    expect: { c9: "ATTRIBUTED", c10: "NOT_OBSERVED", c11: "NOT_OBSERVED" } },
  { name: "one inserted + one merely present -> inserted ATTRIBUTED (single strong), other POSSIBLE", group: "positive",
    delivered: [adv("c12", ["freshCall()"], "/apps/web"), adv("c13", ["oldCall()"], "/apps/web")],
    event: { kind: "edit", path: "/apps/web/x.ts", before: "oldCall()", after: "oldCall(); freshCall()" },
    expect: { c12: "ATTRIBUTED", c13: "POSSIBLE" } },
  { name: "one in-scope inserted, one out-of-scope same literal -> only in-scope ATTRIBUTED", group: "positive",
    delivered: [adv("c14", ["shared()"], "/apps/web"), adv("c15", ["shared()"], "/apps/api")],
    event: { kind: "edit", path: "/apps/web/x.ts", before: "raw", after: "shared()" },
    expect: { c14: "ATTRIBUTED", c15: "NOT_OBSERVED" } },

  // unknown / unobservable ─────────────────────────────────────────────────────────────────────
  { name: "procedural prose advisory stays unobservable, never text-matched", group: "unknown",
    delivered: [adv("d1", ["review the design before building"], "/apps/web")],
    event: { kind: "edit", path: "/apps/web/x.ts", before: "a", after: "review the design before building the feature" },
    expect: { d1: "NOT_OBSERVED" }, reason: { d1: "prose_unobservable" } },
  { name: "multi-word prose without code punctuation is prose", group: "unknown",
    delivered: [adv("d2", ["prefer the smaller batch size"], "/apps/web")],
    event: { kind: "edit", path: "/apps/web/x.ts", before: "a", after: "prefer the smaller batch size everywhere" },
    expect: { d2: "NOT_OBSERVED" }, reason: { d2: "prose_unobservable" } },
  { name: "prose advisory against a command event is not observed", group: "unknown",
    delivered: [adv("d3", ["always double check the migration"])],
    event: { kind: "command", command: "pnpm test", exit_code: 0 },
    expect: { d3: "NOT_OBSERVED" }, reason: { d3: "command_no_fingerprint_match" } },

  // command runner family: equivalence and discrimination ─────────────────────────────────────────
  { name: "cross-manager: npm test does not satisfy a pnpm remedy", group: "negative",
    delivered: [adv("e1", ["pnpm test"])],
    event: { kind: "command", command: "npm test", exit_code: 0 },
    expect: { e1: "NOT_OBSERVED" }, reason: { e1: "command_no_fingerprint_match" } },
  { name: "vitest run via pnpm equals bare vitest run", group: "positive",
    delivered: [adv("e2", ["vitest run"])],
    event: { kind: "command", command: "pnpm vitest run", exit_code: 0 },
    expect: { e2: "ATTRIBUTED" } },
  { name: "bare vitest (watch by default) is unfingerprintable, fail closed", group: "negative",
    delivered: [adv("e3", ["vitest run"])],
    event: { kind: "command", command: "vitest", exit_code: 0 },
    expect: { e3: "NOT_OBSERVED" }, reason: { e3: "command_unfingerprintable" } },
  { name: "a narrowed run does not satisfy a suite-level remedy", group: "negative",
    delivered: [adv("e4", ["vitest run"])],
    event: { kind: "command", command: "vitest run src/x.test.ts", exit_code: 0 },
    expect: { e4: "NOT_OBSERVED" }, reason: { e4: "command_no_fingerprint_match" } },
  { name: "pytest remedy matches pytest run", group: "positive",
    delivered: [adv("e5", ["pytest"])],
    event: { kind: "command", command: "pytest", exit_code: 0 },
    expect: { e5: "ATTRIBUTED" } },
  { name: "jest remedy matches jest run", group: "positive",
    delivered: [adv("e6", ["jest"])],
    event: { kind: "command", command: "jest", exit_code: 0 },
    expect: { e6: "ATTRIBUTED" } },
  { name: "node wrapper handing off to vitest run matches", group: "positive",
    delivered: [adv("e7", ["node scripts/with-sqlite-native.mjs vitest run"])],
    event: { kind: "command", command: "node scripts/with-sqlite-native.mjs vitest run", exit_code: 0 },
    expect: { e7: "ATTRIBUTED" } },
  { name: "scoped filter remedy matches the same scoped run", group: "positive",
    delivered: [adv("e8", ["pnpm --filter @pathrule/web test"])],
    event: { kind: "command", command: "pnpm --filter @pathrule/web test", exit_code: 0 },
    expect: { e8: "ATTRIBUTED" } },

  // multi-literal advisories (any usable literal may match) ────────────────────────────────────────
  { name: "multi-literal advisory, the second literal is inserted", group: "positive",
    delivered: [adv("f1", ["safeFoo()", "guardRail()"], "/apps/web")],
    event: { kind: "edit", path: "/apps/web/x.ts", before: "raw", after: "guardRail()" },
    expect: { f1: "ATTRIBUTED" } },
  { name: "empty/whitespace literals are filtered out, the real one matches", group: "positive",
    delivered: [adv("f2", ["", "  ", "realCall("], "/apps/web")],
    event: { kind: "edit", path: "/apps/web/x.ts", before: "raw", after: "realCall(" },
    expect: { f2: "ATTRIBUTED" } },
  { name: "a too-short literal is ignored while a longer one in the same advisory matches", group: "positive",
    delivered: [adv("f3", ["a()", "specificHelper("], "/apps/web")],
    event: { kind: "edit", path: "/apps/web/x.ts", before: "raw", after: "specificHelper(" },
    expect: { f3: "ATTRIBUTED" } },

  // literal edge cases (matching is substring, never regex) ────────────────────────────────────────
  { name: "regex-special characters are matched literally, not as a pattern", group: "positive",
    delivered: [adv("g1", ["arr.map(x => x?.y)"], "/apps/web")],
    event: { kind: "edit", path: "/apps/web/x.ts", before: "arr", after: "arr.map(x => x?.y)" },
    expect: { g1: "ATTRIBUTED" } },
  { name: "literal present in both before and after is POSSIBLE, not inserted", group: "negative",
    delivered: [adv("g2", ["helperX()"], "/apps/web")],
    event: { kind: "edit", path: "/apps/web/x.ts", before: "helperX(); a()", after: "helperX(); b()" },
    expect: { g2: "POSSIBLE" } },
  { name: "no-op edit (before === after) with a present literal stays POSSIBLE", group: "negative",
    delivered: [adv("g3", ["dupCall()"], "/apps/web")],
    event: { kind: "edit", path: "/apps/web/x.ts", before: "dupCall()", after: "dupCall()" },
    expect: { g3: "POSSIBLE" } },
  { name: "write with the literal absent is not observed", group: "negative",
    delivered: [adv("g4", ["missingCall("], "/apps/web")],
    event: { kind: "write", path: "/apps/web/x.ts", after: "export const y = 1;" },
    expect: { g4: "NOT_OBSERVED" }, reason: { g4: "no_literal_match" } },
  { name: "unicode literal inserted is matched", group: "positive",
    delivered: [adv("g5", ['const smiley = "\u{1F600}"'], "/apps/web")],
    event: { kind: "edit", path: "/apps/web/x.ts", before: "// e", after: 'const smiley = "\u{1F600}"' },
    expect: { g5: "ATTRIBUTED" } },
  { name: "literal exactly at the minimum length boundary is matched", group: "positive",
    delivered: [adv("g6", ["a();"], "/apps/web")],
    event: { kind: "edit", path: "/apps/web/x.ts", before: "b", after: "a();" },
    expect: { g6: "ATTRIBUTED" } },
  { name: "literal one char below the boundary is coincidence", group: "negative",
    delivered: [adv("g7", ["a()"], "/apps/web")],
    event: { kind: "edit", path: "/apps/web/x.ts", before: "b", after: "a()" },
    expect: { g7: "NOT_OBSERVED" }, reason: { g7: "literal_too_short" } },

  // scope edge cases (segment-aware ancestor semantics) ───────────────────────────────────────────
  { name: "a file-level scope matches an edit to that exact file", group: "positive",
    delivered: [adv("h1", ["patchIt()"], "/apps/web/x.ts")],
    event: { kind: "edit", path: "/apps/web/x.ts", before: "raw", after: "patchIt()" },
    expect: { h1: "ATTRIBUTED" } },
  { name: "a broad ancestor scope matches a deep descendant edit", group: "positive",
    delivered: [adv("h2", ["patchIt()"], "/apps")],
    event: { kind: "edit", path: "/apps/web/deep/x.ts", before: "raw", after: "patchIt()" },
    expect: { h2: "ATTRIBUTED" } },
  { name: "sibling with a shared string prefix is NOT in scope (web vs website)", group: "negative",
    delivered: [adv("h3", ["patchIt()"], "/apps/web")],
    event: { kind: "edit", path: "/apps/website/x.ts", before: "raw", after: "patchIt()" },
    expect: { h3: "NOT_OBSERVED" }, reason: { h3: "out_of_scope" } },
  { name: "an edit to an ancestor of the scope is NOT a descendant, so out of scope", group: "negative",
    delivered: [adv("h4", ["patchIt()"], "/apps/web/components")],
    event: { kind: "edit", path: "/apps/web/x.ts", before: "raw", after: "patchIt()" },
    expect: { h4: "NOT_OBSERVED" }, reason: { h4: "out_of_scope" } },
];

describe("attribution corpus: usage", () => {
  for (const c of USAGE) {
    it(`${c.group}: ${c.name}`, () => {
      const rs = attributeUsage(c.delivered, c.event);
      for (const [id, want] of Object.entries(c.expect)) expect(statusOf(rs, id), `${id} status`).toBe(want);
      if (c.reason) for (const [id, want] of Object.entries(c.reason)) expect(reasonOf(rs, id), `${id} reason`).toBe(want);
    });
  }
});

// ── SAFETY + QUALITY METRICS ─────────────────────────────────────────────────────────────────────
describe("attribution safety and quality metrics", () => {
  const flat = USAGE.flatMap((c) => attributeUsage(c.delivered, c.event).map((r) => ({ r, gold: c.expect[r.atom_id]! })));

  it("FALSE_USAGE_ATTRIBUTION = 0", () => {
    const falseAttrib = flat.filter(({ r, gold }) => r.status === "ATTRIBUTED" && gold !== "ATTRIBUTED").length;
    expect(falseAttrib).toBe(0);
  });

  it("no ATTRIBUTED where gold is a non-usage class, and no AMBIGUOUS where gold is single", () => {
    const falseAmbig = flat.filter(({ r, gold }) => r.status === "AMBIGUOUS" && gold !== "AMBIGUOUS").length;
    expect(falseAmbig).toBe(0);
  });

  it("usage precision = 1.0 (every ATTRIBUTED is a gold ATTRIBUTED)", () => {
    const attributed = flat.filter(({ r }) => r.status === "ATTRIBUTED");
    const correct = attributed.filter(({ gold }) => gold === "ATTRIBUTED").length;
    expect(correct).toBe(attributed.length);
    expect(attributed.length).toBeGreaterThan(0);
  });

  it("usage recall on gold-ATTRIBUTED is total (precision here is not bought by dropping recall)", () => {
    const goldAttr = flat.filter(({ gold }) => gold === "ATTRIBUTED");
    const found = goldAttr.filter(({ r }) => r.status === "ATTRIBUTED").length;
    expect(found).toBe(goldAttr.length);
  });

  it("reports coverage numbers for the record", () => {
    const total = flat.length;
    const attributed = flat.filter(({ r }) => r.status === "ATTRIBUTED").length;
    const ambiguous = flat.filter(({ r }) => r.status === "AMBIGUOUS").length;
    const possible = flat.filter(({ r }) => r.status === "POSSIBLE").length;
    const notObserved = flat.filter(({ r }) => r.status === "NOT_OBSERVED").length;
    // Not assertions of a target, just a guard that the corpus stays broad and multi-class.
    expect(total).toBeGreaterThanOrEqual(45);
    expect(attributed).toBeGreaterThan(0);
    expect(ambiguous).toBeGreaterThan(0);
    expect(possible).toBeGreaterThan(0);
    expect(notObserved).toBeGreaterThan(0);
  });
});

// ── OUTCOME (narrow and conservative) ─────────────────────────────────────────────────────────────
describe("outcome", () => {
  const cmd = (id: string, exit: number) => attributeUsage([adv(id, ["pnpm test"])], { kind: "command", command: "pnpm test", exit_code: exit })[0]!;
  const codeEdit = (id: string) => attributeUsage([adv(id, ["safeFoo()"], "/apps/web")], { kind: "edit", path: "/apps/web/x.ts", before: "foo()", after: "safeFoo()" })[0]!;

  it("command exit 0 -> MODERATE success; non-zero -> MODERATE failure", () => {
    expect(classifyCommandOutcome(cmd("o1", 0), 0)).toMatchObject({ status: "SUCCEEDED", strength: "MODERATE", evidence_kind: "exit_zero" });
    expect(classifyCommandOutcome(cmd("o2", 1), 1)).toMatchObject({ status: "FAILED", strength: "MODERATE", evidence_kind: "exit_nonzero" });
  });
  it("a code edit has NO command outcome: UNKNOWN", () => {
    expect(classifyCommandOutcome(codeEdit("o3"), 0).status).toBe("UNKNOWN");
  });
  it("CHECK fail->pass after an attributed edit is STRONG success; still-failing STRONG failure; no transition UNKNOWN", () => {
    expect(classifyCheckOutcome(codeEdit("o4"), { was_failing: true, now_passing: true })).toMatchObject({ status: "SUCCEEDED", strength: "STRONG" });
    expect(classifyCheckOutcome(codeEdit("o5"), { was_failing: true, now_passing: false }).status).toBe("FAILED");
    expect(classifyCheckOutcome(codeEdit("o6"), null).status).toBe("UNKNOWN");
  });
  it("CHECK pass->pass is NOT success (was not failing): UNKNOWN", () => {
    expect(classifyCheckOutcome(codeEdit("o7"), { was_failing: false, now_passing: true }).status).toBe("UNKNOWN");
  });
  it("error persistence: same signature later -> STRONG failure; changed/absent -> UNKNOWN", () => {
    const a = codeEdit("o8");
    const sig = errorSignature("Error: Cannot find name 'foo'");
    expect(classifyErrorPersistenceOutcome(a, sig, "Error: Cannot find name 'foo'")).toMatchObject({ status: "FAILED", strength: "STRONG", evidence_kind: "error_persisted" });
    expect(classifyErrorPersistenceOutcome(a, sig, "All good, 12 passed").status).toBe("UNKNOWN");
    expect(classifyErrorPersistenceOutcome(a, sig, "TypeError: undefined is not a function").status).toBe("UNKNOWN");
  });

  it("FALSE_SUCCESS_ATTRIBUTION = 0: a non-ATTRIBUTED usage can never be SUCCEEDED", () => {
    const notObs = attributeUsage([adv("z1", ["safeFoo()"], "/apps/web")], { kind: "edit", path: "/apps/api/x.ts", before: "a", after: "safeFoo()" })[0]!;
    expect(notObs.status).toBe("NOT_OBSERVED");
    expect(classifyCommandOutcome(notObs, 0).status).toBe("UNKNOWN");
    expect(classifyCheckOutcome(notObs, { was_failing: true, now_passing: true }).status).toBe("UNKNOWN");
    const possible = attributeUsage([adv("z2", ["safeFoo()"], "/apps/web")], { kind: "write", path: "/apps/web/x.ts", after: "safeFoo()" })[0]!;
    expect(possible.status).toBe("POSSIBLE");
    expect(classifyCommandOutcome(possible, 0).status).toBe("UNKNOWN");
    expect(classifyCheckOutcome(possible, { was_failing: true, now_passing: true }).status).toBe("UNKNOWN");
    expect(classifyErrorPersistenceOutcome(possible, "x", "x").status).toBe("UNKNOWN");
  });
  it("an AMBIGUOUS usage can never be SUCCEEDED", () => {
    const rs = attributeUsage([adv("z3", ["pnpm test"]), adv("z4", ["pnpm test"])], { kind: "command", command: "pnpm test", exit_code: 0 });
    for (const r of rs) expect(classifyCommandOutcome(r, 0).status).toBe("UNKNOWN");
  });
});

// ── CONDITION OBSERVATION ────────────────────────────────────────────────────────────────────────
interface ConditionCase { name: string; adv: DeliveredAdvisory; event: ObservedEvent; want: ConditionStatus }
const CONDITIONS: ConditionCase[] = [
  { name: "condition command FAILS (fingerprint match) -> OBSERVED",
    adv: adv("k1", ["pnpm build"], "/apps/web", ["pnpm test"]),
    event: { kind: "command", command: "pnpm test", exit_code: 1 }, want: "OBSERVED" },
  { name: "condition command PASSES -> NOT_OBSERVED (the condition did not occur)",
    adv: adv("k2", ["pnpm build"], "/apps/web", ["pnpm test"]),
    event: { kind: "command", command: "pnpm test", exit_code: 0 }, want: "NOT_OBSERVED" },
  { name: "different command failing is not this condition",
    adv: adv("k3", ["pnpm build"], "/apps/web", ["pnpm test"]),
    event: { kind: "command", command: "pnpm lint", exit_code: 1 }, want: "NOT_OBSERVED" },
  { name: "error signature from condition text appears in output -> OBSERVED",
    adv: adv("k4", ["addTypes()"], "/apps/web", ["Cannot find name 'foo'"]),
    event: { kind: "command", command: "pnpm typecheck", exit_code: 1, output: "src/x.ts:3:1 - Error: Cannot find name 'foo'" }, want: "OBSERVED" },
  { name: "prose-only condition is UNOBSERVABLE",
    adv: adv("k5", ["addTypes()"], "/apps/web", ["when the build feels slow"]),
    event: { kind: "command", command: "pnpm test", exit_code: 1 }, want: "UNOBSERVABLE" },
  { name: "no condition literals at all is UNOBSERVABLE",
    adv: adv("k6", ["addTypes()"], "/apps/web", []),
    event: { kind: "command", command: "pnpm test", exit_code: 1 }, want: "UNOBSERVABLE" },
  { name: "condition not evaluated on edit events (no command signal) -> NOT_OBSERVED",
    adv: adv("k7", ["addTypes()"], "/apps/web", ["pnpm test"]),
    event: { kind: "edit", path: "/apps/web/x.ts", before: "a", after: "b" }, want: "NOT_OBSERVED" },
];

describe("condition observation", () => {
  for (const c of CONDITIONS) {
    it(c.name, () => {
      expect(observeCondition(c.adv, c.event).status).toBe(c.want);
    });
  }
  it("condition-not-observed is never coerced into failure (it is just absence)", () => {
    // Lack of a condition means the remedy may never have been needed; nothing here yields FAILED.
    const a = adv("k8", ["addTypes()"], "/apps/web", ["pnpm test"]);
    const obs = observeCondition(a, { kind: "command", command: "pnpm test", exit_code: 0 });
    expect(obs.status).toBe("NOT_OBSERVED");
    expect(obs.evidence_kind).toBeNull();
  });
});

// ── ERROR SIGNATURE (deterministic, stable) ───────────────────────────────────────────────────────
describe("error signature", () => {
  it("same error at different paths and positions hashes identically", () => {
    const a = errorSignature("/a/b/foo.ts:12:5 - Error: Cannot find name 'x'");
    const b = errorSignature("/z/y/bar.ts:99:1 - Error: Cannot find name 'x'");
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });
  it("genuinely different errors do not collide", () => {
    const a = errorSignature("Error: Cannot find module 'react'");
    const b = errorSignature("TypeError: undefined is not a function");
    expect(a).not.toBe(b);
  });
  it("hex pointers and numbers are neutralized", () => {
    const a = errorSignature("panic: runtime error at 0xdeadbeef offset 42");
    const b = errorSignature("panic: runtime error at 0xcafef00d offset 99");
    expect(a).toBe(b);
  });
  it("text with no error-shaped line yields null (noise is not a signature)", () => {
    expect(errorSignature("all tests passed in 1.2s")).toBeNull();
    expect(errorSignature("")).toBeNull();
    expect(errorSignature(null)).toBeNull();
    expect(errorSignature(undefined)).toBeNull();
  });
  it("is idempotent and pure", () => {
    const s = "src/x.ts:1:1 - Error: Type 'A' is not assignable to type 'B'";
    expect(errorSignature(s)).toBe(errorSignature(s));
  });
});

// ── FROZEN CORPUS HASH ─────────────────────────────────────────────────────────────────────────
// A stable FNV-1a over the corpus + its computed statuses. A silent change to either the cases or the
// engine's classification flips this, forcing a conscious re-freeze rather than an unnoticed drift.
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}
describe("frozen corpus hash", () => {
  it("matches the recorded hash (re-freeze consciously if this changes)", () => {
    const rows = USAGE.map((c) => {
      const rs = attributeUsage(c.delivered, c.event);
      return `${c.name}|${rs.map((r) => `${r.atom_id}=${r.status}:${r.reason}`).join(",")}`;
    });
    const condRows = CONDITIONS.map((c) => `${c.name}|${observeCondition(c.adv, c.event).status}`);
    const hash = fnv1a(JSON.stringify({ usage: rows, cond: condRows }));
    // Recorded once the corpus stabilized. A change to either the cases or the engine's
    // classification flips this, forcing a conscious re-freeze rather than an unnoticed drift.
    expect(hash).toBe("58e9b92e");
    // eslint-disable-next-line no-console
    console.log(`[V30 corpus] usage_cases=${USAGE.length} condition_cases=${CONDITIONS.length} hash=${hash}`);
  });
});
