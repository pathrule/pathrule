// SPDX-License-Identifier: Apache-2.0
// GitHub Copilot cloud-driven renderer. One repo-level `.github/` file set
// feeds all three Copilot surfaces (VS Code agent mode, Copilot CLI, cloud
// coding agent):
//
//   1. `.github/copilot-instructions.md` — auto-applied repo-wide
//      instructions; carries the full Pathrule protocol body.
//   2. `.github/instructions/pathrule.instructions.md` — `applyTo: "**"`
//      scoped instructions file. A short pointer (not a body copy) so the
//      protocol stays attached in nested/glob-matched contexts without
//      duplicating content in Copilot's context assembly.
//   3. `.github/hooks/pathrule.json` — hook config (camelCase Copilot CLI
//      format; VS Code converts event names to PascalCase, the cloud agent
//      reads `.github/hooks/*.json` as its only hook source).

import { renderCwdGuardrail, renderProtocolBody } from "./body.js";
import { buildHookConfig, renderCopilotHooks } from "../hook-supervisor/client-config-writer.js";
import { splicePromotedRulesSection } from "./promoted-rules-section.js";
import {
  appendRootKnowledgeSection,
  appendTeamContextSection,
  dirRelative,
  knowledgeOwnedPaths,
  renderKnowledgeFiles,
} from "./knowledge-files.js";
import type { ClientRendererSpec, MultiClientInput, RenderedFile } from "./types.js";

const INSTRUCTIONS_PATH = ".github/copilot-instructions.md";
const SCOPED_PATH = ".github/instructions/pathrule.instructions.md";
const HOOKS_PATH = ".github/hooks/pathrule.json";

/** Copilot's native path-scoped channel: applyTo-scoped instructions files. */
const knowledgePath = (_dirPath: string, slug: string): string =>
  `.github/instructions/pathrule-k-${slug}.instructions.md`;

function knowledgeFrontmatter(dirPath: string): string {
  return ["---", `applyTo: "${dirRelative(dirPath)}/**"`, "---", ""].join("\n");
}

function scopedPointerBody(): string {
  return [
    "---",
    'applyTo: "**"',
    "---",
    "",
    "<!-- Pathrule managed — do not edit; cloud state is authoritative. -->",
    "",
    "# Pathrule integration",
    "",
    "This workspace uses Pathrule as its shared memory, rule, and skill layer.",
    "Follow the protocol in `.github/copilot-instructions.md`; it applies to every",
    "file in this repository.",
    "",
  ].join("\n");
}

function renderCopilot(input: MultiClientInput): RenderedFile[] {
  let body =
    renderProtocolBody(input, { toolLabel: "GitHub Copilot", mode: input.companionMode ?? "slim" }) +
    "\n" +
    renderCwdGuardrail("Copilot");

  // Inject promoted_rules section (client-neutral, same content as all other clients).
  if (input.promotedRules) {
    body = splicePromotedRulesSection(body, input.promotedRules, {
      headingLevel: 2,
      includeAttribution: true,
    });
  }

  // Native Knowledge Compilation — root knowledge rides the repo-wide file.
  body = appendRootKnowledgeSection(body, input);
  // Team context block last: keeps the cached prefix above it stable.
  body = appendTeamContextSection(body, input);

  const hooksBody = renderCopilotHooks(buildHookConfig());
  return [
    { path: INSTRUCTIONS_PATH, body },
    { path: SCOPED_PATH, body: scopedPointerBody() },
    { path: HOOKS_PATH, body: hooksBody },
    // Per-directory knowledge via applyTo-scoped instructions files.
    ...renderKnowledgeFiles(input, knowledgePath, (node, base) =>
      knowledgeFrontmatter(node.dir_path) + base,
    ),
  ];
}

function ownedPaths(input: MultiClientInput): string[] {
  return [INSTRUCTIONS_PATH, SCOPED_PATH, HOOKS_PATH, ...knowledgeOwnedPaths(input, knowledgePath)];
}

export const copilotRenderer: ClientRendererSpec = {
  id: "copilot",
  render: renderCopilot,
  ownedPaths,
};
