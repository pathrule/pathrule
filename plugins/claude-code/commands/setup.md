---
description: Set up Pathrule on this machine (runtime, Local or Cloud, this project). Shows a plan first.
argument-hint: "[local|cloud] [project]"
---

Set up Pathrule for the user. Follow these steps exactly.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/pathrule-setup" plan` and add `--mode local` or `--mode cloud` and `--scope project` when
   the arguments ask for them: $ARGUMENTS
2. Show the user the plan it prints, step by step, in your own words, without leaving anything out.
3. If the user has not chosen, ask whether they want Pathrule Local (on this machine, no account)
   or Pathrule Cloud (sign in, shared with the team), and whether it is for all their projects
   (user) or only this one (project).
4. Only after the user explicitly approves the plan, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/pathrule-setup" apply --yes` with the same
   flags. Never pass `--yes` without that approval, and never run npm or install anything yourself.
5. Report what it printed. When it worked, tell the user to run `/reload-plugins` (or start a new
   session) so the hooks and the MCP server start, and repeat any `Next:` line it printed.
6. When it stopped, show the error and the `To fix it` line. Do not try workarounds.
