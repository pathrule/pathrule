// SPDX-License-Identifier: Apache-2.0
// Cursor MCP installer — writes to `~/.cursor/mcp.json`. Schema mirrors the
// Claude shape (`mcpServers.<name>.{type,command,args,env}`); Cursor's stdio
// docs require an explicit `type: "stdio"` field, so we keep it.

import {
  defaultManagedEntryInfo,
  joinHomePath,
  type ClientInstaller,
  type ManagedMcpEntryInfo,
} from "./types.js";
import { makeJsonInstaller } from "./json-installer.js";

const json = makeJsonInstaller({ includeTypeField: true });

export const cursorInstaller: ClientInstaller = {
  id: "cursor",
  homeConfigPath(homedir: string, platform: NodeJS.Platform): string {
    // Cursor uses the same relative path on every OS that ships the desktop
    // app; only the separator differs between Windows and POSIX hosts.
    return joinHomePath(platform, homedir, ".cursor", "mcp.json");
  },
  inject: json.inject,
  remove: json.remove,
  read: json.read,
  getManagedEntry(existing: string | null): ManagedMcpEntryInfo {
    return defaultManagedEntryInfo(json.read, existing);
  },
};
