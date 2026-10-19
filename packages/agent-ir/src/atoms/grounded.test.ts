// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { captureGroundedAtom, MAX_SPAN_CHARS, type CaptureSource } from "./grounded-capture.js";
import { groundingHolds, spansGroundedIn, deliveredSpans, activateGrounded } from "./grounded.js";
import { isRemedyDeliverable, approveRemedy, rejectRemedy } from "./remedy.js";
import { isSelectionDeliverable } from "./selection.js";
import { isContextDeliverable } from "./context.js";
import { isProcedureDeliverable } from "./procedure.js";
import { isRationaleDeliverable } from "./rationale.js";
import { stampProposedRemedy } from "./remedy-fingerprint.js";

const NOW = "2026-10-15T00:00:00.000Z";
const source = (content: string): CaptureSource => ({ kind: "memory", id: "m1", title: "t", content });

describe("captureGroundedAtom", () => {
  const body = "When `pnpm test` fails with ERR_DLOPEN_FAILED, run `pnpm natives:node` and retry. We use `formatMoney` instead of `Intl.NumberFormat` because rounding must match invoices. Release: first run `pnpm gate`, then `pnpm stage`, finally `pnpm publish:rc`. Reports are named in UTC.";

  it("activates a remedy whose spans are verbatim, and it is deliverable", () => {
    const r = captureGroundedAtom({ kind: "remedy", condition: ["`pnpm test` fails with ERR_DLOPEN_FAILED"], action: ["run `pnpm natives:node`"] }, source(body), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok || r.atom.kind !== "remedy") return;
    expect(r.atom.authority).toBe("grounded");
    expect(r.atom.status).toBe("active");
    expect(r.atom.approved_by).toBeNull();
    expect(isRemedyDeliverable(r.atom)).toBe(true);
  });

  it("captures every advisory kind as deliverable", () => {
    const s = captureGroundedAtom({ kind: "selection", prefer: ["`formatMoney`"], over: ["`Intl.NumberFormat`"] }, source(body), NOW);
    const p = captureGroundedAtom({ kind: "procedure", operation: ["Release"], steps: ["`pnpm gate`", "`pnpm stage`", "`pnpm publish:rc`"] }, source(body), NOW);
    const c = captureGroundedAtom({ kind: "context", fact: ["Reports are named in UTC."] }, source(body), NOW);
    const ra = captureGroundedAtom({ kind: "rationale", subject: ["We use `formatMoney`"], reason: ["rounding must match invoices"] }, source(body), NOW);
    expect(s.ok && s.atom.kind === "selection" && isSelectionDeliverable(s.atom)).toBe(true);
    expect(p.ok && p.atom.kind === "procedure" && isProcedureDeliverable(p.atom)).toBe(true);
    expect(c.ok && c.atom.kind === "context" && isContextDeliverable(c.atom)).toBe(true);
    expect(ra.ok && ra.atom.kind === "rationale" && isRationaleDeliverable(ra.atom)).toBe(true);
  });

  it("refuses a span the memory does not say, a paraphrase included", () => {
    const r = captureGroundedAtom({ kind: "remedy", condition: ["tests fail"], action: ["rebuild the native module"] }, source(body), NOW);
    expect(r).toMatchObject({ ok: false, code: "capture_span_not_in_source" });
  });

  it("refuses missing parts, overlap, long spans, too few or reordered steps and unknown kinds", () => {
    expect(captureGroundedAtom({ kind: "remedy", condition: ["Reports"], action: [] }, source(body), NOW)).toMatchObject({ code: "capture_missing_part" });
    expect(captureGroundedAtom({ kind: "selection", prefer: ["`formatMoney`"], over: ["`formatMoney`"] }, source(body), NOW)).toMatchObject({ code: "capture_parts_overlap" });
    const long = "x".repeat(MAX_SPAN_CHARS + 1);
    expect(captureGroundedAtom({ kind: "context", fact: [long] }, source(long), NOW)).toMatchObject({ code: "capture_span_too_long" });
    expect(captureGroundedAtom({ kind: "procedure", operation: ["Release"], steps: ["`pnpm gate`"] }, source(body), NOW)).toMatchObject({ code: "capture_too_few_steps" });
    expect(captureGroundedAtom({ kind: "procedure", operation: ["Release"], steps: ["`pnpm stage`", "`pnpm gate`"] }, source(body), NOW)).toMatchObject({ code: "capture_steps_out_of_order" });
    expect(captureGroundedAtom({ kind: "constraint" } as never, source(body), NOW)).toMatchObject({ code: "capture_unknown_kind" });
  });

  it("reads every language the same way: only containment is judged", () => {
    const tr = "Rapor dosyaları UTC ile adlandırılır. `kirpi-export` hata verirse `--utc` bayrağını ekle.";
    const r = captureGroundedAtom({ kind: "remedy", condition: ["`kirpi-export` hata verirse"], action: ["`--utc` bayrağını ekle"] }, source(tr), NOW);
    expect(r.ok).toBe(true);
    const ja = "テストが失敗したら `pnpm natives:node` を実行する。";
    expect(captureGroundedAtom({ kind: "remedy", condition: ["テストが失敗したら"], action: ["`pnpm natives:node` を実行する"] }, source(ja), NOW).ok).toBe(true);
  });
});

describe("the grounded delivery gate", () => {
  const body = "When the build fails with E42, run `pnpm clean`.";
  const captured = captureGroundedAtom({ kind: "remedy", condition: ["the build fails with E42"], action: ["run `pnpm clean`"] }, source(body), NOW);
  if (!captured.ok || captured.atom.kind !== "remedy") throw new Error("fixture");
  const atom = captured.atom;

  it("holds while the source still says it, and fails closed when it does not", () => {
    expect(groundingHolds(atom, body)).toBe(true);
    expect(groundingHolds(atom, "When the build fails with E42, run `pnpm reset`.")).toBe(false);
    expect(groundingHolds(atom, null)).toBe(false);
  });

  it("never applies to a human-approved atom", () => {
    expect(groundingHolds(approveRemedy(atom, "user-1"), "unrelated text")).toBe(true);
  });

  it("a paraphrase can never be grounded", () => {
    const paraphrased = activateGrounded(stampProposedRemedy(
      { variant: "trouble", condition_evidence: [], condition_normalized: "builds break", action_evidence: ["run `pnpm clean`"], evidence_state: "OBSERVED_SUCCESS", source: { kind: "memory", id: "m1", title: "t", node_path: null }, observed_at: NOW },
      { now: NOW },
    ));
    expect(deliveredSpans(paraphrased)).toBeNull();
    expect(spansGroundedIn(paraphrased, body)).toBe(false);
  });

  it("a rejection always wins over grounding", () => {
    expect(isRemedyDeliverable(rejectRemedy(atom, "user-1"))).toBe(false);
  });
});
