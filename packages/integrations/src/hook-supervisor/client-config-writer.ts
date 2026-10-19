// SPDX-License-Identifier: Apache-2.0
import {
  CLAUDE_TO_CODEX_EVENT_MAP,
  CLAUDE_TO_CODEX_TOOL_MAP,
  CLAUDE_TO_COPILOT_EVENT_MAP,
  CLAUDE_TO_COPILOT_TOOL_MAP,
  CLAUDE_TO_CURSOR_EVENT_MAP,
  CLAUDE_TO_CURSOR_TOOL_MAP,
} from "./event-mapping.js";
import { getHookCommand } from "./hook-command.js";
import type { HookConfig, HookEventName, HookMatcher } from "@pathrule/protocol/hook-index.js";

// Tools Cursor's hook surface actually exposes (https://cursor.com/docs/agent/hooks).
// Claude tools without a Cursor analogue (Glob, WebFetch, WebSearch) are
// dropped from the Cursor matcher rather than carried through dead.
const CURSOR_TOOL_SET = new Set(["Read", "Write", "Grep", "Delete", "Task", "Shell"]);

// Events whose Cursor-native output schema can carry Pathrule's payload.
// UserPromptSubmit -> beforeSubmitPrompt is intentionally absent: Cursor's
// beforeSubmitPrompt accepts only { continue, user_message } — no
// additional_context — so wiring the matcher would burn one process per
// prompt for zero injection. SessionStart + PostToolUse cover the same
// ground for Cursor users (one-shot bootstrap + reactive path-scoped).
const CURSOR_SUPPORTED_EVENTS = new Set<HookEventName>([
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "SessionEnd",
]);

function cloneMatchers(matchers: readonly HookMatcher[]): HookMatcher[] {
  return matchers.map((matcher) => ({
    matcher: matcher.matcher,
    hooks: matcher.hooks.map((hook) => ({ ...hook })),
  }));
}

function mapMatcherToCursor(matcher: HookMatcher): HookMatcher | null {
  if (!matcher.matcher) return matcher;
  const seen = new Set<string>();
  const mapped: string[] = [];
  for (const name of matcher.matcher.split("|")) {
    const cursorName = CLAUDE_TO_CURSOR_TOOL_MAP[name] ?? name;
    if (!CURSOR_TOOL_SET.has(cursorName)) continue;
    if (seen.has(cursorName)) continue;
    seen.add(cursorName);
    mapped.push(cursorName);
  }
  if (mapped.length === 0) return null;
  return { ...matcher, matcher: mapped.join("|") };
}

export function buildHookConfig(scriptPath?: string): HookConfig {
  const cmd = scriptPath ?? getHookCommand();
  return {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: cmd }] }],
      PreToolUse: [
        {
          matcher: "Read|Edit|Write|Grep|Glob|Bash",
          hooks: [{ type: "command", command: cmd }],
        },
      ],
      PostToolUse: [
        {
          matcher: "Read|Edit|Write|Bash",
          hooks: [{ type: "command", command: cmd }],
        },
      ],
      // Claude Code routes tool FAILURES here and sends no PostToolUse for them, so
      // the friction pipe sees nothing without this matcher. Same matcher as above:
      // these are the tools whose failures point at a file worth remembering.
      PostToolUseFailure: [
        {
          matcher: "Read|Edit|Write|Bash",
          hooks: [{ type: "command", command: cmd }],
        },
      ],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: cmd }] }],
      Stop: [{ hooks: [{ type: "command", command: cmd }] }],
      SubagentStop: [{ hooks: [{ type: "command", command: cmd }] }],
      SessionEnd: [{ hooks: [{ type: "command", command: cmd }] }],
    },
  };
}

