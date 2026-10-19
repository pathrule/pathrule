<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/pathrule/pathrule/main/docs/assets/cli/banner-dark.png">
    <img src="https://raw.githubusercontent.com/pathrule/pathrule/main/docs/assets/cli/banner-light.png" alt="Pathrule CLI" width="560">
  </picture>
</p>

<h3 align="center">One command. Every agent remembers.</h3>

<p align="center">
  <code>pathrule</code> sets up the open-source knowledge layer for coding agents. One command wires your project into Claude Code, Codex, Cursor, GitHub Copilot and Windsurf. From then on, each agent gets the memories, rules and skills for the path it is about to touch, before it acts.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@pathrule/cli"><img alt="npm" src="https://img.shields.io/npm/v/@pathrule/cli?label=npm&color=2f6aa8"></a>
  <a href="https://github.com/pathrule/pathrule/blob/main/LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-1f7a4c"></a>
  <a href="#requirements"><img alt="Node.js 22.14.0 or newer" src="https://img.shields.io/badge/node-%E2%89%A522.14.0-5b6168"></a>
  <a href="https://github.com/pathrule/pathrule/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/pathrule/pathrule/ci.yml?branch=main&label=ci"></a>
</p>

<p align="center">
  <b>PathruleBench, 2,000 items:</b> 55% lower cost a chain · 2.7× fewer input tokens · 97% of memory probes passed · <a href="https://github.com/pathrule/benchmark">the numbers</a>
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> · <a href="#what-pathrule-setup-does">What setup does</a> · <a href="#commands">Commands</a> · <a href="#scripts-and-ci">Scripts and CI</a> · <a href="#privacy-and-security">Privacy</a> · <a href="https://www.pathrule.io/docs/start/quickstart">Docs</a> · <a href="https://github.com/pathrule/pathrule">GitHub</a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/pathrule/pathrule/main/docs/assets/cli/hero-dark.gif">
    <img src="https://raw.githubusercontent.com/pathrule/pathrule/main/docs/assets/cli/hero-light.gif" alt="A fresh folder with no account: pathrule setup --local wires Claude Code, pathrule doctor checks it, and a week later pathrule search finds the memory the agent saved." width="880">
  </picture>
</p>

<p align="center"><sub><i>A fresh folder, no account. Setup, a health check, and a week later the memory your agent saved, found from the terminal.</i></sub></p>

<p align="center">
  <a href="https://github.com/pathrule/pathrule"><img alt="Pathrule on GitHub: pathrule/pathrule" src="https://img.shields.io/badge/GitHub-pathrule%2Fpathrule-1f7a4c?style=for-the-badge&logo=github&logoColor=white"></a>
  <br>
  <sub>The CLI is the way in. See what your agents get, why it beats a CLAUDE.md file, and the numbers behind it.</sub>
</p>

## Quickstart

```bash
npm i -g @pathrule/cli
cd your-project
pathrule setup --local    # no account: knowledge stays on this machine
pathrule doctor           # see what each agent receives
```

Restart your agent. From the next session on, it gets the notes for the path it is about to touch, and saves new ones as it works: a decision you state, a lesson it should not have to learn twice.

Working with a team? Run `pathrule setup` without `--local`. It signs you in to Pathrule Cloud, finds or creates the workspace and attaches this folder, so every machine and every teammate gets the same knowledge.

## What `pathrule setup` does

| Step | What you get |
| --- | --- |
| Workspace | Creates or reuses this folder's workspace: on this machine with `--local`, in Pathrule Cloud without it. |
| MCP entry | Every agent you pick gets the Pathrule MCP server: `get_context` and the tools it uses to read and write knowledge. |
| Hooks | Claude Code and Codex get the notes for a path before they act: on session start, on each prompt and on file tools. |
| Pathrule's own files | Claude Code reads Pathrule's `.claude/rules/pathrule/` at session start, each file scoped to its paths. Every file Pathrule writes is listed in `.pathrule/managed-files.json`. Your `CLAUDE.md` and `AGENTS.md` are left as they are. |

Pick agents with `--target`: `claude-code`, `codex`, `cursor`, `copilot`, `windsurf` or `all`. Each one gets the same knowledge through the channel it supports:

