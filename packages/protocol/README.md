# @pathrule/protocol

Pathrule's shared types and contracts: knowledge content, rule atoms, the hook index, workspace
shapes and the plugin contract versions. Types and pure helpers only: no I/O, no dependencies.
Every other Pathrule package builds on it.

## Install

```bash
npm install @pathrule/protocol
```

## What is in it

Modules are imported by path, for example `@pathrule/protocol/hook-index.js`.

- `content-types.js`, `node-types.js`, `workspace-types.js`: memories, rules, skills, nodes and
  workspaces.
- `rule-atoms.js`: the structured constraints a rule compiles to.
- `hook-index.js`: the index the Pathrule hook reads (`HookIndex`) and the hook event shapes.
- `routing-types.js`: context routing, subtree indexes and semantic candidates.
- `plugin-contracts.js`: the contract versions a CLI, MCP or host plugin is built against.
- `normalize-workspace-path.js`, `path-compare.js`, `knowledge-archive.js`: path helpers.

```ts
import { isArchivedKnowledgePath } from "@pathrule/protocol/knowledge-archive.js";

isArchivedKnowledgePath("/_archive/studio"); // true: kept as history, not delivered by default
```

## Versions and stability

The open packages (`protocol`, `agent-ir`, `core`, `integrations`, `mcp`, `host` and
`cli`) are released together with the same version. They are 0.x: an API can change between minor
versions. The supported product is the CLI, [`@pathrule/cli`](https://www.npmjs.com/package/@pathrule/cli);
these packages are for building with Pathrule.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
