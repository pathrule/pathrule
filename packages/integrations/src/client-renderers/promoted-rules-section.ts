// SPDX-License-Identifier: Apache-2.0
// Shared promoted-rules section emitter.
//
// Every per-client renderer calls `renderPromotedRulesMarkdown` to produce the
// block that gets spliced into its instructions file between the stable anchors:
//
//   <!-- pathrule:promoted-rules:begin -->
//   ...rendered section...
//   <!-- pathrule:promoted-rules:end -->
//
// The orchestrator replaces content between the anchors on every re-render.
// If anchors are missing (older file, never rendered with promoted rules), the orchestrator
// appends them at the end of the file once and re-runs.
//
// The signature comment at the end of the section is the same sha256 hash
// returned by pathrule_get_context; agents can grep for it to verify freshness.

import type { PromotedRulesBundle } from "./types.js";

// Anchor constants — used by renderers and by the splice logic in orchestrator.
export const PROMOTED_RULES_ANCHOR_BEGIN = "<!-- pathrule:promoted-rules:begin -->";
export const PROMOTED_RULES_ANCHOR_END = "<!-- pathrule:promoted-rules:end -->";

export interface RenderPromotedRulesOptions {
  headingLevel: 2 | 3;
  includeAttribution: boolean;
}

/**
 * Produce the Markdown block for the promoted_rules section.
 *
 * Returns an empty string when the bundle has no entries (caller should still
 * keep the anchors so idempotency holds, but the section body is blank).
 */
export function renderPromotedRulesMarkdown(
  bundle: PromotedRulesBundle,
  opts: RenderPromotedRulesOptions,
): string {
  const hashes = "#".repeat(opts.headingLevel);

  if (bundle.entries.length === 0) {
    // Anchors present, section body empty — one comment line.
    return [
      PROMOTED_RULES_ANCHOR_BEGIN,
      `<!-- pathrule:promoted-rules-signature=${bundle.signature} -->`,
      PROMOTED_RULES_ANCHOR_END,
      "",
    ].join("\n");
  }

  const heading = `${hashes} Workspace Rules (Pathrule)`;
  const attribution = opts.includeAttribution
    ? "\n_These rules are managed by Pathrule. Source of truth: Pathrule cloud._\n"
    : "\n";

  const items = bundle.entries.map((entry, i) => {
    const tag = entry.priority === "critical" ? " (critical)" : "";
    return `${i + 1}. **${entry.name}**${tag} — ${entry.display_summary}`;
  });

  return [
    PROMOTED_RULES_ANCHOR_BEGIN,
    heading,
    attribution,
    items.join("\n"),
    "",
    `<!-- pathrule:promoted-rules-signature=${bundle.signature} -->`,
    PROMOTED_RULES_ANCHOR_END,
    "",
  ].join("\n");
}

/**
 * Splice the promoted-rules section into an existing file body.
 *
 * Strategy:
 *   1. If both anchors are present → replace content between them.
 *   2. If begin anchor present but end is missing → recover: insert end after begin line.
 *   3. If no anchors → append at end of file.
 *
 * The returned body always ends with exactly one trailing newline.
 */
export function splicePromotedRulesSection(
  fileBody: string,
  bundle: PromotedRulesBundle,
  opts: RenderPromotedRulesOptions,
): string {
  const section = renderPromotedRulesMarkdown(bundle, opts);

  const beginIdx = fileBody.indexOf(PROMOTED_RULES_ANCHOR_BEGIN);
  const endIdx = fileBody.indexOf(PROMOTED_RULES_ANCHOR_END);

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    // Case 1: both anchors present → replace between them (inclusive).
    const before = fileBody.slice(0, beginIdx);
    const after = fileBody.slice(endIdx + PROMOTED_RULES_ANCHOR_END.length);
    const combined = before + section + after;
    return normalizeTrailingNewline(combined);
  }

  if (beginIdx !== -1 && endIdx === -1) {
    // Case 2: begin anchor present but end missing → anchor recovery.
    // Replace from begin to end of file, re-inserting the full section.
    const before = fileBody.slice(0, beginIdx);
    const combined = before + section;
    return normalizeTrailingNewline(combined);
  }

  // Case 3: no anchors at all → append at end.
  const base = fileBody.endsWith("\n") ? fileBody : `${fileBody}\n`;
  return normalizeTrailingNewline(`${base}\n${section}`);
}

function normalizeTrailingNewline(s: string): string {
  return s.replace(/\n+$/, "") + "\n";
}

/**
 * Compute a deterministic sha256-based signature over the bundle entries.
 *
 * The signature is computed from a canonical JSON string: entries sorted by
 * rule_id (stable across calls), containing only rule_id + display_summary.
 * This ensures identical input → identical signature across all 4 clients.
 *
 * NOTE: Uses the Web Crypto API (available in both browser and Node 20+).
 */
export async function computePromotedRulesSignature(
  entries: PromotedRulesBundle["entries"],
): Promise<string> {
  const canonical = JSON.stringify(
    [...entries]
      .sort((a, b) => a.rule_id.localeCompare(b.rule_id))
      .map((e) => ({ rule_id: e.rule_id, display_summary: e.display_summary })),
  );

  // Web Crypto API — available in Node 20+ and all modern browsers.
  const data = new TextEncoder().encode(canonical);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}
