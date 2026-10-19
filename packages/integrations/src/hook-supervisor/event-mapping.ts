// SPDX-License-Identifier: Apache-2.0
import type { HookEventName } from "@pathrule/protocol/hook-index.js";

export type CursorHookEventName =
  | "preToolUse"
  | "postToolUse"
  | "beforeSubmitPrompt"
  | "sessionStart"
  | "stop"
  | "subagentStop"
  | "sessionEnd";

export const CLAUDE_TO_CURSOR_EVENT_MAP: Record<HookEventName, CursorHookEventName | null> = {
  PreToolUse: "preToolUse",
  PostToolUse: "postToolUse",
  // Claude Code only. Cursor / Codex / Copilot report tool failures inside their
  // normal post-tool event, so there is nothing to map here.
  PostToolUseFailure: null,
  UserPromptSubmit: "beforeSubmitPrompt",
  SessionStart: "sessionStart",
  SessionEnd: "sessionEnd",
  Stop: "stop",
  SubagentStop: "subagentStop",
  Notification: null,
  PreCompact: null,
  PostCompact: null,
};

export const CURSOR_TO_CLAUDE_EVENT_MAP: Record<CursorHookEventName, HookEventName> = {
  preToolUse: "PreToolUse",
  postToolUse: "PostToolUse",
  beforeSubmitPrompt: "UserPromptSubmit",
  sessionStart: "SessionStart",
  stop: "Stop",
  subagentStop: "SubagentStop",
  sessionEnd: "SessionEnd",
};

export const CURSOR_TO_CLAUDE_TOOL_MAP: Record<string, string> = {
  Write: "Edit",
  Shell: "Bash",
};

export const CLAUDE_TO_CURSOR_TOOL_MAP: Record<string, string> = {
  Edit: "Write",
  Bash: "Shell",
};

// ─── Codex (https://developers.openai.com/codex/hooks) ─────────────────────
// Codex uses the same PascalCase event names as Claude (PreToolUse, PostToolUse,
// SessionStart, UserPromptSubmit, Stop). It does NOT have SubagentStop or
// SessionEnd. Codex adds PermissionRequest which we do not consume yet.
export type CodexHookEventName =
  | "SessionStart"
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Stop"
  | "PermissionRequest";

export const CLAUDE_TO_CODEX_EVENT_MAP: Record<HookEventName, CodexHookEventName | null> = {
  PreToolUse: "PreToolUse",
  PostToolUse: "PostToolUse",
  // Claude Code only. Cursor / Codex / Copilot report tool failures inside their
  // normal post-tool event, so there is nothing to map here.
  PostToolUseFailure: null,
  UserPromptSubmit: "UserPromptSubmit",
  SessionStart: "SessionStart",
  SessionEnd: null,
  Stop: "Stop",
  SubagentStop: null,
  Notification: null,
  PreCompact: null,
  PostCompact: null,
};

// Codex's edit/write tool is `apply_patch` (single tool that handles
// add/update/delete via `*** File:` patch headers). Bash is unchanged. Read is
// not a hookable Codex tool today (file reads happen via shell / unified_exec).
export const CLAUDE_TO_CODEX_TOOL_MAP: Record<string, string> = {
  Edit: "apply_patch",
  Write: "apply_patch",
};

export const CODEX_TO_CLAUDE_TOOL_MAP: Record<string, string> = {
  apply_patch: "Edit",
};

// ─── GitHub Copilot (docs.github.com/en/copilot/reference/hooks-configuration) ─
// Copilot's native hook config uses camelCase event names; VS Code agent mode
// converts them to PascalCase internally and the cloud coding agent reads the
// same `.github/hooks/*.json` file. `UserPromptSubmit` is deliberately
// unmapped: Copilot's userPromptSubmitted accepts no context output on any
// surface, so wiring it would burn one process per prompt for zero injection
// (same reasoning as Cursor's beforeSubmitPrompt).
export type CopilotHookEventName =
  | "sessionStart"
  | "sessionEnd"
  | "userPromptSubmitted"
  | "preToolUse"
  | "postToolUse"
  | "postToolUseFailure"
  | "agentStop"
  | "subagentStart"
  | "subagentStop"
  | "errorOccurred"
  | "preCompact"
  | "permissionRequest"
  | "notification";

export const CLAUDE_TO_COPILOT_EVENT_MAP: Record<HookEventName, CopilotHookEventName | null> = {
  PreToolUse: "preToolUse",
  PostToolUse: "postToolUse",
  // Claude Code only. Cursor / Codex / Copilot report tool failures inside their
  // normal post-tool event, so there is nothing to map here.
  PostToolUseFailure: null,
  UserPromptSubmit: null,
  SessionStart: "sessionStart",
  SessionEnd: "sessionEnd",
  Stop: "agentStop",
  SubagentStop: "subagentStop",
  Notification: null,
  PreCompact: null,
  PostCompact: null,
};

// Copilot CLI + cloud coding agent tool names. VS Code agent mode uses its own
// names (createFile/editFiles/runTerminalCommand…) handled by the hook
// script's copilot branch; renderer matchers carry both via
// COPILOT_VSCODE_TOOL_ALIASES in client-config-writer.ts.
export const CLAUDE_TO_COPILOT_TOOL_MAP: Record<string, string> = {
  Read: "view",
  Edit: "edit",
  Write: "create",
  Bash: "bash",
  Grep: "grep",
  Glob: "glob",
};
