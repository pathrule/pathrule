// SPDX-License-Identifier: Apache-2.0
// Pure node-path contracts, split out of nodes.ts so the core backends +
// local CLI can import them without dragging the database materialisation
// code (and its client-SDK dependency) into this shared export set.
// nodes.ts re-exports these — every existing import path keeps working.

import { isDirectoryLeafName, lastSegment } from "../paths/leaf-type.js";

import type { NodeType } from "@pathrule/protocol/node-types.js";

export interface MaterialisedNode {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  name: string;
  type: NodeType;
  relative_path: string;
}

/**
 * Normalises a caller-supplied path to the canonical workspace form:
 *   ""                -> "/"            (root)
 *   "/"               -> "/"
 *   "apps/mobile"     -> "/apps/mobile"
 *   "/apps/mobile/"   -> "/apps/mobile"
 *   "//apps"          -> "/apps"        (legacy double-slash tolerance)
 */
export function normalizeNodePath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "/") return "/";
  const withLead = trimmed.startsWith("/") ? trimmed : "/" + trimmed;
  const collapsed = withLead.replace(/\/+/g, "/");
  return collapsed === "/" ? "/" : collapsed.replace(/\/$/, "");
}

/**
 * Leaf classification. Delegates to the shared classifier in @pathrule/core so
 * node materialisation, knowledge compilation, and the client renderers can
 * never disagree about what a directory is.
 *
 * The rule it replaced was `\.[A-Za-z0-9]{1,8}$`, an extension-length test born
 * of web/TS naming that called `.gitignore`, `MyApp.entitlements`,
 * `Main.storyboard`, and `gradle.properties` folders, i.e. it failed on
 * essentially every iOS and Android repo.
 */
export function guessLeafType(relativePath: string): NodeType {
  return isDirectoryLeafName(lastSegment(relativePath)) ? "folder" : "file";
}
