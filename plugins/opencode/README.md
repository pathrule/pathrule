# Pathrule

The intelligence layer for your coding agents: path-scoped project memories, rules and skills delivered to the agent as it works.

This plugin is a thin adapter. Pathrule's runtime runs on your machine (Local, no account) or
against Pathrule Cloud; the plugin only connects your agent to it.

## Install

```
opencode plugin @pathrule/opencode --global
```

## Setup

Ask OpenCode to use the `pathrule-setup` skill. It shows a plan first and changes nothing until you
approve it. When no compatible Pathrule runtime is on this machine, the approved plan installs the
exact runtime version this plugin pins into `~/.pathrule/runtime`, with npm and without dependency
install scripts, and builds its one native module (SQLite).

From a terminal instead, `npx @pathrule/cli@1.0.6 integrations` runs the same setup: the same
plan, and nothing changes until you approve it.

## What this plugin runs, sends and stores

- Runs: Node.js 22.14 or later. At a prompt and after a file tool the plugin runs
  `scripts/pathrule-launch.cjs`, which hands the job to the Pathrule runtime installed on this machine;
  the MCP server runs the same way. The plugin downloads and installs nothing itself.
- Stores: the runtime keeps its state in `~/.pathrule` (with Pathrule Local, your knowledge
  database too). A project you set up gets Pathrule's own `.pathrule/` folder.
- Sends: Pathrule Local sends nothing off this machine. With Pathrule Cloud the runtime keeps your
  workspace's knowledge in sync with Pathrule Cloud (`cloud.pathrule.io`) under your account, and
  the agent's Pathrule tool calls go there. The CLI, the MCP server and the plugin send no analytics.

Privacy: https://pathrule.io/privacy-policy

License: Apache-2.0.
