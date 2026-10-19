# Architecture

Pathrule gives a coding agent the knowledge that applies to the code in front of it. Knowledge is
three kinds of item, each attached to a path of the project:

- a **memory**: something worth knowing, such as a decision, a convention or a pitfall;
- a **rule**: a constraint the agent must follow, compiled into structured atoms;
- a **skill**: a reusable procedure, delivered in the format each client reads.

A memory at `/apps/api` applies to everything under `apps/api/`. The closer a path is to the file
being worked on, the more specific its knowledge.

## The packages

```
protocol ── agent-ir ── core ──┬── integrations ──┐
                               ├── host ──────────┼── cloud ── cli ── vscode
                               └── mcp ───────────┘
```

| Package        | Role                                                                                                                                  | Depends on                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `protocol`     | Types and contracts every package shares, including the plugin contract versions. No I/O.                                             | nothing                                              |
| `agent-ir`     | The atom formats (constraints, checks, procedures, rationale, remedies, context, selection), compiled and rendered deterministically. | protocol                                             |
| `core`         | The `KnowledgeBackend` contract and its SQLite implementation, retrieval, and the tool handlers.                                      | protocol, agent-ir                                   |
| `integrations` | Everything written into an AI client: the hook and its index, instruction files, MCP entries, skills.                                 | protocol, core (peer)                                |
| `mcp`          | The MCP server: the knowledge tools over a `KnowledgeBackend`, on stdio.                                                              | protocol, agent-ir, core, host, integrations (peers) |
| `host`         | One local process per Pathrule home, shared by the CLI, the MCP server and the extension over a loopback RPC.                         | protocol, core, integrations (peers)                 |
| `cloud`        | The Pathrule Cloud client: sign-in, attached folders, and the MCP, host and hook plugins over a Cloud workspace.                      | protocol, agent-ir, core, integrations, mcp, host    |
| `cli`          | The `pathrule` command, and the composition of all of the above. npm's `@pathrule/cli` and `@pathrule/mcp` are bundles of it.         | all of the above                                     |
| `vscode`       | The VS Code extension. It carries the CLI bundle as its MCP server.                                                                   | core, host, integrations, cli sources                |

`core`, `integrations`, `mcp`, `host` and `cli` hold state the whole process must share (the
backend slot, write queues, plugin registries). Every distribution of the CLI (the two npm
packages, the standalone tarball, the copy in the VS Code extension) is one bundle, so a process
loads one copy of each.

## How knowledge reaches an agent

1. **Storage.** A workspace is a folder. Its knowledge lives in an SQLite database under
   `PATHRULE_HOME` (`~/.pathrule` by default), never in the project, and nothing in this repository
   sends it anywhere.
2. **The MCP server.** `pathrule mcp run` serves the folder's workspace on stdio. The agent calls
   `pathrule_get_context` with what it is about to do and gets the memories, rules and skills that
   apply to those paths; it writes new knowledge with `pathrule_write_memory`, `pathrule_write_rule`
   and `pathrule_write_skill`.
3. **The hook.** For Claude Code and Codex, `pathrule setup` installs `pathrule-hook.js` (Cursor,
   Copilot, Windsurf and other clients get the MCP server). On each prompt and tool call the hook reads a precomputed index, the
   hook index, and injects what applies before the agent acts. It has no dependencies and never
   opens the database, so it adds milliseconds, not seconds.
4. **Rule files Pathrule owns.** For Claude Code, knowledge also compiles into Pathrule's own
   `.claude/rules/pathrule/`, each file scoped to its paths and read at session start. Pathrule does
   not edit the person's `CLAUDE.md` or `AGENTS.md`; Codex's `AGENTS.md` gets a short region only
   where no hook can carry the protocol.
5. **The host.** The CLI, the MCP server and the extension share one local host process. It owns
   the stores, binds to loopback only, refuses browser origins, requires a per-start token readable
   only by you, and stops after ten minutes without use.

## Extension points

The CLI, the MCP server and the host accept plugins built against the contract versions in
`@pathrule/protocol/plugin-contracts.js`. A plugin adds commands, tools or host services; it cannot
change what the open packages do without it. The Pathrule Cloud client (`cloud`) is such a plugin.
The CLI carries it and loads it only when you choose Cloud (`pathrule setup --cloud`); until then
nothing contacts Pathrule Cloud, and everything here works without it. The VS Code extension
composes it for folders attached to a Cloud workspace. The Cloud service itself is proprietary and
is not in this repository.

The `KnowledgeBackend` contract in `core` is the storage seam: the SQLite `LocalBackend` and the
in-memory reference backend pass the same contract suite
(`packages/core/src/backend/contract-suite.ts`).

## Privacy

Pathrule does not read, scan or upload your source code. The CLI, MCP server, host and extension
built from this repository collect no telemetry and make no network request unless you ask for one:

- `pathrule update` reads the latest CLI version from `app.pathrule.io` (`PATHRULE_WEB_URL`
  points it elsewhere). Nothing checks for updates on its own.
- Semantic retrieval calls the embedding provider you configure, and nothing without one
  (`pathrule embeddings use`, or `PATHRULE_EMBEDDING_PROVIDER` with `PATHRULE_EMBEDDING_API_KEY`,
  `_MODEL`, `_BASE_URL` or `_ACCOUNT_ID`). `local` talks only to a loopback endpoint on your
  machine; `openai`, `voyage` and `cloudflare` receive memory and skill titles and bodies, and
  prompts as queries, under your own key, which is kept in a 0600 file under the Pathrule home.
  `pathrule embeddings status` says which applies.
