# Quickstart

Everything here runs on your machine, with no account: a workspace's knowledge lives in an SQLite
database under `~/.pathrule` (or `PATHRULE_HOME`), never in your project.

## 1. Build the CLI

You need Node.js 22.14.0 or later, pnpm 9 (`corepack enable` provides it) and Git.

```bash
git clone https://github.com/pathrule/pathrule.git
cd pathrule
pnpm install
pnpm cli:bundle
```

The CLI is now `artifacts/cli/dist/index.js`. It loads `better-sqlite3` from the repository's
`node_modules`, so keep it where it was built. An alias saves typing:

```bash
alias pathrule="node $PWD/artifacts/cli/dist/index.js"
```

## 2. Set up a project

From the project you want your agent to know about:

```bash
cd ~/code/my-project
pathrule setup --local --target claude
```

- `--local` keeps everything on this machine: no account, no network service, no model. The CLI's
  default for a new folder is Pathrule Cloud, so `--local` sets this folder up as Pathrule Local (at a
  terminal it asks whether for this project only or as the default for new folders);
  `pathrule config set default-mode local` makes Local the default for every new folder.
- `--target` is `claude`, `cursor`, `codex`, `windsurf` or `copilot`, or `all`.

Setup:

- creates a workspace for the folder, stored in `~/.pathrule/<workspace id>/pathrule.db`;
- registers the MCP server with the client (`~/.claude.json` for Claude Code), as
  `node .../index.js mcp run`; the server serves each folder from its own edition, here Local;
- installs the hook into `.claude/settings.local.json` (not the shared settings file), and the
  hook script into `~/.pathrule/bin/`;
- compiles the knowledge into Pathrule's own `.claude/rules/pathrule/`, leaves your `CLAUDE.md`
  and `AGENTS.md` as they are, and records every file it manages in
  `.pathrule/managed-files.json`.

Restart the client so it loads the MCP server.

## 3. Work with knowledge

Your agent writes knowledge through the MCP server, at the path it belongs to: ask it to remember a
decision, add a rule or save a skill, and it calls `pathrule_write_memory`, `pathrule_write_rule`
or `pathrule_write_skill`. Before it works on a part of the project, it calls
`pathrule_get_context`, and the hook delivers what applies when a prompt is about that part.

From the terminal:

```bash
pathrule memory list
pathrule memory read "Retries use exponential backoff"
pathrule rule list
pathrule skill list
pathrule search backoff
```

Add `--json` to any of them for machine-readable output.

## 4. Run the MCP server on its own

The server speaks MCP over stdio. Any MCP client can start it from the project folder:

```bash
cd ~/code/my-project
node ~/code/pathrule/artifacts/cli/dist/index.js mcp run
```

## 5. The VS Code extension

```bash
pnpm vscode:build
code --extensionDevelopmentPath="$PWD/packages/vscode"
```

The extension carries the same CLI as its MCP server, and shows the workspace's knowledge in the
Pathrule view.

## 6. Check that it all works

`node scripts/smoke-open-local.mjs` runs all of the above end to end in temporary directories:
setup, the MCP server writing and reading a memory, a rule and a skill, the CLI listing them, and
the hook delivering the memory.

## Remove Pathrule from a project

```bash
pathrule uninstall claude    # the MCP entry in the client's configuration
pathrule eject               # shows what it would remove from the project; --apply removes it
```

The knowledge itself stays in `~/.pathrule` until you delete it.
