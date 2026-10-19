// SPDX-License-Identifier: Apache-2.0
// Whether a managed MCP entry can still be launched: the files it names exist. Node-only, unlike the
// installers (./types.ts is browser-safe), so the doctor and repair of a Node surface call it.
//
// An entry outlives what it points at. Studio's runs its own executable and the server inside its
// app bundle, so uninstalling Studio leaves every client's entry pointing at files that are gone; an
// upgrade of Node or of an extension does the same to a CLI's or VS Code's entry. The client then
// fails to start Pathrule and says little about why.
import { existsSync } from "node:fs";

import type { ManagedMcpEntryInfo } from "./types.js";

/** POSIX, Windows drive or UNC. A bare command (`node`) is looked up on PATH and is not checked. */
function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/**
 * The files of `info`'s launch target that do not exist: its command when that is a path, and its
 * script (the first argument that is an absolute path to a .js, .cjs or .mjs file).
 */
export function missingLaunchFiles(
  info: ManagedMcpEntryInfo,
  exists: (path: string) => boolean = existsSync,
): string[] {
  if (!info.present) return [];
  const files: string[] = [];
  if (info.launchCommand && isAbsolutePath(info.launchCommand)) files.push(info.launchCommand);
  const script = info.launchArgs.find((arg) => isAbsolutePath(arg) && /\.[cm]?js$/.test(arg));
  if (script) files.push(script);
  return files.filter((file) => !exists(file));
}

/**
 * `info` with `staleReason: "missing-file"` when its launch target is gone. A reason the installer
 * already found is kept: it is the more specific one.
 */
export function withLaunchCheck(
  info: ManagedMcpEntryInfo,
  exists: (path: string) => boolean = existsSync,
): ManagedMcpEntryInfo {
  if (!info.present || info.staleReason) return info;
  return missingLaunchFiles(info, exists).length > 0
    ? { ...info, staleReason: "missing-file" }
    : info;
}
