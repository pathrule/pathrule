# @pathrule/host

The Pathrule host: the one local process of a Pathrule home. It owns the local stores,
serves a loopback RPC to every Pathrule surface (the CLI, the MCP server, the VS Code extension) and
loads plugins when they are installed. It holds no intelligence of its own.

## Install

```bash
npm install @pathrule/host @pathrule/core @pathrule/integrations
```

Most people never start it directly: `pathrule host start`, `status` and `stop` manage it, and the
local commands start it when it is not running.

## Use

```ts
import { startHost } from "@pathrule/host/host.js";

const host = await startHost({ env: process.env, idleTimeoutMs: 10 * 60_000 });
```

The host binds to loopback, refuses browser origins and requires a per-start token kept in
`PATHRULE_HOME/host/host.json`, readable only by you. `createHostClient` in `client.js` connects to a
running host from that record.

## Versions and stability

The open packages (`protocol`, `agent-ir`, `core`, `integrations`, `mcp`, `host` and
`cli`) are released together with the same version. They are 0.x: an API can change between minor
versions. The supported product is the CLI, [`@pathrule/cli`](https://www.npmjs.com/package/@pathrule/cli);
these packages are for building with Pathrule.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