export function renderClaudeSettings(config: HookConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Per-event Cursor matcher map — shared by `renderCursorHooks` (fresh emit)
 *  and `ensureCursorHooks` (merger that preserves user's other entries). */
export function buildCursorHookEvents(config: HookConfig): Record<string, HookMatcher[]> {
  const hooks: Record<string, HookMatcher[]> = {};
  for (const [rawEvent, rawMatchers] of Object.entries(config.hooks)) {
    const event = rawEvent as HookEventName;
    if (!CURSOR_SUPPORTED_EVENTS.has(event)) continue;
    const cursorEvent = CLAUDE_TO_CURSOR_EVENT_MAP[event];
    if (!cursorEvent || !rawMatchers || rawMatchers.length === 0) continue;
    const mapped = cloneMatchers(rawMatchers)
      .map(mapMatcherToCursor)
      .filter((m): m is HookMatcher => m !== null);
    if (mapped.length === 0) continue;
    hooks[cursorEvent] = mapped;
  }
  return hooks;
}

export function renderCursorHooks(config: HookConfig): string {
  return `${JSON.stringify({ version: 1, hooks: buildCursorHookEvents(config) }, null, 2)}\n`;
}

// ─── Codex (https://developers.openai.com/codex/hooks) ─────────────────────
// Codex's hook contract is a near-clone of Claude's: PascalCase event names,
// hookSpecificOutput.additionalContext for context injection, decision/
// permissionDecision for blocks. The only divergences are tool names
// (apply_patch instead of Edit/Write, no Read hook) and the activation
// requirement (config.toml [features] hooks = true).
const CODEX_TOOL_SET = new Set(["Bash", "apply_patch"]);

const CODEX_SUPPORTED_EVENTS = new Set<HookEventName>([
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
]);

function mapMatcherToCodex(matcher: HookMatcher): HookMatcher | null {
  if (!matcher.matcher) return matcher;
  const seen = new Set<string>();
  const mapped: string[] = [];
  for (const name of matcher.matcher.split("|")) {
    const codexName = CLAUDE_TO_CODEX_TOOL_MAP[name] ?? name;
    if (!CODEX_TOOL_SET.has(codexName)) continue;
    if (seen.has(codexName)) continue;
    seen.add(codexName);
    mapped.push(codexName);
  }
  if (mapped.length === 0) return null;
  return { ...matcher, matcher: mapped.join("|") };
}

export function buildCodexHookEvents(config: HookConfig): Record<string, HookMatcher[]> {
  const hooks: Record<string, HookMatcher[]> = {};
  for (const [rawEvent, rawMatchers] of Object.entries(config.hooks)) {
    const event = rawEvent as HookEventName;
    if (!CODEX_SUPPORTED_EVENTS.has(event)) continue;
    const codexEvent = CLAUDE_TO_CODEX_EVENT_MAP[event];
    if (!codexEvent || !rawMatchers || rawMatchers.length === 0) continue;
    const mapped = cloneMatchers(rawMatchers)
      .map(mapMatcherToCodex)
      .filter((m): m is HookMatcher => m !== null);
    // Keep matcher-less entries (UserPromptSubmit, SessionStart, Stop) as-is.
    if (mapped.length === 0 && rawMatchers.some((m) => !m.matcher)) {
      hooks[codexEvent] = cloneMatchers(rawMatchers).filter((m) => !m.matcher);
      continue;
    }
    if (mapped.length === 0) continue;
    hooks[codexEvent] = mapped;
  }
  return hooks;
}

export function renderCodexHooks(config: HookConfig): string {
  return `${JSON.stringify({ hooks: buildCodexHookEvents(config) }, null, 2)}\n`;
}

// ─── GitHub Copilot (docs.github.com/en/copilot/reference/hooks-configuration) ─
// One `.github/hooks/pathrule.json` feeds all three Copilot surfaces: the CLI
// reads it natively, VS Code agent mode converts the camelCase event names to
// PascalCase, and the cloud coding agent reads `.github/hooks/*.json` as its
// only hook source. Copilot's `matcher` is a regex anchored against the tool
// name — Claude's `a|b|c` pipe lists are valid alternations as-is.

const COPILOT_TOOL_SET = new Set(["bash", "create", "edit", "view", "grep", "glob"]);

// VS Code agent mode uses its own tool names (docs show both naming
// generations). Folded into matchers so PreToolUse/PostToolUse still fire if
// a host applies the matcher against VS Code names rather than CLI names.
const COPILOT_VSCODE_TOOL_ALIASES: Record<string, readonly string[]> = {
  view: ["read_file", "readFile"],
  edit: ["editFiles", "replace_string_in_file"],
  create: ["createFile", "create_file"],
  bash: ["runTerminalCommand", "run_in_terminal"],
};

const COPILOT_SUPPORTED_EVENTS = new Set<HookEventName>([
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "SessionEnd",
]);

/** One entry per hook in Copilot's flattened per-event array format. The env
 *  stamp is the hook script's primary client discriminator; the event stamp
 *  exists because Copilot CLI's camelCase payload carries no event name. */
interface CopilotHookEntry {
  type: "command";
  command: string;
  matcher?: string;
  env: Record<string, string>;
}

function mapMatcherToCopilot(matcher: string | undefined): string | null | undefined {
  if (!matcher) return undefined; // matcher-less entry — fires on every tool
  const seen = new Set<string>();
  const mapped: string[] = [];
  for (const name of matcher.split("|")) {
    const copilotName = CLAUDE_TO_COPILOT_TOOL_MAP[name];
    if (!copilotName || !COPILOT_TOOL_SET.has(copilotName) || seen.has(copilotName)) continue;
    seen.add(copilotName);
    mapped.push(copilotName, ...(COPILOT_VSCODE_TOOL_ALIASES[copilotName] ?? []));
  }
  return mapped.length > 0 ? mapped.join("|") : null;
}

export function buildCopilotHookEvents(config: HookConfig): Record<string, CopilotHookEntry[]> {
  const hooks: Record<string, CopilotHookEntry[]> = {};
  for (const [rawEvent, rawMatchers] of Object.entries(config.hooks)) {
    const event = rawEvent as HookEventName;
    if (!COPILOT_SUPPORTED_EVENTS.has(event)) continue;
    const copilotEvent = CLAUDE_TO_COPILOT_EVENT_MAP[event];
    if (!copilotEvent || !rawMatchers || rawMatchers.length === 0) continue;
    const entries: CopilotHookEntry[] = [];
    for (const matcherGroup of rawMatchers) {
      const matcher = mapMatcherToCopilot(matcherGroup.matcher);
      if (matcher === null) continue; // every tool in the group is unmappable
      for (const hook of matcherGroup.hooks) {
        if (hook.type !== "command") continue;
        entries.push({
          type: "command",
          command: hook.command,
          ...(matcher !== undefined ? { matcher } : {}),
          env: { PATHRULE_HOOK_CLIENT: "copilot", PATHRULE_HOOK_EVENT: copilotEvent },
        });
      }
    }
    if (entries.length > 0) hooks[copilotEvent] = entries;
  }
  return hooks;
}

export function renderCopilotHooks(config: HookConfig): string {
  return `${JSON.stringify({ version: 1, hooks: buildCopilotHookEvents(config) }, null, 2)}\n`;
}
