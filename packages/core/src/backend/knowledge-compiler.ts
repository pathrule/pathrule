// SPDX-License-Identifier: Apache-2.0
/**
 * Native Knowledge Compilation — the pure core that turns the
 * workspace's path-scoped knowledge into per-directory markdown sections,
 * ready for each client renderer to wrap in its native instruction format
 * (directory CLAUDE.md / nested AGENTS.md / Cursor .mdc globs / Copilot
 * applyTo instructions / Windsurf rules).
 *
 * Why: every supported agent already has a native, turn-zero, cached,
 * path-scoped instruction channel. Measured head-to-head, knowledge delivered
 * there suppresses exploration (3-8 turns vs 12-19) while hook/MCP retrieval
 * does not. So the compiler puts the knowledge itself into that channel;
 * hooks keep only guard + live-delta duties.
 *
 * Pure and deterministic: same input, same bytes. No I/O, no clock.
 */
import { createHash } from "node:crypto";
import type { HookIndexInput } from "./hook-index.js";
import { compiledDeliveryPlan, deliveredMemoryBody, sourcedAdvisoryLines } from "./compiled-delivery.js";
import { isDirectoryLeafName } from "../paths/leaf-type.js";
import { layoutRegex, normativeRegex, splitSentences } from "../maintenance/lasting-markers.js";

/** Per-directory budget for compiled knowledge (chars ≈ tokens × 4). */
const DIR_BUDGET_CHARS = 12_000;
/** The root file is read in every session — keep it lean. */
const ROOT_BUDGET_CHARS = 6_000;

const BINDING_NOTE =
  "> Team knowledge, maintained by Pathrule. Follow it as written; it outranks defaults and your own conventions.\n" +
  "> \"As of writing\" marks where something lived or how it was wired when the entry was written: when the code differs, " +
  "the code has moved on. Follow the code, never edit it back to match the entry, and refresh the entry.";
const AUTHORITY_NOTE =
  "> Authoritative, up-to-date project knowledge for this path (maintained by Pathrule). " +
  "Use it directly; do not re-derive these facts by exploring files.";

/**
 * Render mode. `full` (default) compiles every item's BODY into the file —
 * the proven turn-zero delivery for clients whose only channel is the file.
 * `slim` turns the file into a ROUTER: memory/skill become a TITLE index (their
 * bodies are delivered per-prompt by the hook's relevance top-k), while RULES
 * stay full (floored — always present at turn zero). Used for clients with a
 * prompt-time body channel (Claude); other clients stay `full` until verified.
 */
export type KnowledgeRenderMode = "full" | "slim" | "binding";

/**
 * `binding`: only what binds the agent, for Claude Code's path-scoped rules (`.claude/rules/*.md`
 * with `paths:`), which Claude loads as project INSTRUCTIONS when work enters the area. Rules in full,
 * and every memory that has Agent IR atoms, as those atom lines (its compiled form when the
 * completeness gate cleared it). A memory with no atoms (documentation, notes) stays out; the hook
 * retrieves it when a prompt clearly names it. Length is no test: a short doc section is not a rule.
 *
 * Measured on fastapi (public benchmark v1, 2026-10-15): the same team rule followed 3/3 from a
 * CLAUDE.md and 1/3 from the hook's prompt context, which the agent read as a note, not an instruction.
 */
const BINDING_DIR_BUDGET_CHARS = 6_000;
const BINDING_ROOT_BUDGET_CHARS = 6_000;

/** An atom's advisory line as an instruction line: the statement, without the kind's prefix and tag. */
function plainInstruction(line: string): string {
  return markLayoutSentences(
    line
      .replace(/^- Fact: /, "- ")
      .replace(/^- Why /, "- Why ")
      .replace(/ \[(context|rationale|preference|ordered guidance|[a-z ]+)\]$/, "")
      .replace(/ \(paraphrased\)/g, ""),
  );
}

