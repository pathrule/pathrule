# @pathrule/core

The context layer for AI coding agents: path-scoped memories, rules and skills, stored in an
embedded SQLite database on your machine. No account and no server: a workspace is a folder and its
knowledge lives under `PATHRULE_HOME` (`~/.pathrule` by default).

## Install

```bash
npm install @pathrule/core
```

`better-sqlite3` is a native dependency; npm installs a prebuilt binary for supported platforms.

## Use

```ts
import { LocalBackend } from "@pathrule/core";

const workspaceId = "my-workspace";
const store = LocalBackend.openForWorkspace(workspaceId, process.env);
store.registerWorkspace({ workspaceId, name: "my-app", localRootPath: process.cwd() });

const node = await store.ensureNodeForPath(workspaceId, "/src/api");
await store.writeMemory({
  workspaceId,
  nodeId: node.id,
  title: "Retries",
  content: "Retry twice with backoff, then dead-letter.",
});
store.close();
```

## What is in it

- `LocalBackend` (SQLite) and `InMemoryKnowledgeBackend` implement one `KnowledgeBackend`
  contract: nodes, memories, rules, skills, activity and context bundles.
- `tools/`: the handlers behind the MCP tools (`get_context`, reads and writes), usable without
  MCP.
- The knowledge compiler (what each folder's agent instruction file carries) and the hook index
  assembler.
- Optional semantic retrieval (`backend/embedding-adapter.ts`) with one of four providers: `local`
  (an embedding model on your machine behind a loopback OpenAI-compatible endpoint such as Ollama,
  no key), `openai` and `voyage` (your key), or `cloudflare` (your account id and API token). Each
  setting is read from `PATHRULE_EMBEDDING_PROVIDER`, `_API_KEY`, `_MODEL`, `_BASE_URL` (local),
  `_ACCOUNT_ID` (cloudflare) and `_TIMEOUT_MS` first, then from `embedding.json` and the key alone
  in `embedding-credentials.json` (both 0600) under the Pathrule home, which
  `pathrule embeddings use` writes. Every stored vector carries its space
  (`<provider>/<model>@<dims>#v<version>`) and only vectors of one space are compared. Without a
  provider, ranking stays lexical.

## Versions and stability

The open packages (`protocol`, `agent-ir`, `core`, `integrations`, `mcp`, `host` and
`cli`) are released together with the same version. They are 0.x: an API can change between minor
versions. The supported product is the CLI, [`@pathrule/cli`](https://www.npmjs.com/package/@pathrule/cli);
these packages are for building with Pathrule.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