| Agent | Before it acts | MCP |
| --- | --- | --- |
| Claude Code | Hooks, prompt hook included, and Pathrule's own `.claude/rules/pathrule/` | Local or Remote |
| Codex | Hooks, prompt hook included | Local or Remote |
| Cursor · GitHub Copilot · Windsurf | `get_context`, when the agent asks | Local |

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/pathrule/pathrule/main/docs/assets/readme/en/any-agent-dark.gif">
    <img src="https://raw.githubusercontent.com/pathrule/pathrule/main/docs/assets/readme/en/any-agent-light.gif" alt="Five agents, one memory: Claude Code, Codex, Cursor, GitHub Copilot and Windsurf each receive the same three notes through their own channel." width="880">
  </picture>
</p>

## Commands

Your agent writes knowledge, through the MCP server. The CLI sets things up, reads what was saved and tells you what each agent receives.

| | Commands |
| --- | --- |
| **Set up** | `setup` · `init` · `install <agent>` · `uninstall <agent>` · `attach` · `detach` · `sync` |
| **Read knowledge** | `search "<query>"` · `memory list` · `memory read "<title>" --print` · `rule …` · `skill …` · `ui` (Local Console on 127.0.0.1) |
| **Check** | `status` · `doctor` · `preflight` |
| **Runtime signals** | `instrument events`: the errors and events your app reported, and whether a fix was verified |
| **Cloud and team** | `login` · `logout` · `whoami` · `workspace` · `org` · `team` · `invite` · `billing` · `upgrade` · `activity` |
| **Maintenance** | `update` · `config` · `index` · `embeddings` · `topics` · `learning` · `me` · `host` |

Run `pathrule` on its own for the project home, and `pathrule help` for every command this build has.

## Scripts and CI

Four options work across the CLI:

| Option | Effect |
| --- | --- |
| `--json` | Stable, machine-readable output |
| `--yes` | Accepts prompts for supported mutating commands |
| `--no-open` | Opens no browser window |
| `--no-color` | Plain output |

```bash
pathrule setup --local --target claude-code --yes
pathrule doctor --json
pathrule search "api client" --json
```

## Requirements

Node.js 22.14.0 or newer, on macOS, Linux and Windows. Upgrade with `pathrule update` or `npm i -g @pathrule/cli@latest`.

- **Windows.** The CLI writes a `pathrule-hook.cmd` shim next to `pathrule-hook.js` in `%USERPROFILE%\.pathrule\bin\`, so agents that start hooks without a shell run the `.cmd` directly.
- **Proxies and custom CAs.** Set `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` or `NODE_EXTRA_CA_CERTS` before `pathrule install <agent>`. The CLI carries them into the managed MCP entry, so the MCP server your agent starts reaches Pathrule Cloud too.
- **State location.** Per-user state lives in `~/.pathrule`. Set `PATHRULE_HOME` to move it; `pathrule install` carries it into the MCP entry.

## Privacy and security

- **Your code stays yours.** Your source code stays on your machine. With `--local`, so does your knowledge: no account, no cloud.
- **No telemetry.** The CLI and the MCP server send no product telemetry, signed in to Pathrule Cloud or not. `pathrule telemetry` says so.
- **No background service.** The local host Pathrule's tools share starts when a command needs it and stops after ten minutes without use. It binds to loopback, refuses requests from browsers and requires a per-start token kept in `~/.pathrule/host/host.json`, readable only by you.
- **Cloud on your session.** Pathrule Cloud uses your user session, never an embedded service key, and enforces workspace permissions on every request.

Found a vulnerability? See the [security policy](https://github.com/pathrule/pathrule/blob/main/SECURITY.md).

## Learn more

- [Pathrule on GitHub](https://github.com/pathrule/pathrule): the whole open-source layer, the VS Code extension and the Local Console
- [PathruleBench](https://github.com/pathrule/benchmark): every condition, chain and check, and how to run it yourself
- [Docs](https://www.pathrule.io/docs/start/quickstart) · [Changelog](https://www.pathrule.io/changelog) · [Get help](https://github.com/pathrule/pathrule/blob/main/SUPPORT.md)

Apache-2.0. See [LICENSE](https://github.com/pathrule/pathrule/blob/main/LICENSE) and [NOTICE](https://github.com/pathrule/pathrule/blob/main/NOTICE).
