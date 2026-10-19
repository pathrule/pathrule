// SPDX-License-Identifier: Apache-2.0
/**
 * The node-only slice of the SelectionAtom model: deterministic identity (SHA-256) and the
 * "stamp a proposed atom" step that assigns it. Split out of `selection.ts` for the same reason
 * `remedy-fingerprint.ts` was split out of `remedy.ts`: the renderer's selection-review presenter
 * imports `DELIVERABLE_SELECTION_STRENGTHS` as a VALUE, so anything `selection.ts` imports lands in
 * the browser bundle. With `node:crypto` still in there, Vite externalized it and Studio died at
 * module evaluation with "Cannot access node:crypto.createHash in client code". The fingerprint and
 * stamping only ever run in the main process / pipelines, never in a renderer.
 */
import { createHash } from "node:crypto";

import type { SelectionAtom, SelectionInput } from "./selection.js";

/**
 * NUL separator, written as an escape on purpose: a raw NUL byte in the source makes the file
 * read as binary to `grep` and `file`, which is how this module hid from an audit. Same character,
 * so every fingerprint already stored stays valid.
 */
const SEPARATOR = "\u0000";

/**
 * Deterministic identity over source + preferred + alternative + context, not over the extractor's
 * paraphrase: two runs grounding the same spans on the same source are the same atom, so ingestion is
 * idempotent and a rejection sticks.
 */
export function selectionFingerprint(input: {
  context_evidence: string[];
  preferred_evidence: string[];
  alternative_evidence: string[];
  source: { kind: string; id: string };
}): string {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const parts = [
    input.source.kind,
    input.source.id,
    [...input.preferred_evidence].map(norm).sort().join(""),
    [...input.alternative_evidence].map(norm).sort().join(""),
    [...input.context_evidence].map(norm).sort().join(""),
  ];
  return createHash("sha256").update(parts.join(SEPARATOR)).digest("hex");
}

/** Stamp a validated input as a PROPOSAL. The only entry point from the write path. */
export function stampProposedSelection(value: SelectionInput, opts: { now: string }): SelectionAtom {
  const fingerprint = selectionFingerprint(value);
  return {
    id: fingerprint,
    kind: "selection",
    context_evidence: value.context_evidence,
    context_normalized: value.context_evidence.length > 0 ? null : value.context_normalized,
    preferred_evidence: value.preferred_evidence,
    alternative_evidence: value.alternative_evidence,
    strength: value.strength,
    source: value.source,
    observed_at: value.observed_at,
    authority: "inferred",
    status: "proposed",
    created_at: opts.now,
    approved_by: null,
    fingerprint,
  };
}