/** Normative words and layout verbs come from the per-language table in maintenance/lasting-markers.ts. */
/** A file, a directory or a module named in the sentence. */
const PATH_LIKE = /`[^`\s]*[/.][^`\s]*`|\b[\w-]+\/[\w./-]*|\b[\w-]+\.(?:py|go|ts|tsx|js|mjs|cjs|json|md|yaml|yml|toml|rs|java|rb|cs|php|sql)\b/;
const LAYOUT_MARK = " (as of writing)";

/**
 * Mark the sentences of an instruction line that describe the code's layout, so an agent that finds the
 * code elsewhere follows the code. The marker, not a separate section, keeps a mixed entry readable.
 *
 * Measured on PathruleBench v3 (2026-10-16): "Platform limits live in `config/limits.json`" under a
 * "follow them" heading made agents move a generator back to that path after a teammate had moved the
 * file (0/3 against 3/3 for the same sentence in a CLAUDE.md); the protocol's sentence alone recovered
 * 2/3. A sentence with a normative word stays as it is: a decision binds ahead of the code.
 */
export function markLayoutSentences(line: string): string {
  if (!line.startsWith("- ") || line.includes("\n")) return line;
  const parts = splitSentences(line.slice(2));
  const normative = normativeRegex(), layout = layoutRegex();
  let changed = false;
  const marked = parts.map((s) => {
    const lower = s.toLowerCase();
    if (normative.test(lower) || !layout.test(lower) || !PATH_LIKE.test(s) || s.includes(LAYOUT_MARK)) return s;
    changed = true;
    const m = /^(.*?)([.!?]?)$/.exec(s)!;
    return `${m[1]}${LAYOUT_MARK}${m[2]}`;
  });
  return changed ? `- ${marked.join(" ")}` : line;
}

export interface AssembleKnowledgeOptions {
  mode?: KnowledgeRenderMode;
}

export interface CompiledKnowledgeNode {
  /** Always a directory path: "/" or "/lib". File-level knowledge folds into its parent dir. */
  dir_path: string;
  /** The knowledge sections (markdown, no client-specific wrapper/banner). */
  markdown: string;
  /** Memory ids whose FULL BODY is in this file (full mode). Empty in slim mode. */
  memory_ids: string[];
  rule_ids: string[];
  /** Skill ids whose FULL BODY is in this file (full mode). Empty in slim mode. */
  skill_ids: string[];
  /** Slim mode: memory ids whose TITLE is indexed here but body is NOT (hook delivers it). */
  indexed_memory_ids?: string[];
  /** Slim mode: skill ids whose name is indexed here but body is NOT. */
  indexed_skill_ids?: string[];
  /**
   * Binding mode: a fingerprint of each memory's block as written into this file. The file's manifest
   * and the hook index both carry it, so the hook skips a memory only while the file on disk holds
   * the version the index has; a memory written or changed after the last render is still delivered.
   */
  memory_hashes?: Record<string, string>;
  /** True when the dir budget forced dropping lower-priority items. */
  truncated: boolean;
}

interface DirBucket {
  rules: Array<{ id: string; name: string; content: string; priority: string; at?: string }>;
  memories: Array<{ id: string; title: string; content: string; at?: string; updated_at?: string | null; home?: string }>;
  skills: Array<{ id: string; name: string; content: string }>;
}

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** "/lib/route.js" → { dir: "/lib", leaf: "route.js" }; "/lib" → { dir: "/lib" }. */
function toDirPath(nodePath: string): { dir: string; leaf?: string } {
  const clean = nodePath === "" ? "/" : nodePath;
  const last = clean.split("/").filter(Boolean).pop() ?? "";
  const looksLikeFile = !isDirectoryLeafName(last);
  if (!looksLikeFile) return { dir: clean || "/" };
  const idx = clean.lastIndexOf("/");
  const dir = idx <= 0 ? "/" : clean.slice(0, idx);
  return { dir, leaf: last };
}

export function assembleKnowledgeNodes(
  input: HookIndexInput,
  opts?: AssembleKnowledgeOptions,
): CompiledKnowledgeNode[] {
  const mode: KnowledgeRenderMode = opts?.mode ?? "full";
  const buckets = new Map<string, DirBucket>();
  const bucket = (dir: string): DirBucket => {
    let b = buckets.get(dir);
    if (!b) {
      b = { rules: [], memories: [], skills: [] };
      buckets.set(dir, b);
    }
    return b;
  };

  for (const r of input.rules) {
    const targets = r.scope_type === "project" || r.node_paths.length === 0 ? ["/"] : r.node_paths;
    for (const np of targets) {
      const { dir, leaf } = toDirPath(np);
      bucket(dir).rules.push({
        id: r.id,
        name: leaf ? `${r.name} (${leaf})` : r.name,
        content: r.content,
        priority: r.priority,
        at: leaf,
      });
    }
  }
  // A memory the completeness gate cleared is compiled into the file as its compiled form, exactly
  // as the hook's body channel delivers it; every other memory goes in as written.
  const plan = compiledDeliveryPlan(input);
  const bindingLines = new Map<string, string[]>();
  if (mode === "binding") {
    for (const l of sourcedAdvisoryLines(input)) if (l.sourceMemoryId) (bindingLines.get(l.sourceMemoryId) ?? bindingLines.set(l.sourceMemoryId, []).get(l.sourceMemoryId)!).push(l.line);
  }
  for (const m of input.memories) {
    const { dir, leaf } = toDirPath(m.node_path);
    const atomLines = bindingLines.get(m.id);
    if (mode === "binding" && !atomLines) continue;
    // Binding files carry the atom lines alone, as plain instructions: no "Fact:" prefix and no
    // "[context]" tag, which belong to the prompt channel's advisory framing. Measured on PathruleBench
    // v3 (2026-10-16): a changed decision reached the agent as "- Fact: ... [context]" and was not
    // applied; the same sentence under a CLAUDE.md heading was.
    const content = mode === "binding" ? atomLines!.map(plainInstruction).join("\n") : deliveredMemoryBody(m, plan);
    // Binding: every typed memory starts in the ROOT file, which Claude loads at session start, so a
    // decision holds from the first turn however the agent touches the code. A path-scoped rules file
    // loads only when a file under its path is READ; an agent editing through the shell never loads it
    // (measured on PathruleBench v3, 2026-10-16: a header decision saved under /api reached no S5 agent).
    // What the root budget cannot hold goes to the memory's own area file.
    const area = dir === "/" ? "" : dir.replace(/^\//, "");
    const where = mode !== "binding" ? (leaf ?? "") : leaf ? `${area ? `${area}/` : ""}${leaf}` : area;
    bucket(mode === "binding" ? "/" : dir).memories.push({
      id: m.id,
      title: where ? `${m.title} (${where})` : m.title,
      content,
      at: leaf,
      updated_at: m.updated_at ?? null,
      home: dir,
    });
  }
  for (const s of mode === "binding" ? [] : input.skills) {
    const targets = s.node_paths && s.node_paths.length > 0 ? s.node_paths : ["/"];
    for (const np of targets) {
      const { dir } = toDirPath(np);
      bucket(dir).skills.push({ id: s.id, name: s.name, content: s.content });
    }
  }

  const out: CompiledKnowledgeNode[] = [];
  // The root is compiled first ("/" sorts first); an area a root spill creates joins the list in order.
  const dirs = [...buckets.keys()].sort((a, z) => a.localeCompare(z));
  for (let i = 0; i < dirs.length; i += 1) {
    const dir = dirs[i]!;
    const b = buckets.get(dir)!;
    if (b.rules.length === 0 && b.memories.length === 0 && b.skills.length === 0) continue;

    // Deterministic priority order: rules high→low then by id; memories/skills by id.
    b.rules.sort(
      (a, z) =>
        (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[z.priority] ?? 3) ||
        a.id.localeCompare(z.id),
    );
    // Binding: the most recently changed knowledge first, then memories fully expressed as atoms
    // (decisions, conventions) before partial extractions from long text, so a budget cut drops old
    // reference before what the team is deciding now; what is cut stays with the hook. Measured on
    // PathruleBench v2 (2026-10-15): seeded README facts filled the root file and a lesson an agent
    // saved that session was the one left out.
    b.memories.sort((a, z) =>
      mode === "binding"
        ? (z.updated_at ?? "").localeCompare(a.updated_at ?? "") ||
          Number(plan.compiled.has(z.id)) - Number(plan.compiled.has(a.id)) ||
          a.id.localeCompare(z.id)
        : a.id.localeCompare(z.id));
    b.skills.sort((a, z) => a.id.localeCompare(z.id));

    const budget =
      mode === "binding"
        ? dir === "/" ? BINDING_ROOT_BUDGET_CHARS : BINDING_DIR_BUDGET_CHARS
        : dir === "/" ? ROOT_BUDGET_CHARS : DIR_BUDGET_CHARS;
    const lines: string[] = [mode === "binding" ? BINDING_NOTE : AUTHORITY_NOTE, ""];
    const memoryIds: string[] = [];
    const memoryHashes: Record<string, string> = {};
    const ruleIds: string[] = [];
    const skillIds: string[] = [];
    const indexedMemoryIds: string[] = [];
    const indexedSkillIds: string[] = [];
    let used = lines.join("\n").length;
    let truncated = false;

    const tryPush = (block: string): boolean => {
      const cost = block.length + 1;
      if (used + cost > budget) {
        truncated = true;
        return false;
      }
      lines.push(block);
      used += cost;
      return true;
    };

    // Rules are FULL in BOTH modes — they are floored (always present at turn zero).
    if (b.rules.length > 0) {
      tryPush("## Rules (must follow)\n");
      for (const r of b.rules) {
        if (tryPush(`### ${r.name}\n${r.content.trim()}\n`)) ruleIds.push(r.id);
      }
    }
    if (b.memories.length > 0) {
      if (mode === "slim") {
        // Router: index titles only; the hook delivers the prompt-relevant bodies.
        tryPush("## Knowledge index (bodies delivered per prompt by Pathrule)\n");
        for (const m of b.memories) {
          if (tryPush(`- ${m.title}`)) indexedMemoryIds.push(m.id);
        }
      } else {
        tryPush(mode === "binding" ? "## Decisions and conventions (follow them)\n" : "## Knowledge & decisions\n");
        for (const m of b.memories) {
          const block = `### ${m.title}\n${m.content.trim()}\n`;
          if (mode === "binding" && dir === "/" && m.home && m.home !== "/" && used + block.length + 1 > budget) {
            bucket(m.home).memories.push({ ...m, title: m.title.replace(/ \([^)]*\)$/, m.at ? ` (${m.at})` : "") });
            if (!dirs.includes(m.home)) dirs.splice(dirs.findIndex((d) => d.localeCompare(m.home!) > 0) === -1 ? dirs.length : dirs.findIndex((d) => d.localeCompare(m.home!) > 0), 0, m.home);
            continue;
          }
          if (!tryPush(block)) continue;
          memoryIds.push(m.id);
          if (mode === "binding") memoryHashes[m.id] = createHash("sha256").update(block, "utf8").digest("hex").slice(0, 16);
        }
      }
    }
    if (b.skills.length > 0) {
      if (mode === "slim") {
        tryPush("## Available procedures (invoke with ::name)\n");
        for (const s of b.skills) {
          if (tryPush(`- ${s.name}`)) indexedSkillIds.push(s.id);
        }
      } else {
        tryPush("## Procedures (follow step by step)\n");
        for (const s of b.skills) {
          if (tryPush(`### ${s.name}\n${s.content.trim()}\n`)) skillIds.push(s.id);
        }
      }
    }
    // Slim mode indexes items by title/name only (no id). Tell the agent how to
    // get the editing handle cheaply so it never reverse-engineers an id by
    // pulling the tree + reading candidate bodies (the ~109k-token id hunt).
    if (mode === "slim" && (indexedMemoryIds.length > 0 || indexedSkillIds.length > 0)) {
      tryPush(
        "\n> To edit an indexed item, call `pathrule_resolve` with its exact title/name for its id + version_id in one step (do NOT search the tree for the id), then `pathrule_update_*` — use `content_edit` (append / str_replace / replace_section) for small changes instead of resending the whole body.",
      );
    }
    if (truncated) {
      lines.push(
        "\n_Some items were omitted for size; ask Pathrule (pathrule_get_context) for the rest._",
      );
    }

    out.push({
      dir_path: dir,
      markdown: lines.join("\n").trimEnd() + "\n",
      memory_ids: memoryIds,
      rule_ids: ruleIds,
      skill_ids: skillIds,
      indexed_memory_ids: indexedMemoryIds,
      indexed_skill_ids: indexedSkillIds,
      ...(mode === "binding" ? { memory_hashes: memoryHashes } : {}),
      truncated,
    });
  }
  return out;
}
