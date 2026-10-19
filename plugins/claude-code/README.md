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

From a terminal instead, `npx @pathrule/cli@1.0.4 integrations` runs the same setup: the same
plan, and nothing changes until you approve it.

License: Apache-2.0.
