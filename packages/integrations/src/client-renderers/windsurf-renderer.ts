// SPDX-License-Identifier: Apache-2.0
// Windsurf cloud-driven renderer. Same dual-file shape as Cursor:
//
//   1. `.windsurf/rules/pathrule-protocol.md` — modern auto-loaded rule.
//      Plain Markdown (Windsurf doesn't surface a `.mdc` frontmatter
//      requirement in its public docs).
//   2. `.windsurfrules` — legacy single-file rule discovered by older
//      Windsurf builds. Identical body.

import { renderProtocolBody } from "./body.js";
import { splicePromotedRulesSection } from "./promoted-rules-section.js";
import {
  appendRootKnowledgeSection,
  appendTeamContextSection,
  knowledgeOwnedPaths,
  renderKnowledgeFiles,
} from "./knowledge-files.js";
import type { ClientRendererSpec, MultiClientInput, RenderedFile } from "./types.js";

const MODERN_PATH = ".windsurf/rules/pathrule-protocol.md";
const LEGACY_PATH = ".windsurfrules";

/** Windsurf auto-loads every file under .windsurf/rules/ — one per directory. */
const knowledgePath = (_dirPath: string, slug: string): string =>
  `.windsurf/rules/pathrule-k-${slug}.md`;

function renderWindsurf(input: MultiClientInput): RenderedFile[] {
  let body = renderProtocolBody(input, { toolLabel: "Windsurf", mode: input.companionMode ?? "slim" });

  // Inject promoted_rules section (client-neutral, same content as all other clients).
  if (input.promotedRules) {
    body = splicePromotedRulesSection(body, input.promotedRules, {
      headingLevel: 2,
      includeAttribution: true,
    });
  }
  // Native Knowledge Compilation — root knowledge rides the auto-loaded rule.
  body = appendRootKnowledgeSection(body, input);
  // Team context block last: keeps the cached prefix above it stable.
  body = appendTeamContextSection(body, input);

  return [
    { path: MODERN_PATH, body },
    { path: LEGACY_PATH, body },
    // Per-directory knowledge; the body heading names the directory it applies to.
    ...renderKnowledgeFiles(input, knowledgePath, (node, base) =>
      base.replace("# Project knowledge", `# Project knowledge (applies to ${node.dir_path})`),
    ),
  ];
}

function ownedPaths(input: MultiClientInput): string[] {
  return [MODERN_PATH, LEGACY_PATH, ...knowledgeOwnedPaths(input, knowledgePath)];
}

export const windsurfRenderer: ClientRendererSpec = {
  id: "windsurf",
  render: renderWindsurf,
  ownedPaths,
};
