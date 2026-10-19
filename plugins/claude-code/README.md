# Pathrule

The intelligence layer for your coding agents: path-scoped project memories, rules and skills delivered to the agent as it works.

This plugin is a thin adapter. Pathrule's runtime runs on your machine (Local, no account) or
against Pathrule Cloud; the plugin only connects your agent to it.

## Install

```
/plugin marketplace add pathrule/pathrule
/plugin install pathrule@pathrule
```

## Setup

Run `/pathrule:setup`. It shows a plan first and changes nothing until you approve it. When no
compatible Pathrule runtime is on this machine, the approved plan installs the exact runtime
version this plugin pins into `~/.pathrule/runtime`, with npm and without dependency install
scripts, and builds its one native module (SQLite).

`/pathrule:doctor` explains what this machine has.

From a terminal instead, `npx @pathrule/cli@1.0.5 integrations` runs the same setup: the same
plan, and nothing changes until you approve it.

## What this plugin runs, sends and stores

- Runs: Node.js 22.14 or later. Every hook event and the MCP server run
  `scripts/pathrule-launch` from this plugin, which hands the job to the Pathrule runtime
  installed on this machine, the one `~/.pathrule/bin/runtime.json` names: the `@pathrule/cli`
  package from npm, set up by `/pathrule:setup` after you approve its plan, or by you with npm or
  Homebrew. The plugin downloads and installs nothing itself.
- Stores: the runtime keeps its state in `~/.pathrule` (with Pathrule Local, your knowledge
  database too). A project you set up gets Pathrule's own files, `.pathrule/` and
  `.claude/rules/pathrule/`; `pathrule eject` removes them.
- Sends: Pathrule Local sends nothing off this machine. With Pathrule Cloud the runtime keeps your
  workspace's knowledge in sync with Pathrule Cloud (`cloud.pathrule.io`) under your account, and
  the agent's Pathrule tool calls go there; the hooks answer from the local copy. The CLI, the MCP
  server and the hooks send no analytics.

Privacy: https://pathrule.io/privacy-policy

License: Apache-2.0.
