# @pathrule/mcp

Pathrule's MCP server on stdio, for any AI client that speaks the Model Context Protocol. It serves
the knowledge tools (`pathrule_get_context`, `pathrule_resolve`, `pathrule_read_memory`,
`pathrule_write_memory` and the rest) over the local store on your machine, or over your Pathrule
Cloud workspace once you choose Cloud with `pathrule setup`.

## Use

Register it with your client as a stdio server:

```json
{
  "mcpServers": {
    "pathrule": { "command": "npx", "args": ["-y", "@pathrule/mcp"] }
  }
}
```

or install it once and run `pathrule-mcp`:

```bash
npm i -g @pathrule/mcp
```

Most people do not need this package: the CLI, [`@pathrule/cli`](https://www.npmjs.com/package/@pathrule/cli),
registers the same server with Claude Code, Cursor, Codex and Windsurf (`pathrule install <client>`)
and keeps their hooks and instructions in sync.

`@pathrule/mcp` is `pathrule mcp run` of the same CLI, released with it at the same version. Logs go
to stderr, so stdout stays JSON-RPC.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
