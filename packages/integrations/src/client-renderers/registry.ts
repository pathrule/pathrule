// SPDX-License-Identifier: Apache-2.0
// Single-source registry of renderers. New clients slot in by appending
// here; the multi-client orchestrator iterates this map.

import type { AgentTargetId } from "@pathrule/core/skills/agent-targets.js";
import { claudeKnowledgeRenderer } from "./claude-knowledge-renderer.js";
import { codexRenderer } from "./codex-renderer.js";
import { copilotRenderer } from "./copilot-renderer.js";
import { cursorRenderer } from "./cursor-renderer.js";
import { windsurfRenderer } from "./windsurf-renderer.js";
import type { ClientRendererSpec } from "./types.js";

/**
 * `claude-code` here is the KNOWLEDGE-ONLY renderer (Native Knowledge
 * Compilation): `.claude/rules/pathrule-knowledge.md` + per-directory
 * CLAUDE.md files. The root CLAUDE.md still renders through the dedicated
 * `claude-md-project.ts` + `project-claude-md.ts` pipeline so the Hook
 * Supervisor's CLAUDE.md ownership stays untouched.
 */
export const RENDERERS: Partial<Record<AgentTargetId, ClientRendererSpec>> = {
  "claude-code": claudeKnowledgeRenderer,
  cursor: cursorRenderer,
  codex: codexRenderer,
  windsurf: windsurfRenderer,
  copilot: copilotRenderer,
};

export function getRenderer(id: AgentTargetId): ClientRendererSpec | null {
  return RENDERERS[id] ?? null;
}

export type { ClientRendererSpec, MultiClientInput, RenderedFile } from "./types.js";
export { renderProtocolBody } from "./body.js";
