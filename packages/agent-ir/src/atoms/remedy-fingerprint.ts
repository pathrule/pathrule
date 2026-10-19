// SPDX-License-Identifier: Apache-2.0
/**
 * The node-only slice of the RemedyAtom model: deterministic identity (SHA-256) and the
 * "stamp a proposed atom" step that assigns it. Split out of `remedy.ts` on purpose, so that
 * module stays browser-safe (types + constants + pure validators) and can be imported by the
 * renderer's atom-review presenter without dragging `node:crypto` into the browser bundle. The
 * fingerprint and stamping only ever run in the main process / pipelines, never in a renderer.
 */
import { createHash } from "node:crypto";
import type { RemedyAtom, RemedyInput, RemedyVariant } from "./remedy.js";

/**
 * Deterministic identity.
 *
 * Over the SOURCE plus the evidence, and deliberately not over the wording the extractor
 * composed: two runs that ground the same spans on the same memory are the same atom, which is
 * what makes ingestion idempotent and makes a rejection stick. Whitespace is collapsed so a
 * reflowed paragraph does not mint a second identity for the same quote.
 */
export function remedyFingerprint(input: {
  variant: RemedyVariant;
  condition_evidence: string[];
  action_evidence: string[];
  source: { kind: string; id: string };
}): string {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const parts = [
    input.source.kind,
    input.source.id,
    input.variant,
    [...input.condition_evidence].map(norm).sort().join(""),
    [...input.action_evidence].map(norm).sort().join(""),
  ];
  return createHash("sha256").update(parts.join("")).digest("hex");
}

export function stampProposedRemedy(value: RemedyInput, opts: { now: string }): RemedyAtom {
  const fingerprint = remedyFingerprint(value);
  return {
    id: fingerprint,
    kind: "remedy",
    variant: value.variant,
    condition_evidence: value.condition_evidence,
    condition_normalized: value.condition_evidence.length > 0 ? null : value.condition_normalized,
    action_evidence: value.action_evidence,
    evidence_state: value.evidence_state,
    source: value.source,
    observed_at: value.observed_at,
    authority: "inferred",
    status: "proposed",
    created_at: opts.now,
    approved_by: null,
    fingerprint,
  };
}
