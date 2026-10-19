// SPDX-License-Identifier: Apache-2.0
// Windsurf MCP installer — writes to `~/.codeium/windsurf/mcp_config.json`.
// Schema is `mcpServers.<name>.{command,args,env}`; the public docs don't
// surface a `type` field, so we strip it on write to avoid drift if Windsurf
// ever tightens its schema.

import {
  defaultManagedEntryInfo,
  joinHomePath,
  type ClientInstaller,
  type ManagedMcpEntryInfo,
} from "./types.js";
import { makeJsonInstaller } from "./json-installer.js";

const json = makeJsonInstaller({ includeTypeField: false });

export const windsurfInstaller: ClientInstaller = {
  id: "windsurf",
  homeConfigPath(homedir: string, platform: NodeJS.Platform): string {
    return joinHomePath(platform, homedir, ".codeium", "windsurf", "mcp_config.json");
  },
  inject: json.inject,
  remove: json.remove,
  read: json.read,
  getManagedEntry(existing: string | null): ManagedMcpEntryInfo {
    return defaultManagedEntryInfo(json.read, existing);
  },
};
