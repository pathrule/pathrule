// SPDX-License-Identifier: Apache-2.0
// Pathrule agent protocol — the single source of truth for instructions that
// tell AI agents how to interact with the Pathrule MCP server. Consumed by:
//
//   1. MCP get_context response → `protocol` field (all clients)
//   2. .claude/rules/pathrule-protocol.md → auto-loaded by Claude Code
//   3. CLAUDE.md renderer → minimal "call get_context first" pointer
//
// Keep the three layers in sync by deriving everything from these constants.

import type { RoutingDecision } from "@pathrule/protocol/routing-types.js";
import { stableHash } from "@pathrule/protocol/versioning.js";
import {
  buildCodexHookEvents,
  buildCursorHookEvents,
  buildHookConfig,
} from "./hook-supervisor/client-config-writer.js";
import type { HookMatcher } from "@pathrule/protocol/hook-index.js";

export interface PathruleProtocol {
  before: string[];
  during: string[];
  after: string[];
}

/**
 * Structured protocol injected into every get_context response. LLMs see this
 * on every session start — no file reads required.
 *
 * Hook-aware flow: PreToolUse + UserPromptSubmit hooks inject the
 * workspace's memory/rule titles + session digest automatically. Most
 * prompts should proceed without any MCP call at all — the context is
 * already present. MCP tools are the *deep* layer: full bodies, discovery
 * queries, and writes.
 */
export const PATHRULE_PROTOCOL: PathruleProtocol = {
  // Minimal contract (V37). Only what the agent must be TOLD and cannot learn from the runtime: the
  // trust+no-re-explore lever, the staleness safety valve, when to reach for MCP, and what to save.
  // What a tool's own description says (log_activity's purpose, resolve + content_edit) is not repeated
  // here; the skill/pattern gate rides only an index whose workspace holds skills (`SKILL_GATE`); the
  // Signals rule lives on the instrument tool. Measured on PathruleBench v3 (2026-10-16): the block is
  // re-read on every model step of a session, so every sentence here is paid ~120 times a chain.
  before: [
    "Pathrule is this workspace's knowledge layer: its rules files and what is injected by the Pathrule hook are AUTHORITATIVE. When the hook injects a memory/skill body, that body IS the content: use it directly; do NOT grep, search, or re-read files to re-verify what it already gave you. Open files only to read the current CODE you must edit or check.",
    "Knowledge about the code can go stale. When the code contradicts a description of it (where something lives, what it is called, how it is wired), the code wins for what exists today: STATE the contradiction (name the stale item and how the code differs), follow the code, never edit the code back to match the description, and surface it so the team refreshes it. A decision about what to build or how to write it is different: it binds new work even when the code has not caught up, so apply it to what you write and say what still lags behind. Never silently resolve a code-vs-knowledge conflict.",
    "Do NOT reflexively call pathrule_get_context for a small known-path task. DO call pathrule_get_context(cwd, user_intent, omit_protocol: true) before any grep/read/fallback when hook context is missing or stale, and for discovery, inventory or list/show/find/where/which questions (including Turkish: listele, göster, bul, nerede, hangi, neler). A candidate it names is a lead: call pathrule_read_memory(id) before citing one.",
  ],
  during: [
    "A decision, preference or constraint the user states or changes: save it now (write_memory at the most specific node_path, or update the earlier one) where it APPLIES; a product-wide rule goes to '/' or carries related_paths. How the user likes to WORK (not the project): pathrule_remember_preference. Never use local file-based memory (~/.claude/memory/, MEMORY.md); Pathrule is the store.",
    "What you learned that the code does not show — a fix, how to run or verify something here, a current fact, a reason — is a memory too (at '/' when it applies everywhere), with the teaching sentence quoted VERBATIM in `atoms`.",
  ],
  after: [],
};

