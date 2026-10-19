---
name: pathrule-setup
description: Set up Pathrule on this machine: the runtime, Local or Cloud, and this project. Use when the user asks to set up, repair or check Pathrule, or when a Pathrule notice says it is not set up.
---

The Pathrule plugin root is the directory two levels above this file (it holds `scripts/`).

1. Run `sh "<plugin root>/scripts/pathrule-setup" plan` (add `--mode local` or `--mode cloud`, and
   `--scope project` when the user wants it for this project only).
2. Show the user every step of the plan.
3. Ask whether they want Pathrule Local (no account) or Pathrule Cloud (sign in) if they have not said.
4. Only after the user explicitly approves, run `sh "<plugin root>/scripts/pathrule-setup" apply --yes`
   with the same flags. Never pass `--yes` without approval, and never install anything yourself.
5. Report the result. Then tell the user to start a new Codex session: Codex asks them to review
   Pathrule's new hooks then (and `/hooks` shows them at any time), and runs them only after they
   trust them. Without trusted hooks Pathrule still works through its MCP tools and skills.
