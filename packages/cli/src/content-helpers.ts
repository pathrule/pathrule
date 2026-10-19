// SPDX-License-Identifier: Apache-2.0
// Pure content-browsing contracts + helpers. Kept free of any backend
// dependency so the local `content --local` flow can reuse them without
// pulling in remote loaders. content.ts re-exports these, so other import
// paths keep working.

export type CliContentKind = "memory" | "rule" | "skill";

export interface CliContentOpenTarget {
  kind: "web";
  url: string;
  label: string;
  reason: "preferred" | "forced";
}

export interface CliContentItem {
  id: string;
  kind: CliContentKind;
  title: string;
  path: string | null;
  node_id: string | null;
  preview: string;
  updated_at: string | null;
  url: string;
  open_targets: CliContentOpenTarget[];
}

export interface CliContentReadResult extends CliContentItem {
  content: string;
}

export function normalizePathPrefix(path: string | null | undefined): string | null {
  if (!path) return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function pathMatches(path: string | null, prefix: string | null): boolean {
  if (!prefix) return true;
  if (!path) return false;
  return path === prefix || path.startsWith(`${prefix}/`);
}

// One implementation with the Local UI API's shared routes (Local Console and Pathrule Cloud).
export { clampLimit, preview, scoreItem } from "@pathrule/core/local-ui/workspace-routes.js";