/** The skill and pattern gate: rendered only for a workspace that holds skills (the hook index knows). */
export const SKILL_GATE =
  "`::skill-name` is a hard gate: run the exact injected skill. `::pathrule:package:<slug>` is a PATTERN import, not a skill: call pathrule_import_pattern(dry_run: true) first, judge fit against this workspace, then write. Follow the instruction the hook gives for each; do not improvise one.";

/**
 * 8-char SHA1 of the canonical JSON of `PATHRULE_PROTOCOL`. Bumped only when
 * developers edit this file. Clients that pass `known_protocol_version` matching
 * this value get a `protocol_unchanged: true` response with the body omitted.
 *
 * Memoized at module load — protocol is a constant, hash is computed once.
 */
export const PATHRULE_PROTOCOL_VERSION = stableHash(PATHRULE_PROTOCOL);

/** The per-prompt capture reminder the hook shows to a session with the MCP server (hook-index `capture_reminder`). */
export const CAPTURE_REMINDER =
  "Pathrule: a decision, preference or constraint stated or changed here goes to pathrule_write_memory where it applies.";

/**
 * Render the `.claude/rules/pathrule-protocol.md` file content. This file is
 * auto-loaded by Claude Code as a system-level rule — strongest guarantee
 * for CC users. Written alongside CLAUDE.md on every rerender.
 */
export function renderProtocolRulesFile(options: { skills?: boolean } = {}): string {
  const items = [...PATHRULE_PROTOCOL.before, ...PATHRULE_PROTOCOL.during, ...PATHRULE_PROTOCOL.after];
  if (options.skills !== false) items.push(SKILL_GATE);
  return [
    "# Pathrule Protocol",
    "",
    "This workspace uses Pathrule MCP. Follow this protocol on EVERY task.",
    "",
    ...items.map((item, i) => `${i + 1}. ${item}`),
    "",
  ].join("\n");
}

/**
 * The protocol for a session with no Pathrule MCP server (a hook-only integration). It carries the
 * same contract minus every `pathrule_*` tool: an agent told to call a tool it does not have either
 * stalls or improvises, which is the failure the protocol channel exists to prevent. Reads go
 * through the Pathrule CLI when the agent can run it; lasting knowledge is the person's call.
 */
