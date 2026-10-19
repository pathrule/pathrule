# @pathrule/integrations

Pathrule's delivery into AI clients: the hook script and the index it reads, the agent
instruction-file renderers (`AGENTS.md`, `CLAUDE.md`, Cursor and Copilot rules), the MCP installers
for each client and the skills materializer.

## Install

```bash
npm install @pathrule/integrations @pathrule/core
```

`@pathrule/core` is a peer dependency: the integrations write what a `KnowledgeBackend` holds.

## What is in it

Modules are imported by path, for example `@pathrule/integrations/index-writers/hook-index-writer.js`.

- `hook-supervisor/pathrule-hook.js`: the hook Claude Code, Codex, Cursor and Copilot run on
  prompts and tool calls. It has no dependencies and reads only its index.
- `index-writers/`: `syncHookIndex` writes that index from any `KnowledgeBackend`.
- `client-renderers/`: the instruction files per client, inside a Pathrule-owned region that never
  rewrites the rest of your file.
- `mcp-installers/`: add or remove the Pathrule MCP entry in each client's configuration.
- `skills/`: write skills into each client's skill folder.

## Versions and stability

The open packages (`protocol`, `agent-ir`, `core`, `integrations`, `mcp`, `host` and
`cli`) are released together with the same version. They are 0.x: an API can change between minor
versions. The supported product is the CLI, [`@pathrule/cli`](https://www.npmjs.com/package/@pathrule/cli);
these packages are for building with Pathrule.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
