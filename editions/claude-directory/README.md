# Pathrule

The intelligence layer for your coding agents: path-scoped project memories, rules and skills delivered to the agent as it works.

## Setup

This edition connects to Pathrule Cloud through its remote MCP server. Sign in when Claude Code
asks (`/mcp` shows the server). It has no lifecycle hooks and runs nothing on your machine; for
Pathrule Local or hooks, install the full Pathrule plugin from the Pathrule marketplace,
[pathrule/pathrule](https://github.com/pathrule/pathrule).

## What this plugin sends and stores

- Sends: the agent's Pathrule tool calls go to Pathrule Cloud (`cloud.pathrule.io`) under your
  account. The plugin sends no analytics.
- Stores: nothing on your machine. Your workspace's knowledge stays in Pathrule Cloud.

Privacy: https://pathrule.io/privacy-policy

License: Apache-2.0.
