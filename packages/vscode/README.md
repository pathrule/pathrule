# Pathrule: Context Layer for AI Coding Agents

**Your AI assistants forget. Pathrule remembers.**

Pathrule keeps your project's memories, rules and skills **scoped to paths** in your repository, and delivers the right ones into Claude Code, Copilot, Cursor, Codex and Windsurf **before the first tool call**. Store a decision once; every AI session working under that path receives it.

> Pathrule never reads or uploads your source code. It stores only what you author (memories, rules, skills) plus structural metadata.

## Start in under a minute, no account needed

1. Install the extension and open a folder.
2. Click **Pathrule: Set up** in the status bar → **Initialize locally**.
3. Select a few lines that capture a decision → **Pathrule: Save Selection as Memory**.
4. Run **Pathrule: Connect AI Clients**: MCP server registered, context hooks installed, zero JSON editing.

Local mode is free and fully offline: your knowledge lives in an embedded store on your machine, powered by Pathrule's open-source core.

## What you get

- **A knowledge map that follows you.** The Knowledge view shows where memories, rules and skills live in your repository, with theme-colored count badges in the Explorer. As you switch files, it follows you to the closest covered path: exactly the context your agent receives there.
- **Right-click anything.** Every file and folder in the Explorer gets a Pathrule menu: browse the knowledge an AI session there would receive (including what it inherits from parent paths), or scope a new memory, rule or skill in two keystrokes.
- **Memories, rules and skills as markdown tabs.** Click to open, edit with your whole editor toolkit, save to persist. Concurrent edits surface a conflict, never a silent overwrite.
- **One-command agent integration.** Copilot agent mode registers automatically; Claude Code, Cursor, Codex and Windsurf get managed MCP entries. **Check Integration** verifies everything end to end and tells you exactly what was written where.
- **Path-scoped by design.** A rule on `/apps/api` reaches every AI session under it, and never pollutes sessions elsewhere.

## Working with a team?

Sign in to connect a **cloud workspace**: memories, rules and skills sync to everyone, with version-aware writes and conflict detection. Team management and billing live on [pathrule.io](https://pathrule.io).

## Privacy & security

- Source code is never read, scanned or uploaded.
- The extension requires a trusted workspace (it writes agent integration files and spawns its MCP server).
- Cloud mode ships only publishable client keys; all authorization is enforced server-side.

Security disclosures: see [SECURITY.md](https://github.com/pathrule/pathrule/blob/main/SECURITY.md) or write to security@pathrule.io. General contact: hello@pathrule.io · privacy and data requests: privacy@pathrule.io.

## License

Apache-2.0. The path-scoped engine is open source: [pathrule/pathrule](https://github.com/pathrule/pathrule).
