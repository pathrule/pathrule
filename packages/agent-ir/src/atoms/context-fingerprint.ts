// SPDX-License-Identifier: Apache-2.0
/**
 * The node-only slice of the ContextAtom model: deterministic identity (SHA-256) and the
 * "stamp a proposed atom" step that assigns it. Split out of `context.ts` for the same reason
 * `remedy-fingerprint.ts` was split out of `remedy.ts`: the renderer's context-review presenter
 * imports `isContextDeliverable` as a VALUE, so anything `context.ts` imports lands in the browser
 * bundle, and `node:crypto` cannot load there. The fingerprint and stamping only ever run in the
 * main process / pipelines, never in a renderer.
 */
import { createHash } from "node:crypto";

import type { ContextAtom, ContextInput } from "./context.js";

export function contextFingerprint(input: { fact_evidence: string[]; source: { kind: string; id: string } }): string {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const parts = [input.source.kind, input.source.id, [...input.fact_evidence].map(norm).sort().join("")];
  return createHash("sha256").update(parts.join(" ")).digest("hex");
}

export function stampProposedContext(value: ContextInput, opts: { now: string }): ContextAtom {
  const fingerprint = contextFingerprint(value);
  return {
    id: fingerprint, kind: "context",
    fact_evidence: value.fact_evidence,
    fact_normalized: value.fact_evidence.length > 0 ? null : value.fact_normalized,
    topic: value.topic, temporal_status: value.temporal_status,
    source: value.source, observed_at: value.observed_at,
    authority: "inferred", status: "proposed", created_at: opts.now, approved_by: null, fingerprint,
  };
}
