# Pathrule

The intelligence layer for your coding agents: path-scoped project memories, rules and skills delivered to the agent as it works.

This plugin is a thin adapter. Pathrule's runtime runs on your machine (Local, no account) or
against Pathrule Cloud; the plugin only connects your agent to it.

## Install

```
codex plugin marketplace add pathrule/pathrule --sparse .agents --sparse plugins/codex
codex plugin add pathrule@pathrule
```

## Setup

Ask Codex to use the `pathrule-setup` skill. It shows a plan first and changes nothing until you
approve it. Setup adds Pathrule's hook entries to your Codex hooks; Codex runs them only after you
trust them: it asks you to review new hooks when your next session starts, and `/hooks` shows them
at any time. Until then Pathrule works through its MCP tools and skills.

From a terminal instead, `npx @pathrule/cli@1.0.2 integrations` runs the same setup: the same
plan, and nothing changes until you approve it.

License: Apache-2.0.
