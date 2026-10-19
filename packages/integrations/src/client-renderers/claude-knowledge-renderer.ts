// SPDX-License-Identifier: Apache-2.0
// Claude Code knowledge renderer — Native Knowledge Compilation only.
//
// Writes no file the person owns: never the root CLAUDE.md, never a directory's CLAUDE.md. It emits
// only into Pathrule's own names, which Claude Code auto-loads as project instructions:
//
//   1. `.claude/rules/pathrule-knowledge.md` — root-scoped knowledge, when no hook delivers it.
//   2. `.claude/rules/pathrule/` — the path-scoped rules: `workspace.md` at session start and one file
//      per area with `paths: ["<area>/**"]`, loaded when work enters that area.
//
// The CLAUDE.md paths stay in `ownedPaths` so a sync takes back what an earlier Pathrule put there.

import {
  KNOWLEDGE_BANNER,
  appendTeamContextSection,
  dirRelative,
  knowledgeSlug,
  knowledgeFileBody,
  knowledgeOwnedPaths,
  renderKnowledgeFiles,
  rootKnowledge,
} from "./knowledge-files.js";
import { renderTeamContextBlock } from "./team-context-block.js";
import type { ClientRendererSpec, MultiClientInput, RenderedFile } from "./types.js";

const ROOT_KNOWLEDGE_PATH = ".claude/rules/pathrule-knowledge.md";
const ROOT_KNOWLEDGE_TITLE = "# Workspace knowledge (Pathrule)";

/**
 * Where an earlier Pathrule put a directory's knowledge: that directory's own CLAUDE.md, a file the
 * person owns. Kept only so the sweep takes those regions back out; nothing is written there now.
 */
const legacyKnowledgePath = (dirPath: string, _slug: string): string =>
  `${dirRelative(dirPath)}/CLAUDE.md`;

function renderClaudeKnowledge(input: MultiClientInput): RenderedFile[] {
  // Signature mode: write nothing into the user's tree.
  //
  // The measured complaint was never the token cost — it was 26 Pathrule-authored
  // files across 13 directories of a checkout the team owns. Removing the
  // protocol copy alone left 25 of them, because this renderer never read
  // `companionMode`: signature ON and OFF produced byte-identical output.
  //
  // Returning no files while `ownedPaths` stays complete is what makes the
  // removal happen rather than merely stopping: disk-writer sweeps every owned
  // path this run did not emit, and it already refuses to delete a file without a
  // Pathrule marker and retracts only the region from one the user shares. The
  // alternative — narrowing ownedPaths too — is how `pathrule-protocol.md` ended
  // up needing its own bespoke remover.
  //
  // What the files carried still reaches the agent: knowledge through the hook's
  // per-prompt selection (measured 2026-09-01: +673 tokens over 20 turns, +5%,
  // because the hook was already ranking the same items), and the team context
  // block through the hook index, which is where `index.team_context` comes from.
  if (input.companionMode === "signature") return input.rulesFiles === false ? [] : renderBindingRules(input);

  const files: RenderedFile[] = [];
  const root = rootKnowledge(input);
  if (root) {
    files.push({
      path: ROOT_KNOWLEDGE_PATH,
      // Team context rides the same turn-zero file, appended last so the
      // knowledge above it stays byte-identical for the prompt cache.
      body: appendTeamContextSection(knowledgeFileBody(root, ROOT_KNOWLEDGE_TITLE), input),
    });
  } else if (renderTeamContextBlock(input.teamContext)) {
    // A workspace can have team context and no compiled root knowledge yet.
    // The block still has to reach turn zero, so the file carries it alone.
    files.push({
      path: ROOT_KNOWLEDGE_PATH,
      body: appendTeamContextSection(`${KNOWLEDGE_BANNER}\n${ROOT_KNOWLEDGE_TITLE}\n`, input),
    });
  }
  // A directory's knowledge goes to Pathrule's own folder as a path-scoped rule, which Claude loads when
  // work enters the directory, as it would that directory's CLAUDE.md; the person's CLAUDE.md stays theirs.
  const areas = renderKnowledgeFiles(input, (dirPath) => bindingPath(dirPath), (node, base) => `${areaFrontmatter(node.dir_path)}${base}`);
  if (areas.length > 0) files.push(...areas, { path: BINDING_IGNORE, body: BINDING_IGNORE_BODY });
  return files;
}

const areaFrontmatter = (dirPath: string): string => `---\npaths:\n  - "${dirRelative(dirPath)}/**"\n---\n`;

/**
 * Signature mode still owns ONE folder: `.claude/rules/pathrule/`, the binding knowledge as Claude Code's
 * path-scoped rules. A file per area carries `paths: ["<area>/**"]`, so Claude loads it as project
 * instructions only when work enters that area (verified 2026-10-15: a rule file for foo/** is seen
 * after reading foo/a.py and not after reading bar/b.py). The root file has no `paths` and loads at
 * session start. The folder ignores itself, so the user's .gitignore is never edited.
 */
