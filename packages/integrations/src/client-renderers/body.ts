// SPDX-License-Identifier: Apache-2.0
// Shared, deterministic body composition. Every per-client renderer wraps
// this output with its own native syntax (Cursor `.mdc` frontmatter, plain
// Markdown for Codex/Windsurf, etc.) so the substantive content stays in
// lockstep across supported clients.

import type { CompanionPayloadMode } from "../context-delivery-policy.js";
import type { MultiClientInput } from "./types.js";

/** Pathrule integration body shared across every non-Claude client.
 *  Claude has its own renderer in `claude-md-project.ts`; keep policy
 *  language aligned there when editing this body. */
export interface ProtocolBodyOptions {
  /** Display name shown in the heading — usually the AI tool's product name. */
  toolLabel: string;
  mode?: CompanionPayloadMode;
}

/**
 * The signature block: everything Pathrule writes into a user-authored
 * instruction file in `signature` mode.
 *
 * Three properties are load-bearing and none of them are cosmetic:
 *   - it gives the agent NO orders and names NO tool, so a session with no
 *     Pathrule attached reads nothing it cannot carry out (the failure that
 *     produced "why is Claude Code editing my CLAUDE.md");
 *   - it keeps a managed marker, so a re-render overwrites in place instead of
 *     backing up the user's file (see paths/ownership.ts);
 *   - it is identical for every client, so there is one string to review.
 */
export function renderCompanionSignature(): string {
  return [
    "<!-- Pathrule managed — do not edit; cloud state is authoritative. -->",
    "",
    "Pathrule is active in this workspace. Its memory, rules, and skills are delivered",
    "per session by the Pathrule hook, so nothing else is compiled into this file.",
    "This block is generated: remove Pathrule from this project with `pathrule eject`.",
    "",
  ].join("\n");
}

export function renderProtocolBody(_input: MultiClientInput, options: ProtocolBodyOptions): string {
  if (options.mode === "signature") return renderCompanionSignature();

  const sections: string[] = [];

  // Marker line: lets safe-write.ts detect that an existing on-disk file is
  // already Pathrule-owned, so subsequent rerenders overwrite in place rather
  // than backing up the user's content. The `<!-- ... -->` comment is invisible
  // in any Markdown / mdc renderer the AI clients use.
  sections.push("<!-- Pathrule managed — do not edit; cloud state is authoritative. -->", "");

  sections.push("# Pathrule integration", "");
  sections.push(
    "Pathrule is this workspace's shared memory, rule, and skill layer for AI agents.",
    `${options.toolLabel} should use it as a smart reminder system, not a full-context dump.`,
    "",
  );

  sections.push("## Context Policy", "");
  sections.push(
    "- Pathrule is the first knowledge layer for this workspace. Use hook context first: metadata, relevant rule titles, path reminders, and filename/skill matches.",
    "- `::skill-name` is a hard gate: use the exact injected skill; if missing, stop and resolve it through Pathrule/MCP before file edits.",
    '- Do not reflexively call `pathrule_get_context` before every small known-path code task. For discovery, inventory, architecture, recent activity, or "list/show/find/where/which" prompts (Turkish: listele, göster, bul, nerede, hangi, neler), call it before any grep/read/fallback when hook context is missing, ambiguous, or stale.',
    "- Hook silence on a topic does not mean Pathrule has no relevant memory/rule. For discovery/inventory/architecture questions, call `pathrule_get_context` first; fall back to files, git, or general knowledge only after Pathrule returns nothing relevant.",
    "- When calling `pathrule_get_context`, pass `cwd`, `user_intent`, and `omit_protocol: true`; the companion file already contains the protocol.",
    "- Read full bodies with `pathrule_read_memory`, `pathrule_read_rule`, or `pathrule_read_skill` when a surfaced title/id is relevant.",
    "- Treat existing local edits as protected user/team work: inspect overlaps, never revert unrelated changes, and keep edits scoped.",
    "- Obey every surfaced rule. If a user request conflicts with a Pathrule rule, warn before taking action.",
    "",
  );

  sections.push("## Writes", "");
  sections.push(
    "- Pathrule cloud is the source of truth. Do not create local memory files such as `MEMORY.md` or `~/.claude/memory/`.",
    "- Use path-first writes for lasting project knowledge: `pathrule_write_memory`, `pathrule_write_rule`, and `pathrule_write_skill` take the most specific workspace-relative `node_path`.",
    "- Do not edit materialized local Pathrule files as the source of truth. This includes `.agents/skills/**/SKILL.md`, legacy `.codex/skills/**/SKILL.md`, `.claude/skills/**`, rendered companion files, and synced skill/memory/rule files. Read only for orientation; create/update cloud records with the Pathrule MCP write/update tools.",
    "- After any file-modifying response, call `pathrule_log_activity` once with domain, action, scope, subjects, files_touched, and a concise task_summary.",
    "",
  );

  const body = sections.join("\n").replace(/\n{3,}/g, "\n\n");
  return body.endsWith("\n") ? body : `${body}\n`;
}

/**
 * Shared get_context guardrail appended by renderers whose client tends to
 * call `pathrule_get_context` with empty args (Cursor, GitHub Copilot).
 * One source so the calling convention can never drift between clients.
 */
export function renderCwdGuardrail(toolLabel: string): string {
  return [
    `## ${toolLabel}-specific guardrail`,
    "",
    "- If you call `pathrule_get_context`, include BOTH `cwd` and `user_intent`.",
    "- `cwd` MUST be the absolute path of the active workspace root.",
    "- Never call `pathrule_get_context` with empty args. If `cwd` is unknown, resolve it first.",
    "",
    "Example:",
    "",
    "```json",
    '{ "cwd": "/absolute/path/to/workspace", "user_intent": "<user\'s last message>", "omit_protocol": true }',
    "```",
    "",
  ].join("\n");
}
