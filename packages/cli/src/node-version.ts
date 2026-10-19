// SPDX-License-Identifier: Apache-2.0
// Side-effect-free Node version gate used by the CLI bin entrypoint.
// Imported by `mcp run` BEFORE the heavy runtime modules so a too-old Node
// fails cleanly without writing anything to stdout.

export const MIN_NODE_VERSION = "22.14.0";

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemver(version: string): ParsedSemver | null {
  // Strip leading "v" and any pre-release/build suffix; node-style runtimes
  // never include build metadata but Bun/Deno polyfills sometimes do.
  const stripped = version.replace(/^v/, "").split(/[-+]/, 1)[0] ?? "";
  const parts = stripped.split(".");
  if (parts.length < 3) return null;
  const [maj, min, pat] = parts;
  const major = Number(maj);
  const minor = Number(min);
  const patch = Number(pat);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) {
    return null;
  }
  return { major, minor, patch };
}

export function isNodeVersionSupported(
  current: string = process.versions.node,
  min: string = MIN_NODE_VERSION,
): boolean {
  const cur = parseSemver(current);
  const required = parseSemver(min);
  if (!cur || !required) return true; // Unknown runtime — let it through.
  if (cur.major !== required.major) return cur.major > required.major;
  if (cur.minor !== required.minor) return cur.minor > required.minor;
  return cur.patch >= required.patch;
}

export interface NodeVersionFailure {
  code: "node_version_unsupported";
  required: string;
  current: string;
  message: string;
}

export function nodeVersionFailure(): NodeVersionFailure {
  return {
    code: "node_version_unsupported",
    required: MIN_NODE_VERSION,
    current: process.versions.node,
    message: `Pathrule CLI requires Node.js ${MIN_NODE_VERSION} or newer. Current: ${process.versions.node}.`,
  };
}