const BINDING_DIR = ".claude/rules/pathrule";
const bindingPath = (dirPath: string): string =>
  dirPath === "/" ? `${BINDING_DIR}/workspace.md` : `${BINDING_DIR}/${knowledgeSlug(dirPath)}.md`;
const BINDING_IGNORE = `${BINDING_DIR}/.gitignore`;
const BINDING_IGNORE_BODY = "# Pathrule managed — compiled instructions, regenerated on sync.\n*\n";
/**
 * Which memory versions the files above hold. The hook reads it to skip only those, so a memory written
 * after this render is delivered by the hook instead of being taken for one these files carry. Claude
 * loads only the folder's .md files, so this never reaches the agent.
 */
const BINDING_MANIFEST = `${BINDING_DIR}/manifest.json`;

/**
 * The root file asks the agent to keep the knowledge current, in the instruction channel, at session
 * start. Measured on PathruleBench v2 (2026-10-15): with the same ask as a line of hook context, agents
 * saved team decisions and none of the person's habits; with it at the top of a CLAUDE.md, they saved both.
 * Operational lessons are named: a CLAUDE.md agent kept "the team suite needs ACME_TEAM_SUITE=1" in its
 * notes on a feature, while agents saving to Pathrule saved only what the person called a decision and
 * met the same failure in every session. Once named, they saved it under the suite's folder, which a
 * session running the suite from a shell never enters, so the ask says where: what applies everywhere,
 * and how to run or verify things, at `/`. One agent in three saved "a habit of mine" without `lasting`,
 * so it stayed a candidate no session saw; the ask names the flag.
 */
export const KEEP_CURRENT =
  "## Keep this knowledge current\n" +
  "Before you finish, save what the next session would otherwise have to rediscover, at the path it applies to " +
  "(`/` for the whole project; a path's knowledge is shown when work enters that path):\n" +
  "- a decision, convention or constraint the person states or changes, and what you learned that the code does not show: " +
  "`pathrule_write_memory`, quoting it in `atoms`. State the decision itself, not how you implemented it. " +
  "How to run or verify something here (a command, an environment variable, a build step): at `/`;\n" +
  "- how the person likes to work: `pathrule_remember_preference`, with `lasting: true` when they say it holds from now on.\n";
const ROOT_TITLE = "# Project instructions (Pathrule)";

function renderBindingRules(input: MultiClientInput): RenderedFile[] {
  const nodes = (input.knowledgeBinding ?? []).filter((n) => n.rule_ids.length > 0 || n.memory_ids.length > 0);
  const files: RenderedFile[] = nodes.filter((n) => n.dir_path !== "/").map((n) => ({
    path: bindingPath(n.dir_path),
    body: `${areaFrontmatter(n.dir_path)}${knowledgeFileBody(n, `# Instructions for ${n.dir_path} (Pathrule)`)}`,
  }));
  // The root file always exists in signature mode: it carries the ask to keep the knowledge current.
  const root = nodes.find((n) => n.dir_path === "/");
  files.unshift({
    path: bindingPath("/"),
    body: root ? knowledgeFileBody({ ...root, markdown: `${KEEP_CURRENT}\n${root.markdown}` }, ROOT_TITLE) : `${KNOWLEDGE_BANNER}\n${ROOT_TITLE}\n\n${KEEP_CURRENT}`,
  });
  files.push({ path: BINDING_IGNORE, body: BINDING_IGNORE_BODY });
  const memories = Object.fromEntries(nodes.flatMap((n) => Object.entries(n.memory_hashes ?? {})).sort((a, z) => a[0].localeCompare(z[0])));
  // `root`: the memories the root file holds, loaded at session start; the hook treats only those as
  // delivered. The "_" banner carries a managed marker, so a sweep may remove the file once nothing renders it.
  files.push({ path: BINDING_MANIFEST, body: `${JSON.stringify({ _: "# >>> Pathrule managed: binding manifest", root: root?.memory_ids ?? [], memories }, null, 1)}\n` });
  return files;
}

function ownedPaths(input: MultiClientInput): string[] {
  const binding = [bindingPath("/"), ...knowledgeOwnedPaths(input, bindingPath), ...(input.knowledgeBinding ?? []).map((n) => bindingPath(n.dir_path))];
  // The root CLAUDE.md and the directories' CLAUDE.md files: only what an earlier Pathrule put there, so
  // a sync takes its region back out (a file without Pathrule's marker is never touched).
  const legacy = ["CLAUDE.md", ...knowledgeOwnedPaths(input, legacyKnowledgePath)];
  return [...new Set([ROOT_KNOWLEDGE_PATH, ...legacy, ...binding, BINDING_IGNORE, BINDING_MANIFEST])];
}

export const claudeKnowledgeRenderer: ClientRendererSpec = {
  id: "claude-code",
  render: renderClaudeKnowledge,
  ownedPaths,
};
