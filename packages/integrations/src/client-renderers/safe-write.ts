// SPDX-License-Identifier: Apache-2.0
// Safe-write policy for Pathrule-managed files. Routes per-path between four
// regimes:
//
//   1. "overwrite":            Pathrule fully owns the filename; just write.
//                               Used for filenames Pathrule invented (e.g.
//                               .claude/rules/pathrule-protocol.md,
//                               .cursor/rules/pathrule-protocol.mdc).
//
//   2. "merge-region":         DEFAULT for user-canonical instruction files
//                               (AGENTS.md, CLAUDE.md, .cursorrules, ...).
//                               These filenames are dictated by the client, not
//                               chosen by us, and they usually already hold the
//                               user's own instructions. Pathrule owns an
//                               anchored REGION inside the file and never
//                               touches a byte outside it: the user's content
//                               keeps reaching the agent, nothing is moved
//                               aside, and the git diff stays small.
//
//   3. "merge":                Structured config (JSON / TOML). Pathrule owns
//                               specific entries inside the file but user
//                               content elsewhere must survive. The renderer's
//                               emitted body is the FRESH-WRITE body; the
//                               merger transforms it against the existing file.
//
// Node-only: uses fs/promises. Imported by disk-writer.ts.

import { basename } from "node:path";

import { mergeRegionInto, regionBounds } from "@pathrule/core/paths/region.js";

import {
  ensureClaudeSettingsHook,
  ensureCodexConfigToml,
  ensureCodexHooks,
  ensureCursorHooks,
} from "../pathrule-protocol.js";

export type SafeWritePolicy =
  | { kind: "overwrite" }
  | { kind: "merge-region" }
  | { kind: "merge"; merger: (existing: string | null) => { body: string; changed: boolean } };

// Ownership detection lives in ownership.ts (pure, barrel-exported) so the
// dedicated root-CLAUDE.md writer shares this exact decision.
export { isPathruleManaged } from "@pathrule/core/paths/ownership.js";

export const SAFE_WRITE_POLICIES: Record<string, SafeWritePolicy> = {
  // ─── Cursor ───────────────────────────────────────────────────────────
  ".cursor/rules/pathrule-protocol.mdc": { kind: "overwrite" },
  ".cursorrules": { kind: "merge-region" },
  ".cursor/hooks.json": { kind: "merge", merger: ensureCursorHooks },

  // ─── Claude (parity reference: most paths flow through their own
  // bespoke pipeline in project-claude-md.ts; entries here are for any
  // call site that goes through writeMultiClientFiles) ──────────────────
  ".claude/rules/pathrule-protocol.md": { kind: "overwrite" },
  ".claude/settings.json": { kind: "merge", merger: ensureClaudeSettingsHook },
  "CLAUDE.md": { kind: "merge-region" },

  // ─── Codex ─────────────────────────────────────────────────────────────
  // AGENTS.md is a cross-runtime standard (Codex, OpenCode, Antigravity, Grok,
  // Kimi, Gemini CLI all read it), so it very often already holds the user's
  // own instructions. Region, never takeover.
  "AGENTS.md": { kind: "merge-region" },
  ".codex/hooks.json": { kind: "merge", merger: ensureCodexHooks },
  ".codex/config.toml": { kind: "merge", merger: ensureCodexConfigToml },

  // ─── Copilot ──────────────────────────────────────────────────────────
  // The repository's own Copilot instructions: a region, never a takeover.
  ".github/copilot-instructions.md": { kind: "merge-region" },

  // ─── Windsurf ─────────────────────────────────────────────────────────
  ".windsurf/rules/pathrule-protocol.md": { kind: "overwrite" },
  ".windsurfrules": { kind: "merge-region" },
};

export interface PrepareResult {
  /** Final body to write. Null = nothing to do (already up-to-date or skipped). */
  finalBody: string | null;
  /** Path of the backup we wrote, if any. */
  backupPath: string | null;
}

/**
 * Decide what (if anything) to write for `relativePath` and back up the
 * user's existing content when needed. Caller is expected to pass the
 * renderer's desired body and the workspace root; the actual disk write
 * still happens in disk-writer.ts via atomicWrite.
 *
 * Returns `finalBody = null` only when the merger reports no change AND the
 * existing on-disk body matches. This lets the caller short-circuit to a
 * skip without redundant atomic-rename churn.
 */
/**
 * Policy for paths not in the exact-match table. Nested knowledge files reuse
 * user-canonical filenames (`packages/api/CLAUDE.md`, `lib/AGENTS.md`), and a
 * monorepo very often already has the team's own instructions at exactly those
 * paths, so they get the same region treatment as the root files. Everything
 * else is a filename Pathrule invented, which it owns outright.
 */
function fallbackPolicy(relativePath: string): SafeWritePolicy {
  const base = basename(relativePath);
  if (base === "AGENTS.md" || base === "CLAUDE.md") {
    return { kind: "merge-region" };
  }
  return { kind: "overwrite" };
}

export async function prepareSafeWrite(opts: {
  workspaceRoot: string;
  relativePath: string;
  renderedBody: string;
  existingBody: string | null;
}): Promise<PrepareResult> {
  const policy = SAFE_WRITE_POLICIES[opts.relativePath] ?? fallbackPolicy(opts.relativePath);

  switch (policy.kind) {
    case "overwrite": {
      if (opts.existingBody === opts.renderedBody) return { finalBody: null, backupPath: null };
      return { finalBody: opts.renderedBody, backupPath: null };
    }

    case "merge-region": {
      // A region whose bounds cannot be told (an anchor lost, two regions) is the person's file as far
      // as Pathrule can prove: it is not written, and the sync reports it.
      const bounds = opts.existingBody === null ? null : regionBounds(opts.existingBody);
      if (bounds?.kind === "ambiguous") throw new Error(`left as it is: ${bounds.reason}`);
      // The decision itself lives in @pathrule/core so the dedicated
      // root-CLAUDE.md writer and the CLI cannot drift from it.
      const merged = mergeRegionInto(opts.existingBody, opts.renderedBody);
      if (merged === opts.existingBody) return { finalBody: null, backupPath: null };
      return { finalBody: merged, backupPath: null };
    }

    case "merge": {
      const { body: merged, changed } = policy.merger(opts.existingBody);
      if (!changed && opts.existingBody === merged) {
        return { finalBody: null, backupPath: null };
      }
      return { finalBody: merged, backupPath: null };
    }
  }
}
