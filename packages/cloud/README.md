# @pathrule/cloud

The open client of [Pathrule Cloud](https://www.pathrule.io/products/cloud). It is what the
`pathrule` CLI, its MCP server, the hook and the VS Code extension run when a folder works with a
Pathrule Cloud workspace:

- **Account:** sign-in with the device flow, the session on this machine, organizations and
  workspaces (`src/native/credentials.ts`, `src/native/tenancy.ts`).
- **Attached folders:** which folder on this machine belongs to which Cloud workspace, and the
  automatic attach of a folder that already belongs to one (`src/native/workspaces.ts`,
  `src/native/auto-attach.ts`).
- **The MCP server and the host over a Cloud workspace:** the account edition of the open MCP server
  and host, backed by the Cloud's project API (`src/mcp/plugin.ts`, `src/native/composition.ts`,
  `src/native/client/*`).
- **The hook's cloud extension:** prompt ranking over the workspace's hosted index and local
  telemetry files (`src/hook-supervisor/pathrule-hook-cloud.cjs`, `cloud-semantic-query.cjs`).
- **Delivery reports and telemetry:** counts of the knowledge delivered on this machine, and the
  opt-in product telemetry of the CLI (`src/native/delivery-reporter.ts`, `src/cli/telemetry.ts`).

It talks to Pathrule Cloud only through its public API at `https://cloud.pathrule.io`; every request
is authorized there. The Pathrule Cloud service itself (storage, hosted search, the model tier,
Team Intelligence, billing) is proprietary and is not part of this package or this repository.

This package is not published on its own: the `pathrule` CLI carries it.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The Pathrule name and logo are not
licensed under the Apache License.
