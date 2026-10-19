# Contributing to Pathrule

Thank you for your interest in Pathrule. This repository is Pathrule's open-source foundation: the
local knowledge store, retrieval, the MCP server, the hooks, the CLI and the VS Code extension.
Every Pathrule distribution is built on these packages, so a fix here reaches all of them.

This guide explains how to set up the repository, what a good change looks like and how a pull
request gets merged. By taking part, you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug.** Open a [bug report](https://github.com/pathrule/pathrule/issues/new?template=bug_report.yml)
  with the steps to reproduce it.
- **Suggest a feature.** Open a [feature request](https://github.com/pathrule/pathrule/issues/new?template=feature_request.yml).
  Describe the problem first, then the solution you have in mind.
- **Improve the documentation.** Fixes to the README, `docs/` and code comments are always welcome.
- **Send a fix or a feature.** For anything larger than a small fix, open an issue first so we can
  agree on the approach before you write the code.
- **Report a vulnerability.** Privately, never in a public issue. See [SECURITY.md](SECURITY.md).

Issues labelled [`good first issue`](https://github.com/pathrule/pathrule/labels/good%20first%20issue)
are a good place to start.

## Development setup

You need [Node.js](https://nodejs.org/) 22.14.0 or newer, [Git](https://git-scm.com/) and pnpm,
which [Corepack](https://nodejs.org/api/corepack.html) provides at the version `package.json` pins.
macOS, Linux and Windows are all supported.

```bash
git clone https://github.com/pathrule/pathrule.git
cd pathrule
corepack enable       # provides the pnpm version package.json pins
pnpm install          # Node.js 22.14.0 or later
pnpm typecheck
pnpm test
```

### Commands

| Command | What it does |
| --- | --- |
| `pnpm typecheck` | Type-checks every package. |
| `pnpm test` | Runs every package's tests. |
| `pnpm format` | Formats the repository with Prettier. `pnpm format:check` only checks. |
| `pnpm cli:bundle` | Builds a CLI you can run from any folder: `node artifacts/cli/dist/index.js`. |
| `node scripts/smoke-open-local.mjs` | After `pnpm cli:bundle`, runs the path the docs describe end to end: `pathrule setup --local`, the MCP server, and the hook delivering a memory. |
| `pnpm vscode:build` | Builds the VS Code extension into `packages/vscode/dist/` and runs its activation smoke test. |
| `pnpm build` | Builds each package for npm. Inside the repository the packages import each other's TypeScript sources, so you only need this to check a published build. |

`better-sqlite3` is a native module. Its npm package ships a prebuilt binary for each supported
platform, so nothing is compiled during `pnpm install` on macOS, Linux or Windows (x64 and arm64).

### Repository layout

| Package | What it holds |
| --- | --- |
| [`protocol`](packages/protocol) | Shared types and contracts. Types and pure helpers only, no I/O. |
| [`agent-ir`](packages/agent-ir) | The knowledge atom formats and their deterministic compile, render and delivery to agents. |
| [`core`](packages/core) | Path-scoped memories, rules and skills on an embedded SQLite store. |
| [`integrations`](packages/integrations) | Delivery into AI clients: the hook, instruction-file renderers and MCP installers. |
| [`mcp`](packages/mcp) | The local MCP server and its knowledge tools. |
| [`host`](packages/host) | The local engine process every Pathrule surface talks to. |
| [`ui`](packages/ui) | Design tokens and React components shared by the consoles. |
| [`local-console`](packages/local-console) | The accountless Local Console that `pathrule ui` serves. |
| [`cloud`](packages/cloud) | The open client of Pathrule Cloud: sign-in, attached folders and sync. The service itself is not in this repository. |
| [`cli`](packages/cli) | The `pathrule` command. |
| [`vscode`](packages/vscode) | The VS Code extension. |

## What makes a good change

- **Local and deterministic by default.** Everything here works with no account, no API key and no
  network. A capability that needs a key or a model is an optional adapter that falls back to the
  deterministic path when it is absent.
- **Keep the storage contract.** Behaviour of a `KnowledgeBackend` belongs in the contract suite
  (`packages/core/src/backend/contract-suite.ts`), so the SQLite backend and the in-memory reference
  stay identical. A change to a result shape is a breaking change: say so in the pull request.
- **Respect the user's files.** Pathrule writes into an AI client's instruction file only inside the
  region it owns and never touches the rest.
- **Test what you change.** A bug fix comes with a test that fails without it.
- **Explain why, not what.** Keep modules single-purpose and use comments for the reasons behind the
  code. Every source file starts with `// SPDX-License-Identifier: Apache-2.0`.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep the pull request focused on one change. Small pull requests are reviewed faster.
3. Add or update tests, and update the documentation when behaviour changes.
4. Run `pnpm typecheck`, `pnpm test` and `pnpm format:check` locally.
5. Give the pull request a [Conventional Commits](https://www.conventionalcommits.org/) title, for
   example `fix(core): keep rule order stable across reloads`.
6. Sign off every commit (see below), open the pull request and fill in the template.

CI runs the type check, the tests, the npm builds, the CLI end to end with no account and the VS Code
extension on Linux, macOS and Windows, with Node.js 22.14.0 and the current LTS. It also checks that
every commit is signed off. A maintainer reviews every pull request before it is merged.

### Commit titles

Release notes are built from commit titles, so they follow Conventional Commits. The scope is the
package name.

| Type | Use it for |
| --- | --- |
| `feat` | A new capability. |
| `fix` | A bug fix. |
| `perf`, `refactor` | Changes that keep behaviour the same. |
| `docs`, `test`, `chore`, `ci` | Documentation, tests, maintenance and CI. |

Mark a breaking change with `!` after the scope, for example `feat(core)!: ...`, and describe the
migration in the pull request.

## Developer Certificate of Origin

We use the [Developer Certificate of Origin](https://developercertificate.org/) (DCO) instead of a
contributor licence agreement. Signing off a commit certifies that you wrote it, or otherwise have
the right to submit it under the project's licence.

```bash
git commit -s -m "fix(core): ..."
```

This adds a `Signed-off-by: Your Name <you@example.com>` trailer that matches your Git identity. If
you forgot, sign off the commits already on your branch and push again:

```bash
git rebase --signoff main
git push --force-with-lease
```

A pull request with an unsigned commit cannot be merged.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
