// SPDX-License-Identifier: Apache-2.0
// Cursor cloud-driven renderer. Emits two files so Pathrule lights up on
// every Cursor version we know about:
//
//   1. `.cursor/rules/pathrule-protocol.mdc` — modern (Cursor 0.45+) auto-
//      loaded rule. Frontmatter sets `alwaysApply: true` so Cursor injects
//      Pathrule's protocol on every prompt.
//   2. `.cursorrules` — legacy single-file rule discovered by older Cursor
//      builds. Plain Markdown body, identical content modulo the
//      frontmatter wrapper.
//
// Both files are owned by Pathrule for sweep purposes — disabling Cursor
// removes them, regardless of which one the user originally adopted.

import { renderCwdGuardrail, renderProtocolBody } from "./body.js";
import { buildHookConfig, renderCursorHooks } from "../hook-supervisor/client-config-writer.js";
import { splicePromotedRulesSection } from "./promoted-rules-section.js";
import {
  appendRootKnowledgeSection,
  appendTeamContextSection,
  dirRelative,
  knowledgeOwnedPaths,
  renderKnowledgeFiles,
} from "./knowledge-files.js";
import type { ClientRendererSpec, MultiClientInput, RenderedFile } from "./types.js";

const MODERN_PATH = ".cursor/rules/pathrule-protocol.mdc";
const LEGACY_PATH = ".cursorrules";
const HOOKS_PATH = ".cursor/hooks.json";

function modernFrontmatter(): string {
  return [
    "---",
    'description: "Pathrule integration — workspace-shared memories, rules, and skills"',
    "alwaysApply: true",
    "---",
    "",
  ].join("\n");
}

/** Cursor's native path-scoped channel: glob-scoped .mdc rule files. */
const knowledgePath = (_dirPath: string, slug: string): string =>
  `.cursor/rules/pathrule-k-${slug}.mdc`;

function knowledgeFrontmatter(dirPath: string): string {
  return [
    "---",
    `description: "Pathrule knowledge for ${dirPath}"`,
    `globs: "${dirRelative(dirPath)}/**"`,
    "---",
    "",
  ].join("\n");
}

function renderCursor(input: MultiClientInput): RenderedFile[] {
  let body =
    renderProtocolBody(input, { toolLabel: "Cursor", mode: input.companionMode ?? "slim" }) +
    "\n" +
    renderCwdGuardrail("Cursor");

  // Inject promoted_rules section (client-neutral, same content as all other clients).
  if (input.promotedRules) {
    body = splicePromotedRulesSection(body, input.promotedRules, {
      headingLevel: 2,
      includeAttribution: true,
    });
  }
  // Native Knowledge Compilation — root knowledge rides the alwaysApply rule.
  body = appendRootKnowledgeSection(body, input);
  // Team context block last: keeps the cached prefix above it stable.
  body = appendTeamContextSection(body, input);

  const hooksBody = renderCursorHooks(buildHookConfig());
  return [
    { path: MODERN_PATH, body: modernFrontmatter() + body },
    { path: LEGACY_PATH, body },
    { path: HOOKS_PATH, body: hooksBody },
    // Per-directory knowledge as glob-scoped rules — Cursor attaches them
    // only when work touches matching paths.
    ...renderKnowledgeFiles(input, knowledgePath, (node, base) =>
      knowledgeFrontmatter(node.dir_path) + base,
    ),
  ];
}

function ownedPaths(input: MultiClientInput): string[] {
  return [MODERN_PATH, LEGACY_PATH, HOOKS_PATH, ...knowledgeOwnedPaths(input, knowledgePath)];
}

export const cursorRenderer: ClientRendererSpec = {
  id: "cursor",
  render: renderCursor,
  ownedPaths,
};
