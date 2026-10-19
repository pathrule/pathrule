# Installing Pathrule's MCP server

These steps are for an AI agent that installs MCP servers for its user (Cline and others). Pathrule
gives a coding agent the project's path-scoped memories, rules and skills, and tools to read, search
and save them.

## Requirements

- Node.js 22.14 or later (`node --version`).

## Add the server

Add this entry to the agent's MCP settings:

```json
{
  "mcpServers": {
    "pathrule": {
      "command": "npx",
      "args": ["-y", "@pathrule/mcp"]
    }
  }
}
```

No API key or environment variable is needed. The server serves each project from its own edition:

- **Pathrule Local** (on this machine, no account): the user runs `npx -y @pathrule/cli setup --local`
  in the project once.
- **Pathrule Cloud** (shared with a team): the user runs `npx -y @pathrule/cli setup` in the project
  and signs in when it asks. Never sign in or enter credentials on the user's behalf.

Until a project is set up, the tools answer with the setup step the user needs.

## Remote alternative

An agent that supports remote MCP servers can use Pathrule Cloud's hosted server instead, with no
local process: `https://cloud.pathrule.io/mcp` (streamable HTTP, OAuth sign-in in the browser).

## Check it

Ask the agent to call `pathrule_get_context` with the current folder. It returns the project's
context, or the setup step to run.
