// SPDX-License-Identifier: Apache-2.0
// GitHub Copilot MCP installers. Copilot is the one multi-config client: the
// Copilot CLI reads `~/.copilot/mcp-config.json` while Copilot in VS Code
// (agent mode without the Pathrule extension's McpServerDefinitionProvider)
// reads the user-profile `mcp.json`. Both are registered under the single
// `copilot` agent target; the registry returns them as an array and every
// consumer iterates. The cloud coding agent's MCP config lives in repo
// settings on github.com (no file or API to manage) — doctor surfaces it as
// a documented manual step instead.
//
// Schemas verified against the GitHub Copilot hooks capability spec.

import {
  defaultManagedEntryInfo,
  joinHomePath,
  type ClientInstaller,
  type ManagedMcpEntryInfo,
} from "./types.js";
import { makeJsonInstaller } from "./json-installer.js";

// Copilot CLI entry schema: `{ "type": "local", "command", "args", "env",
// "tools": ["*"] }` under a `mcpServers` root. `tools` is the per-server
// allowlist — `["*"]` enables every Pathrule tool.
const cliJson = makeJsonInstaller({
  includeTypeField: true,
  typeFieldValue: "local",
  entryExtras: { tools: ["*"] },
});

export const copilotCliInstaller: ClientInstaller = {
  id: "copilot",
  configLabel: "Copilot CLI",
  homeConfigPath(homedir: string, platform: NodeJS.Platform): string {
    return joinHomePath(platform, homedir, ".copilot", "mcp-config.json");
  },
  inject: cliJson.inject,
  remove: cliJson.remove,
  read: cliJson.read,
  getManagedEntry(existing: string | null): ManagedMcpEntryInfo {
    return defaultManagedEntryInfo(cliJson.read, existing);
  },
};

// VS Code user-profile `mcp.json`: root key is `servers` (NOT `mcpServers`)
// and the entry keeps `type: "stdio"`. Stable VS Code only in v1 —
// Insiders/VSCodium profile variants are documented out of scope.
const vscodeJson = makeJsonInstaller({ includeTypeField: true, rootKey: "servers" });

export const copilotVscodeInstaller: ClientInstaller = {
  id: "copilot",
  configLabel: "VS Code user config",
  homeConfigPath(homedir: string, platform: NodeJS.Platform): string {
    if (platform === "darwin") {
      return joinHomePath(platform, homedir, "Library", "Application Support", "Code", "User", "mcp.json");
    }
    if (platform === "win32") {
      return joinHomePath(platform, homedir, "AppData", "Roaming", "Code", "User", "mcp.json");
    }
    return joinHomePath(platform, homedir, ".config", "Code", "User", "mcp.json");
  },
  inject: vscodeJson.inject,
  remove: vscodeJson.remove,
  read: vscodeJson.read,
  getManagedEntry(existing: string | null): ManagedMcpEntryInfo {
    return defaultManagedEntryInfo(vscodeJson.read, existing);
  },
};
