// SPDX-License-Identifier: Apache-2.0
// Pathrule's OpenCode plugin (@pathrule/opencode).
//
// OpenCode has no hook file: a plugin is this module. It adds Pathrule's MCP server and skills to
// OpenCode's config and asks Pathrule's hook, through the launcher beside this file, for the
// knowledge each moment needs: at a session's first message and every prompt (added to that turn's
// system prompt), and after a file tool (added to the tool's output). The launcher hands every job to
// the Pathrule runtime installed on this machine; this plugin downloads and installs nothing.
//
// Node built-ins only. A failure here never breaks OpenCode: Pathrule then adds nothing.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = join(ROOT, "scripts", "pathrule-launch.cjs");

// OpenCode's tool names for the tools whose files Pathrule's knowledge is scoped to.
const TOOLS = { read: "Read", edit: "Edit", write: "Write", patch: "Edit", bash: "Bash", grep: "Grep", glob: "Glob" };

/** Pathrule's answer to one event in Claude Code's hook shape, or null. */
function ask(event, cwd) {
  // `node` by name: inside OpenCode, process.execPath is OpenCode itself.
  const r = spawnSync("node", [LAUNCHER, "hook", "--mcp=bundled"], {
    input: JSON.stringify({ ...event, cwd }),
    encoding: "utf8",
    cwd,
    env: process.env,
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
  });
  try {
    return JSON.parse((r.stdout || "").trim() || "{}");
  } catch {
    return null;
  }
}

const contextOf = (answer) => {
  const text = answer && answer.hookSpecificOutput && answer.hookSpecificOutput.additionalContext;
  return typeof text === "string" && text.trim() !== "" ? text : null;
};

function toolEvent(name, input) {
  const args = input && typeof input === "object" ? input : {};
  const file = args.filePath || args.file_path || args.path;
  return {
    tool_name: TOOLS[name] || name,
    tool_input: { ...args, ...(file ? { file_path: file } : {}), ...(args.oldString ? { old_string: args.oldString, new_string: args.newString } : {}) },
  };
}

export const PathrulePlugin = async ({ directory }) => {
  const cwd = directory || process.cwd();
  const started = new Set();
  const turn = new Map();
  // What the hook had for a file before its tool ran: OpenCode adds context only to a tool's output.
  const beforeTool = new Map();
  return {
    config: async (config) => {
      config.mcp = config.mcp || {};
      if (!config.mcp.pathrule) config.mcp.pathrule = { type: "local", command: ["node", LAUNCHER, "mcp"], enabled: true };
      config.skills = config.skills || {};
      config.skills.paths = [...(config.skills.paths || []), join(ROOT, "skills")];
    },
    "chat.message": async (input, output) => {
      const session = input.sessionID;
      const prompt = (output.parts || []).filter((p) => p.type === "text" && !p.synthetic).map((p) => p.text).join("\n");
      const parts = [];
      if (!started.has(session)) {
        started.add(session);
        const start = contextOf(ask({ hook_event_name: "SessionStart", session_id: session, source: "startup" }, cwd));
        if (start) parts.push(start);
      }
      const prompted = contextOf(ask({ hook_event_name: "UserPromptSubmit", session_id: session, prompt }, cwd));
      if (prompted) parts.push(prompted);
      turn.set(session, parts);
    },
    "experimental.chat.system.transform": async (input, output) => {
      const parts = input.sessionID ? turn.get(input.sessionID) : null;
      if (parts && parts.length > 0) output.system.push(...parts);
    },
    "tool.execute.before": async (input, output) => {
      const answer = ask({ hook_event_name: "PreToolUse", session_id: input.sessionID, ...toolEvent(input.tool, output.args) }, cwd);
      const specific = answer && answer.hookSpecificOutput;
      if (specific && specific.permissionDecision === "deny") {
        throw new Error(specific.permissionDecisionReason || "Pathrule refused this tool call.");
      }
      const context = contextOf(answer);
      if (context) beforeTool.set(input.callID, context);
    },
    "tool.execute.after": async (input, output) => {
      const before = beforeTool.get(input.callID);
      beforeTool.delete(input.callID);
      const after = contextOf(
        ask({ hook_event_name: "PostToolUse", session_id: input.sessionID, ...toolEvent(input.tool, input.args), tool_response: { output: output.output } }, cwd),
      );
      const added = [before, after].filter(Boolean);
      if (added.length > 0) output.output = `${output.output}\n\n${added.join("\n\n")}`;
    },
    event: async ({ event }) => {
      if (event && event.type === "session.idle") ask({ hook_event_name: "Stop", session_id: event.properties.sessionID }, cwd);
    },
  };
};

export default PathrulePlugin;
