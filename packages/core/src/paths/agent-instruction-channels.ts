// SPDX-License-Identifier: Apache-2.0
//
// Which files each coding agent reads as project instructions.
//
// Pathrule's promise is "write knowledge once, every agent gets it", and that
// promise is only as good as this table. It exists because the two lists it
// joins had drifted apart: Studio can RUN six engines (claude-code, codex,
// antigravity, grok, kimi, opencode) while Pathrule only wrote companion files
// for five TARGETS (claude-code, cursor, codex, windsurf, copilot). The overlap
// was two. Four engines Studio launches itself were getting Pathrule's knowledge
// only by accident: they read AGENTS.md, and AGENTS.md happens to exist when the
// `codex` target is enabled.
//
// `evidence` is deliberately part of the record. "measured" means a test in this
// repo observes the file reaching that agent; "documented" means the vendor
// documents the channel but we have not observed it; "inferred" means we are
// relying on the AGENTS.md convention and nothing more. Do not upgrade a value
// without adding the check that justifies it.
//
// Pure data plus helpers, no I/O.

export type ChannelEvidence = "measured" | "documented" | "inferred";

/** How several instruction files at different depths combine. */
export type InstructionPrecedence = "concatenate" | "nearest-wins";

export type PathScopedChannel =
  /** A file of the same name inside the directory, lazily loaded. */
  | { kind: "nested-file"; basename: string }
  /** Central directory of files whose frontmatter field scopes them by glob. */
  | { kind: "glob-frontmatter"; dir: string; extension: string; field: string }
  | null;

export interface AgentInstructionChannel {
  id: string;
  label: string;
  /** Files this agent natively loads as project instructions, most specific first. */
  reads: readonly string[];
  /** The agent's own path-scoped channel, when it has one. */
  pathScoped: PathScopedChannel;
  /** How the agent combines instruction files up the tree. */
  precedence: InstructionPrecedence;
  /** Whether Pathrule can bridge into this agent from another file it already writes. */
  bridgeFrom?: string;
  evidence: ChannelEvidence;
  /** Why the evidence level is what it is. */
  note: string;
}

