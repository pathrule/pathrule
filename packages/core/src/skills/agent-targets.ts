// SPDX-License-Identifier: Apache-2.0
//
// Agent target registry — which external coding agents Pathrule knows how to
// materialize skills for. V1 ships the Claude Code adapter only; new entries
// plug in by appending to AGENT_TARGETS.
//
// Browser-safe: no fs/path imports. The materializer (Node-only) consumes
// these records and does the disk writes.

export type AgentTargetId = "claude-code" | "cursor" | "windsurf" | "codex" | "copilot";

export interface AgentTargetSpec {
  /** Stable id stored in workspaces.active_agent_targets. */
  id: AgentTargetId;
  /** Human-facing label for Settings UI + toasts. */
  label: string;
  /** Workspace-relative directory that holds per-skill subfolders. */
  skillsDir: string;
  /** Prior locations that may still contain user-authored files. Discovery can
   *  warn about them, but materialization and cleanup must never write/delete
   *  through these paths. */
  legacySkillsDirs?: readonly string[];
  /** Workspace-relative marker file whose presence auto-detects the agent. */
  detectFile: string;
  /** Whether the materializer is implemented for this target. */
  supported: boolean;
  /**
   * Targets whose skillsDir this agent ALSO reads natively. When any of them
   * is active alongside this target, the materializer skips this target's own
   * skillsDir so the agent doesn't see every skill twice (e.g. GitHub Copilot
   * discovers `.claude/skills` on its own, so an active claude-code target
   * already satisfies Copilot's skill delivery).
   */
  skillsSatisfiedBy?: readonly AgentTargetId[];
}

export const AGENT_TARGETS: Record<AgentTargetId, AgentTargetSpec> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    skillsDir: ".claude/skills",
    detectFile: ".claude",
    supported: true,
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    skillsDir: ".cursor/skills",
    detectFile: ".cursor",
    supported: true,
  },
  windsurf: {
    id: "windsurf",
    label: "Windsurf",
    skillsDir: ".windsurf/skills",
    detectFile: ".windsurf",
    supported: true,
  },
  codex: {
    id: "codex",
    label: "Codex",
    skillsDir: ".agents/skills",
    legacySkillsDirs: [".codex/skills"],
    detectFile: ".codex",
    supported: true,
  },
  copilot: {
    id: "copilot",
    label: "GitHub Copilot",
    skillsDir: ".github/skills",
    detectFile: ".github/copilot-instructions.md",
    supported: true,
    skillsSatisfiedBy: ["claude-code"],
  },
};

export const DEFAULT_ACTIVE_AGENT_TARGETS: AgentTargetId[] = ["claude-code"];

export function getAgentTargetSpec(id: string): AgentTargetSpec | null {
  return (AGENT_TARGETS as Record<string, AgentTargetSpec>)[id] ?? null;
}

export function filterSupportedTargets(ids: string[]): AgentTargetSpec[] {
  const out: AgentTargetSpec[] = [];
  for (const id of ids) {
    const spec = getAgentTargetSpec(id);
    if (spec && spec.supported) out.push(spec);
  }
  return out;
}

/**
 * Supported targets that should actually receive skill writes: drops any
 * target whose `skillsSatisfiedBy` set intersects the active targets. The
 * materializer's existing teardown loop then removes a previously written
 * skillsDir when a satisfying target becomes active later.
 */
export function filterEffectiveSkillTargets(ids: string[]): AgentTargetSpec[] {
  const supported = filterSupportedTargets(ids);
  const active = new Set(supported.map((spec) => spec.id));
  return supported.filter(
    (spec) => !(spec.skillsSatisfiedBy ?? []).some((other) => active.has(other)),
  );
}