export function renderHookOnlyProtocol(): string {
  const items = [
    "Pathrule is this workspace's knowledge layer. The Pathrule hook injects the task-relevant memories, rules and skills for each prompt and for the files you touch, and they are AUTHORITATIVE: use an injected body directly, and do NOT grep, search or re-read files to re-verify what it already gave you. Open files only to read the current CODE you must edit or check.",
    "Knowledge about the code can go stale. When the code contradicts a description of it (where something lives, what it is called, how it is wired), the code wins for what exists today: STATE the contradiction (name the stale item and how the code differs), follow the code, never edit the code back to match the description, and surface it so the team refreshes it. A decision about what to build or how to write it binds new work even when the code has not caught up: apply it to what you write and say what still lags behind.",
    "No Pathrule MCP tools are attached to this session: never call a `pathrule_*` tool. To read an item the hook named by id, or to search this workspace's knowledge, run the Pathrule CLI when you can: `pathrule memory read <id>` (also `rule` and `skill`) and `pathrule search \"<query>\"`.",
    "`::skill-name` is a hard gate: read the exact skill (`pathrule skill read <id>`) and follow it.",
    "Never use local file-based memory (~/.claude/memory/, MEMORY.md) as Pathrule's store. When the user wants something remembered for the team, say that Pathrule's MCP server or the Pathrule UI records it.",
  ];
  return [
    "# Pathrule Protocol",
    "",
    "This workspace uses Pathrule through its hook. Follow this protocol on EVERY task.",
    "",
    ...items.map((item, i) => `${i + 1}. ${item}`),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// .claude/settings.json hook injection
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Routing decision → human instruction
// ---------------------------------------------------------------------------

/**
 * Turn a router-issued RoutingDecision into a single, directive instruction
 * the calling LLM sees in the get_context response. Centralised here so the
 * wording is consistent across every MCP client.
 */
export function describeRoutingAction(decision: RoutingDecision): string {
  const files =
    decision.primary_files && decision.primary_files.length > 0
      ? ` Likely target(s): ${decision.primary_files.join(", ")}.`
      : "";
  switch (decision.next) {
    case "call_understand":
      // Legacy router output — the understand tool was replaced with a
      // depth-aware get_context. Treat it as "no_action" with a hint.
      return `Proceed with the task using the provided context.${files} ${decision.reason}`;
    case "read_memory":
      return decision.memory_id
        ? `Read memory ${decision.memory_id} — it likely contains the answer. ${decision.reason}`
        : `Read the matching memory from the workspace overview. ${decision.reason}`;
    case "execute_only":
      return `Run the requested command. No knowledge lookup needed. ${decision.reason}`;
    case "edit_known_path":
      return `Edit the file/path the user referenced.${files} No exploration needed. ${decision.reason}`;
    case "answer_directly":
      return `Answer from your own knowledge. ${decision.reason}`;
    case "no_action":
      return `Proceed directly with the task.${files} ${decision.reason}`;
  }
}

/**
 * Markers we match to identify Pathrule-owned hook entries. Substring match
 * recognises the script path, its Windows `.cmd` shim (the command there), AND the legacy
 * `pathrule_log_activity` reminder, so upgrading cleanly replaces the old hook regardless
 * of whether the existing entry is a tilde or absolute path.
 */
const HOOK_MARKERS = ["pathrule-hook.js", "pathrule-hook.cmd", "pathrule_log_activity"] as const;

/**
 * Canonical set of hooks Pathrule installs. Three events wired:
 *   - PreToolUse: tool about to run → inject context, block rule violations
 *   - PostToolUse: tool finished → capture failures, pattern-log
 *   - UserPromptSubmit: user typed a prompt → inject session digest
 *
 * Resolved lazily via `buildHookConfig()` so each merger call picks up the
 * absolute hook command path configured by `setHookCommand()` at process
 * startup. Module-level caching would freeze in a tilde literal before the
 * setter ran.
 */
function pathruleHooks() {
  return buildHookConfig().hooks;
}

function pathruleCursorHooks() {
  return buildCursorHookEvents(buildHookConfig());
}

function pathruleCodexHooks() {
  return buildCodexHookEvents(buildHookConfig());
}

interface ClaudeSettings {
  hooks?: Record<string, HookMatcher[] | unknown>;
  [k: string]: unknown;
}

function commandMatchesMarker(cmd: string | undefined): boolean {
  if (!cmd) return false;
  return HOOK_MARKERS.some((m) => cmd.includes(m));
}

/** Strip any existing Pathrule-owned entries from a hook list. */
function stripPathruleEntries(entries: HookMatcher[]): HookMatcher[] {
  const result: HookMatcher[] = [];
  for (const entry of entries) {
    const remaining = (entry.hooks ?? []).filter((h) => !commandMatchesMarker(h.command));
    if (remaining.length === 0) continue;
    result.push({ ...entry, hooks: remaining });
  }
  return result;
}

/** A hook config the person's tool would not read either: Pathrule leaves it exactly as it is. */
export class HookConfigUnreadableError extends Error {
  readonly code = "hook_config_unreadable";
  constructor() {
    super("the file is not a valid JSON object; Pathrule leaves it as it is");
  }
}

/** The config as an object ({} when absent or blank); throws HookConfigUnreadableError otherwise. */
function parseHookConfig(existing: string | null): Record<string, unknown> {
  if (!existing || existing.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    throw new HookConfigUnreadableError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HookConfigUnreadableError();
  return parsed as Record<string, unknown>;
}

/**
 * Pure function: takes existing `.claude/settings.json` content (or null if
 * file doesn't exist) and returns the merged JSON string with Pathrule's
 * hook set installed. Idempotent:
 *   - first call: installs Pre/Post/UserPromptSubmit hooks
 *   - subsequent calls: no-op when already present (returns `changed: false`)
 *   - upgrade from legacy hook: strips the old reminder, installs new set
 *
 * Other hooks the user has configured are preserved untouched.
 */
export function ensureClaudeSettingsHook(
  existing: string | null,
  options?: { uninstall?: boolean },
): {
  body: string;
  changed: boolean;
} {
  // A settings file Pathrule cannot read is never rewritten (fail closed): it holds the person's
  // permissions and plugins, and folding it into a string key switched all of them off.
  const settings = parseHookConfig(existing) as ClaudeSettings;

  if (!settings.hooks) settings.hooks = {};

  let changed = false;

  // Uninstall mirrors ensureCursorHooks: strip only OUR entries, keep every hook
  // the user wired themselves, and never delete this file. `.claude/settings.json`
  // holds permissions, plugins, and editor preferences, so it belongs to the user
  // even when Pathrule is the reason it exists.
  if (options?.uninstall === true) {
    const hooks = settings.hooks as Record<string, unknown>;
    for (const event of Object.keys(hooks)) {
      const existingRaw = hooks[event];
      if (!Array.isArray(existingRaw)) continue;
      const nonPathrule = stripPathruleEntries(existingRaw as HookMatcher[]);
      if (nonPathrule.length === (existingRaw as HookMatcher[]).length) continue;
      if (nonPathrule.length === 0) delete hooks[event];
      else (hooks as Record<string, HookMatcher[]>)[event] = nonPathrule;
      changed = true;
    }
    if (Object.keys(hooks).length === 0) delete settings.hooks;
    // An older Pathrule folded an unreadable file into `_backup`. With nothing else of Pathrule's left
    // and nothing added since, the person's own text goes back as it was.
    const legacy = (settings as { _backup?: unknown })._backup;
    if (typeof legacy === "string" && Object.keys(settings).length === 1) return { body: legacy, changed: true };
    return { body: JSON.stringify(settings, null, 2) + "\n", changed };
  }

  for (const [event, desired] of Object.entries(pathruleHooks())) {
    const existingRaw = settings.hooks[event];
    const existingEntries = Array.isArray(existingRaw) ? (existingRaw as HookMatcher[]) : [];

    // Fast path: if exactly our entries are present, skip.
    const pathruleEntries = existingEntries.filter((entry) =>
      (entry.hooks ?? []).some((h) => commandMatchesMarker(h.command)),
    );
    const nonPathrule = stripPathruleEntries(existingEntries);

    const alreadyInstalled =
      pathruleEntries.length === desired.length &&
      pathruleEntries.every((entry, i) => {
        const want = desired[i];
        if (!want) return false;
        const gotHooks = entry.hooks;
        const wantHooks = want.hooks;
        return (
          (entry.matcher ?? "") === (want.matcher ?? "") &&
          gotHooks.length === wantHooks.length &&
          gotHooks.every((h, j) => h.command === wantHooks[j]?.command)
        );
      });

    if (alreadyInstalled) continue;

    // Replace Pathrule's entries; keep everything else the user set up.
    settings.hooks[event] = [...nonPathrule, ...desired];
    changed = true;
  }

  return { body: JSON.stringify(settings, null, 2) + "\n", changed };
}

// ---------------------------------------------------------------------------
// .cursor/hooks.json merge — same shape strategy as ensureClaudeSettingsHook,
// but Cursor's lowercase event names + top-level `version: 1` field. Preserves
// every hook the user already wired (e.g., their own preToolUse safety guard)
// and only swaps Pathrule's entries in/out using the shared command marker.
// ---------------------------------------------------------------------------

interface CursorHooksFile {
  version?: number;
  hooks?: Record<string, HookMatcher[] | unknown>;
  [k: string]: unknown;
}

export function ensureCursorHooks(
  existing: string | null,
  options?: { uninstall?: boolean },
): {
  body: string;
  changed: boolean;
} {
  const file: CursorHooksFile = existing && existing.trim().length > 0 ? (parseHookConfig(existing) as CursorHooksFile) : { version: 1 };
  if (typeof file.version !== "number") file.version = 1;
  if (!file.hooks || typeof file.hooks !== "object") file.hooks = {};

  const uninstall = options?.uninstall === true;
  let changed = false;

  if (uninstall) {
    // Strip every Pathrule-marked entry. Leave user-defined hooks intact.
    for (const event of Object.keys(file.hooks as Record<string, unknown>)) {
      const existingRaw = (file.hooks as Record<string, unknown>)[event];
      if (!Array.isArray(existingRaw)) continue;
      const nonPathrule = stripPathruleEntries(existingRaw as HookMatcher[]);
      if (nonPathrule.length === (existingRaw as HookMatcher[]).length) continue;
      if (nonPathrule.length === 0) {
        delete (file.hooks as Record<string, unknown>)[event];
      } else {
        (file.hooks as Record<string, HookMatcher[]>)[event] = nonPathrule;
      }
      changed = true;
    }
    // If nothing remains beyond version + empty hooks, signal the caller to
    // unlink the file entirely (returning "" lets atomicWriteOrUnlink delete).
    const remainingKeys = Object.keys(file).filter((k) => k !== "version" && k !== "hooks");
    const remainingHookKeys = Object.keys(file.hooks as Record<string, unknown>);
    if (remainingKeys.length === 0 && remainingHookKeys.length === 0) {
      return { body: "", changed: true };
    }
    return { body: JSON.stringify(file, null, 2) + "\n", changed };
  }

  for (const [event, desired] of Object.entries(pathruleCursorHooks())) {
    const existingRaw = (file.hooks as Record<string, unknown>)[event];
    const existingEntries = Array.isArray(existingRaw) ? (existingRaw as HookMatcher[]) : [];

    const pathruleEntries = existingEntries.filter((entry) =>
      (entry.hooks ?? []).some((h) => commandMatchesMarker(h.command)),
    );
    const nonPathrule = stripPathruleEntries(existingEntries);

    const alreadyInstalled =
      pathruleEntries.length === desired.length &&
      pathruleEntries.every((entry, i) => {
        const want = desired[i];
        if (!want) return false;
        return (
          (entry.matcher ?? "") === (want.matcher ?? "") &&
          entry.hooks.length === want.hooks.length &&
          entry.hooks.every((h, j) => h.command === want.hooks[j]?.command)
        );
      });

    if (
      alreadyInstalled &&
      nonPathrule.length === existingEntries.length - pathruleEntries.length
    ) {
      continue;
    }
    (file.hooks as Record<string, HookMatcher[]>)[event] = [...nonPathrule, ...desired];
    changed = true;
  }

  return { body: JSON.stringify(file, null, 2) + "\n", changed };
}

// ---------------------------------------------------------------------------
// .codex/hooks.json merge — Codex follows Claude's hook-config shape almost
// verbatim (PascalCase event names, hooks object). We reuse the same Pathrule
// command marker so cross-client tooling stays consistent.
// ---------------------------------------------------------------------------

export function ensureCodexHooks(
  existing: string | null,
  options?: { uninstall?: boolean },
): {
  body: string;
  changed: boolean;
} {
  const file = parseHookConfig(existing) as { hooks?: Record<string, HookMatcher[] | unknown>; [k: string]: unknown };
  if (!file.hooks || typeof file.hooks !== "object") file.hooks = {};

  const uninstall = options?.uninstall === true;
  let changed = false;

  if (uninstall) {
    for (const event of Object.keys(file.hooks as Record<string, unknown>)) {
      const existingRaw = (file.hooks as Record<string, unknown>)[event];
      if (!Array.isArray(existingRaw)) continue;
      const nonPathrule = stripPathruleEntries(existingRaw as HookMatcher[]);
      if (nonPathrule.length === (existingRaw as HookMatcher[]).length) continue;
      if (nonPathrule.length === 0) {
        delete (file.hooks as Record<string, unknown>)[event];
      } else {
        (file.hooks as Record<string, HookMatcher[]>)[event] = nonPathrule;
      }
      changed = true;
    }
    const remainingKeys = Object.keys(file).filter((k) => k !== "hooks");
    const remainingHookKeys = Object.keys(file.hooks as Record<string, unknown>);
    if (remainingKeys.length === 0 && remainingHookKeys.length === 0) {
      return { body: "", changed: true };
    }
    return { body: JSON.stringify(file, null, 2) + "\n", changed };
  }

  for (const [event, desired] of Object.entries(pathruleCodexHooks())) {
    const existingRaw = (file.hooks as Record<string, unknown>)[event];
    const existingEntries = Array.isArray(existingRaw) ? (existingRaw as HookMatcher[]) : [];

    const pathruleEntries = existingEntries.filter((entry) =>
      (entry.hooks ?? []).some((h) => commandMatchesMarker(h.command)),
    );
    const nonPathrule = stripPathruleEntries(existingEntries);

    const alreadyInstalled =
      pathruleEntries.length === desired.length &&
      pathruleEntries.every((entry, i) => {
        const want = desired[i];
        if (!want) return false;
        return (
          (entry.matcher ?? "") === (want.matcher ?? "") &&
          entry.hooks.length === want.hooks.length &&
          entry.hooks.every((h, j) => h.command === want.hooks[j]?.command)
        );
      });

    if (
      alreadyInstalled &&
      nonPathrule.length === existingEntries.length - pathruleEntries.length
    ) {
      continue;
    }
    (file.hooks as Record<string, HookMatcher[]>)[event] = [...nonPathrule, ...desired];
    changed = true;
  }

  return { body: JSON.stringify(file, null, 2) + "\n", changed };
}

// ---------------------------------------------------------------------------
// .codex/config.toml merge — Codex requires `[features] hooks = true` to load
// hooks. (The older `codex_hooks` key is deprecated; Codex emits a deprecation
// warning when it sees it.) We add this as a marker-bound block at the end of
// whatever TOML the user already has, leaving every other key alone. The
// marker-bound merger replaces an older block on the next render, so existing
// `codex_hooks` configs migrate automatically. Idempotent.
// ---------------------------------------------------------------------------

export const CODEX_TOML_START = "# >>> Pathrule managed (codex hook activation) >>>";
const CODEX_TOML_END = "# <<< Pathrule managed <<<";
const CODEX_TOML_BLOCK = [
  CODEX_TOML_START,
  "[features]",
  "hooks = true",
  CODEX_TOML_END,
  "",
].join("\n");

export function ensureCodexConfigToml(
  existing: string | null,
  options?: { uninstall?: boolean },
): {
  body: string;
  changed: boolean;
} {
  const normalized = (existing ?? "").replace(/\r\n/g, "\n");
  const startIdx = normalized.indexOf(CODEX_TOML_START);
  const endIdx = normalized.indexOf(CODEX_TOML_END);

  let stripped = normalized;
  if (startIdx >= 0 && endIdx > startIdx) {
    const after = normalized.slice(endIdx + CODEX_TOML_END.length).replace(/^\n+/, "");
    stripped = (normalized.slice(0, startIdx).trimEnd() + (after ? `\n\n${after}` : "")).trimEnd();
  } else {
    stripped = normalized.trimEnd();
  }

  if (options?.uninstall === true) {
    const result = stripped.length > 0 ? `${stripped}\n` : "";
    return { body: result, changed: result !== normalized };
  }

  const next = stripped.length > 0 ? `${stripped}\n\n${CODEX_TOML_BLOCK}` : CODEX_TOML_BLOCK;
  if (normalized === next) return { body: normalized, changed: false };
  return { body: next, changed: true };
}