export const AGENT_INSTRUCTION_CHANNELS: readonly AgentInstructionChannel[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    reads: ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md", ".claude/rules/*.md"],
    pathScoped: { kind: "nested-file", basename: "CLAUDE.md" },
    precedence: "concatenate",
    evidence: "measured",
    note: "Measured by scripts/engine-conformance.mjs: a canary in an anchored CLAUDE.md region came back verbatim (20.0 s). Nested CLAUDE.md is also exercised by brownfield-sync.test.ts. Claude Code does NOT read AGENTS.md; the documented bridge is an @AGENTS.md import.",
  },
  {
    id: "codex",
    label: "OpenAI Codex",
    reads: ["AGENTS.md"],
    pathScoped: { kind: "nested-file", basename: "AGENTS.md" },
    precedence: "nearest-wins",
    evidence: "measured",
    note: "Measured by scripts/engine-conformance.mjs: a canary in an anchored AGENTS.md region came back verbatim (7.3 s). Nested AGENTS.md is Codex's only path-scoped mechanism; a glob-scoped alternative is still an open request upstream.",
  },
  {
    id: "cursor",
    label: "Cursor",
    reads: [".cursor/rules/*.mdc", ".cursorrules"],
    pathScoped: {
      kind: "glob-frontmatter",
      dir: ".cursor/rules",
      extension: ".mdc",
      field: "globs",
    },
    precedence: "concatenate",
    evidence: "documented",
    note: "Pathrule owns its own .mdc filenames, so there is no collision with the user's rules; covered by the scenario matrix (Cursor-first repo). Cursor is an editor with no headless CLI, so the conformance probe cannot run it: file emission is tested, delivery is not observed.",
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    reads: [".github/copilot-instructions.md", ".github/instructions/*.instructions.md"],
    pathScoped: {
      kind: "glob-frontmatter",
      dir: ".github/instructions",
      extension: ".instructions.md",
      field: "applyTo",
    },
    precedence: "concatenate",
    evidence: "documented",
    note: "Pathrule-owned filenames with applyTo scoping. Files are emitted and asserted, but no test observes Copilot loading them.",
  },
  {
    id: "windsurf",
    label: "Windsurf",
    reads: [".windsurf/rules/*.md", ".windsurfrules"],
    pathScoped: null,
    precedence: "concatenate",
    evidence: "documented",
    note: "Pathrule-owned rule filenames. No frontmatter scoping surface is exposed, so knowledge rides the always-on rules file.",
  },
  {
    id: "antigravity",
    label: "Antigravity CLI",
    reads: ["AGENTS.md"],
    pathScoped: { kind: "nested-file", basename: "AGENTS.md" },
    precedence: "nearest-wins",
    bridgeFrom: "AGENTS.md",
    evidence: "inferred",
    note: "Studio runs this engine, but its CLI was not installed when the conformance probe last ran, so delivery is still only inferred from the AGENTS.md convention. Run scripts/engine-conformance.mjs antigravity to settle it.",
  },
  {
    id: "grok",
    label: "Grok",
    reads: ["AGENTS.md"],
    pathScoped: { kind: "nested-file", basename: "AGENTS.md" },
    precedence: "nearest-wins",
    bridgeFrom: "AGENTS.md",
    evidence: "measured",
    note: "Measured by scripts/engine-conformance.mjs: a canary token placed in an anchored AGENTS.md region came back verbatim (8.9 s). Studio runs this engine.",
  },
  {
    id: "kimi",
    label: "Kimi",
    reads: ["AGENTS.md"],
    pathScoped: { kind: "nested-file", basename: "AGENTS.md" },
    precedence: "nearest-wins",
    bridgeFrom: "AGENTS.md",
    evidence: "measured",
    note: "Measured by scripts/engine-conformance.mjs: a canary token placed in an anchored AGENTS.md region came back verbatim (11.0 s). Studio runs this engine.",
  },
  {
    id: "opencode",
    label: "OpenCode",
    reads: ["AGENTS.md"],
    pathScoped: { kind: "nested-file", basename: "AGENTS.md" },
    precedence: "nearest-wins",
    bridgeFrom: "AGENTS.md",
    evidence: "measured",
    note: "Measured by scripts/engine-conformance.mjs: a canary token placed in an anchored AGENTS.md region came back verbatim (14.6 s). Studio runs this engine.",
  },
];

export function instructionChannel(id: string): AgentInstructionChannel | null {
  return AGENT_INSTRUCTION_CHANNELS.find((c) => c.id === id) ?? null;
}

/** Does `emittedPaths` include at least one file this agent actually reads? */
export function coversAgent(id: string, emittedPaths: readonly string[]): boolean {
  const channel = instructionChannel(id);
  if (!channel) return false;
  return channel.reads.some((pattern) => emittedPaths.some((p) => matchesReadPattern(p, pattern)));
}

/** Match an emitted path against a `reads` entry, which may end in a `*` glob segment. */
export function matchesReadPattern(emitted: string, pattern: string): boolean {
  const path = emitted.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!pattern.includes("*")) {
    // A nested instruction file counts for its root entry: `pkg/a/AGENTS.md`
    // satisfies `AGENTS.md`, because the same channel carries both.
    const base = path.slice(path.lastIndexOf("/") + 1);
    return path === pattern || base === pattern;
  }
  const [dir, filePattern] = splitPattern(pattern);
  if (dir !== "" && !path.startsWith(`${dir}/`)) return false;
  const base = path.slice(path.lastIndexOf("/") + 1);
  const suffix = filePattern.replace(/^\*/, "");
  return base.endsWith(suffix) && base.length > suffix.length;
}

function splitPattern(pattern: string): [string, string] {
  const slash = pattern.lastIndexOf("/");
  return slash < 0 ? ["", pattern] : [pattern.slice(0, slash), pattern.slice(slash + 1)];
}
