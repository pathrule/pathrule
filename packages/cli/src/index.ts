// SPDX-License-Identifier: Apache-2.0
// The CLI's binary, the `pathrule` command of npm, Homebrew and the standalone tarball. Until the
// person chooses a mode it is the local CLI: the local store, local MCP, delivery into AI clients,
// and no account or telemetry. `pathrule setup --cloud` chooses Pathrule Cloud, which this CLI
// carries, and every run then loads it (capabilities/host.ts). The VS Code extension's copy
// (./editor-bin.ts) always composes it.
import { main } from "./main.js";

await main(process.argv.slice(2), { discoverPlugins: true });
