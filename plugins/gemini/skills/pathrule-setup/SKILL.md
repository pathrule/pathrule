---
name: pathrule-setup
description: "Set up Pathrule on this machine: the runtime, Local or Cloud, and this project. Use when the user asks to set up, repair or check Pathrule, or when a Pathrule notice says it is not set up."
---

1. Run `node "<extension root>/scripts/pathrule-setup" plan` (add `--mode local` or `--mode cloud`, and
   `--scope project` when the user wants it for this project only).
2. Show the user every step of the plan.
3. Ask whether they want Pathrule Local (no account) or Pathrule Cloud (sign in) if they have not said.
4. Only after the user explicitly approves, run `node "<extension root>/scripts/pathrule-setup" apply --yes`
   with the same flags. Never pass `--yes` without approval, and never install anything yourself.
5. Report the result. Then tell the user to restart Gemini so the hooks and the MCP server start. The extension root is the directory two levels above this file (it holds `scripts/`).
