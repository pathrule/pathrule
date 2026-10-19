// SPDX-License-Identifier: Apache-2.0
//
// Find every place a project already keeps knowledge for its agents.
//
// Open source on purpose, with the rest of `knowledge-import/`: finding a
// project's instruction files and turning them into memory drafts is how a
// Core workspace starts with what the project already wrote down. The bootstrap
// brief built on top of this inventory stays in `setup-bootstrap/`, which is
// closed.
//
// The importer used to read exactly two files: `<root>/CLAUDE.md` and
// `<root>/.claude/CLAUDE.md`. Measured against the five repo kinds users
// actually bring, that missed almost everything:
//
//   - a deeply @imported tree: the import TARGETS were never read, so the
//     conventions they held never reached Pathrule;
//   - a Cursor-first repo: `.cursorrules` and `.cursor/rules/*.mdc` yielded
//     nothing at all, because no importer knew those files existed;
//   - a repo whose real decisions live in `docs/adr/*`: never looked at;
//   - a monorepo: nested `packages/*/CLAUDE.md` were never read either.
//
// This module finds the sources. It does NOT decide what becomes a memory: the
// caller proposes, the user approves. Discovery is read-only by construction.
//
// Nothing Pathrule wrote is a source: every file read here, the walk's and the
// `@import` chain's alike, passes `judgePathruleOrigin` (pathrule-origin.ts)
// first, and what it declines is reported in `skipped` rather than dropped
// without a word.

import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { MANAGED_FILES_LEDGER, PATHRULE_DIR } from "../paths/workspace-files.js";
import { normalizeManagedFilePath } from "../storage/managed-file-ownership.js";
import { judgePathruleOrigin, type PathruleOriginReason } from "./pathrule-origin.js";

/** Where a source came from, which drives how the caller treats it. */
export type KnowledgeSourceKind =
  /** An agent instruction file the tool loads directly. */
  | "instruction"
  /** A file pulled in by an `@path` import from an instruction file. */
  | "import-target"
  /** A tool-specific rule file (Cursor .mdc, Copilot instructions, Windsurf). */
  | "tool-rule"
  /** An architecture decision record: high-value, usually still true. */
  | "decision-record"
  /** Project documentation: useful, but often derivable from the code. */
  | "document";

export interface KnowledgeSource {
  /** Workspace-relative path, forward slashes. */
  path: string;
  kind: KnowledgeSourceKind;
  content: string;
  /**
   * Suggested node path for anything imported from this source, derived from
   * where the file lives. A nested `packages/api/CLAUDE.md` describes
   * `/packages/api`, not the root.
   */
  suggestedNodePath: string;
  /** The instruction file that pulled this in, for import targets. */
  importedBy?: string;
}

/** A file discovery did not take as the project's knowledge, and why. */
export interface SkippedKnowledgeSource {
  /** Workspace-relative path, forward slashes. */
  path: string;
  /** What it would have been read as. */
  kind: KnowledgeSourceKind;
  reason: PathruleOriginReason;
}

export interface KnowledgeInventory {
  sources: KnowledgeSource[];
  /** Files Pathrule wrote, or whose origin cannot be told, sorted by path. */
  skipped: SkippedKnowledgeSource[];
}

/** Instruction filenames an agent loads as project instructions. */
const INSTRUCTION_BASENAMES = new Set(["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".clinerules"]);

/** Single-file tool rules that live at a fixed path. */
const TOOL_RULE_FILES = [".cursorrules", ".windsurfrules", ".github/copilot-instructions.md"];

/** Directories of tool rule files, matched by extension. */
const TOOL_RULE_DIRS: Array<{ dir: string; extension: string }> = [
  { dir: ".cursor/rules", extension: ".mdc" },
  { dir: ".windsurf/rules", extension: ".md" },
  { dir: ".github/instructions", extension: ".md" },
  { dir: ".claude/rules", extension: ".md" },
];

/** Directory names that usually hold decision records. */
const DECISION_DIR_RE = /(^|\/)(adr|adrs|decisions|rfc|rfcs)(\/|$)/i;

/** Documentation roots worth reading. */
const DOC_DIRS = ["docs", "doc", "documentation"];

/**
 * Root-level documents that describe the project. Bootstrap v2's doc synthesis
 * already read these; discovery needs them too so the two systems work off ONE
 * inventory instead of each scanning its own subset of the repo.
 */
const ROOT_DOC_BASENAMES = new Set(["README.md", "CONTRIBUTING.md", "ARCHITECTURE.md"]);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "Pods",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".gradle",
  ".idea",
  "DerivedData",
  PATHRULE_DIR,
]);

const MAX_FILE_BYTES = 256 * 1024;
/** The ledger is Pathrule's own file, but still read with a bound. */
const MAX_LEDGER_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 6;
const MAX_IMPORT_HOPS = 4; // Claude Code's own limit
const MAX_DOCS = 40;

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** Directory of a file, as a workspace node path: "packages/api/CLAUDE.md" → "/packages/api". */
export function suggestedNodePathFor(relativePath: string): string {
  const dir = toPosix(dirname(relativePath));
  if (dir === "." || dir === "" || dir === "/") return "/";
  // A tool directory describes the project, not itself.
  const cleaned = dir.replace(/(^|\/)\.(claude|cursor|windsurf|github|codex)(\/.*)?$/, "");
  const trimmed = cleaned.replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? "/" : `/${trimmed}`;
}

async function readIfSmall(abs: string, limit = MAX_FILE_BYTES): Promise<string | null> {
  try {
    if ((await stat(abs)).size > limit) return null;
    return await readFile(abs, "utf8");
  } catch {
    return null;
  }
}

/**
 * Workspace-relative paths `.pathrule/managed-files.json` records Pathrule
 * writing, for the ledger at the root and one in any folder below it (a folder
 * bound on its own keeps its own ledger, with paths relative to that folder).
 *
 * The format is its writer's (storage/managed-file-ownership.ts):
 * `{ schema_version, files: [{ path, owner, owner_version, updated_at }] }`.
 * Read more loosely than the writer reads it back: any entry with a path counts,
 * whatever its owner, version or schema, because an entry this reader does not
 * recognise is still Pathrule saying it wrote the file. A ledger that cannot be
 * read lists nothing; the name, banner and marker checks still see every file.
 */
async function readManagedPaths(root: string, ledgerDirs: readonly string[]): Promise<Set<string>> {
  const managed = new Set<string>();
  // The root's is read even when the walk did not list it as a folder (a symlink, say).
  for (const dir of new Set(["", ...ledgerDirs])) {
    const body = await readIfSmall(join(root, dir, MANAGED_FILES_LEDGER), MAX_LEDGER_BYTES);
    if (body === null) continue;
    let files: unknown;
    try {
      files = (JSON.parse(body) as { files?: unknown } | null)?.files;
    } catch {
      continue;
    }
    if (!Array.isArray(files)) continue;
    for (const entry of files) {
      const path = (entry as { path?: unknown } | null)?.path;
      if (typeof path !== "string") continue;
      try {
        const rel = normalizeManagedFilePath(path);
        managed.add(dir === "" ? rel : `${dir}/${rel}`);
      } catch {
        // A path outside its folder names nothing this walk reads.
      }
    }
  }
  return managed;
}

/**
 * `@path/to/file.md` references in a body, skipping fenced blocks and inline
 * code, the same rule Claude Code applies to its own import parsing, so a
 * documented path in a code sample is not mistaken for a real import.
 */
export function parseImportTargets(body: string): string[] {
  const withoutCode = body
    .replace(/^\s{0,3}(`{3,}|~{3,})[\s\S]*?^\s{0,3}\1\s*$/gm, "")
    .replace(/`[^`\n]*`/g, "");
  const out: string[] = [];
  for (const match of withoutCode.matchAll(/(?:^|[\s(])@([A-Za-z0-9._~\-/]+)/g)) {
    // Sentence punctuation is not part of the path: "See @docs/arch.md." must
    // yield `docs/arch.md`, not `docs/arch.md.` (which then fails the extension
    // check and silently drops a real import).
    const target = match[1]!.replace(/[.,;:!?)\]]+$/, "");
    // Home-relative imports are the user's own machine config, not project
    // knowledge, and Claude Code gates them behind a separate approval.
    if (target.startsWith("~")) continue;
    if (!/\.[A-Za-z0-9]{1,12}$/.test(target)) continue;
    out.push(target);
  }
  return [...new Set(out)];
}

/**
 * Every file worth classifying, and every folder that holds a `.pathrule`
 * directory (workspace-relative, "" for the root), whose ledger must be read
 * before any of those files is judged.
 */
async function walk(
  root: string,
  dir: string,
  depth: number,
  found: { files: string[]; ledgerDirs: string[] },
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === PATHRULE_DIR) found.ledgerDirs.push(toPosix(relative(root, dir)));
      if (SKIP_DIRS.has(entry.name)) continue;
      // Dot directories are skipped except the tool dirs that hold rules.
      if (entry.name.startsWith(".")) {
        const walkable = [".claude", ".cursor", ".windsurf", ".github", ".codex"];
        if (!walkable.includes(entry.name)) continue;
      }
      await walk(root, abs, depth + 1, found);
      continue;
    }
    if (entry.isFile()) found.files.push(abs);
  }
}

/**
 * Discover every knowledge source in a workspace.
 *
 * Ordering is deliberate and stable: instruction files first (most
 * authoritative), then what they import, then tool rules, then decision
 * records, then general docs. A caller presenting these for approval should keep
 * that order, because it is roughly descending confidence.
 */
export async function discoverKnowledgeSources(workspaceRoot: string): Promise<KnowledgeSource[]> {
  return (await inventoryKnowledgeSources(workspaceRoot)).sources;
}

/**
 * The sources `discoverKnowledgeSources` returns, plus every file it left out
 * because Pathrule wrote it or its origin cannot be told. Reads only.
 */
export async function inventoryKnowledgeSources(
  workspaceRoot: string,
): Promise<KnowledgeInventory> {
  const instruction: KnowledgeSource[] = [];
  const toolRule: KnowledgeSource[] = [];
  const decision: KnowledgeSource[] = [];
  const document: KnowledgeSource[] = [];

  const seen = new Set<string>();
  const push = (list: KnowledgeSource[], source: KnowledgeSource): void => {
    if (seen.has(source.path)) return;
    seen.add(source.path);
    list.push(source);
  };

  const found = { files: [] as string[], ledgerDirs: [] as string[] };
  await walk(workspaceRoot, workspaceRoot, 0, found);
  const managedPaths = await readManagedPaths(workspaceRoot, found.ledgerDirs);

  const skipped = new Map<string, SkippedKnowledgeSource>();
  /**
   * The file's text the project may import: Pathrule's region cut out, or null
   * when there is none (missing, too large, or declined and recorded as skipped).
   */
  const readSource = async (
    rel: string,
    abs: string,
    kind: KnowledgeSourceKind,
  ): Promise<string | null> => {
    const body = await readIfSmall(abs);
    if (body === null) return null;
    const verdict = judgePathruleOrigin({ path: rel, body, managedPaths });
    if (verdict.import) return verdict.content;
    skipped.set(rel, { path: rel, kind, reason: verdict.reason });
    return null;
  };

  for (const abs of found.files) {
    const rel = toPosix(relative(workspaceRoot, abs));
    const base = rel.slice(rel.lastIndexOf("/") + 1);

    if (INSTRUCTION_BASENAMES.has(base)) {
      const content = await readSource(rel, abs, "instruction");
      if (content !== null && content.trim() !== "") {
        push(instruction, {
          path: rel,
          kind: "instruction",
          content,
          suggestedNodePath: suggestedNodePathFor(rel),
        });
      }
      continue;
    }

    const isToolRule =
      TOOL_RULE_FILES.includes(rel) ||
      TOOL_RULE_DIRS.some((d) => rel.startsWith(`${d.dir}/`) && rel.endsWith(d.extension));
    if (isToolRule) {
      // Pathrule's own rule files (`pathrule-*`, `.claude/rules/pathrule/`) are declined by name.
      const content = await readSource(rel, abs, "tool-rule");
      if (content !== null && content.trim() !== "") {
        push(toolRule, {
          path: rel,
          kind: "tool-rule",
          content,
          suggestedNodePath: "/",
        });
      }
      continue;
    }

    if (!rel.endsWith(".md") && !rel.endsWith(".mdx")) continue;

    if (DECISION_DIR_RE.test(rel)) {
      const content = await readSource(rel, abs, "decision-record");
      if (content !== null && content.trim() !== "") {
        push(decision, {
          path: rel,
          kind: "decision-record",
          content,
          suggestedNodePath: "/",
        });
      }
      continue;
    }

    // Root-level project documents (README, CONTRIBUTING, ARCHITECTURE).
    if (!rel.includes("/") && ROOT_DOC_BASENAMES.has(base)) {
      const content = await readSource(rel, abs, "document");
      if (content !== null && content.trim() !== "") {
        push(document, {
          path: rel,
          kind: "document",
          content,
          suggestedNodePath: "/",
        });
      }
      continue;
    }

    const topLevel = rel.split("/")[0] ?? "";
    if (DOC_DIRS.includes(topLevel) && document.length < MAX_DOCS) {
      const content = await readSource(rel, abs, "document");
      if (content !== null && content.trim() !== "") {
        push(document, {
          path: rel,
          kind: "document",
          content,
          suggestedNodePath: "/",
        });
      }
    }
  }

  // Follow `@import` chains from the instruction files, bounded to Claude Code's
  // own four hops.
  //
  // A file the walk already classified (say `docs/architecture.md` as a
  // "document") is PROMOTED to "import-target" when an instruction file imports
  // it: being in the user's import chain is hard evidence that the file is live
  // agent context, not just documentation lying around. Instruction files keep
  // their own kind, which is stronger still.
  //
  // Only the person's text is followed: a skipped file's imports are never read,
  // and a region's are gone with the region.
  const contentByPath = new Map<string, string>();
  for (const s of [...instruction, ...toolRule, ...decision, ...document]) {
    contentByPath.set(s.path, s.content);
  }

  const importTargets: KnowledgeSource[] = [];
  const chainPaths = new Set<string>();
  const importedByOf = new Map<string, string>();

  let frontier: KnowledgeSource[] = instruction;
  for (let hop = 0; hop < MAX_IMPORT_HOPS && frontier.length > 0; hop += 1) {
    const next: KnowledgeSource[] = [];
    for (const source of frontier) {
      for (const target of parseImportTargets(source.content)) {
        // Relative to the importing file, as Claude Code resolves them.
        const abs = resolve(workspaceRoot, dirname(source.path), target);
        const rel = toPosix(relative(workspaceRoot, abs));
        if (rel.startsWith("..")) continue; // outside the workspace
        if (chainPaths.has(rel)) continue; // already followed (and cycle guard)
        if (instruction.some((s) => s.path === rel)) continue; // stronger kind wins

        const declined = skipped.get(rel);
        if (declined) {
          // Still left out; it is reported as what it would have been read as.
          if (declined.kind !== "instruction") declined.kind = "import-target";
          continue;
        }

        let content = contentByPath.get(rel);
        const alreadyWalked = content !== undefined;
        if (content === undefined) {
          const read = await readSource(rel, abs, "import-target");
          if (read === null || read.trim() === "") continue;
          content = read;
          contentByPath.set(rel, content);
        }

        chainPaths.add(rel);
        importedByOf.set(rel, source.path);
        const discovered: KnowledgeSource = {
          path: rel,
          kind: "import-target",
          content,
          suggestedNodePath: suggestedNodePathFor(rel),
          importedBy: source.path,
        };
        // Files the walk never saw are added here; walked ones are promoted below.
        if (!alreadyWalked) {
          seen.add(rel);
          importTargets.push(discovered);
        }
        next.push(discovered);
      }
    }
    frontier = next;
  }

  /** Move any walked file that turned out to be imported into the chain bucket. */
  const promoteImported = (list: KnowledgeSource[]): KnowledgeSource[] =>
    list.filter((source) => {
      if (!chainPaths.has(source.path)) return true;
      importTargets.push({
        ...source,
        kind: "import-target",
        importedBy: importedByOf.get(source.path),
      });
      return false;
    });

  const remainingToolRules = promoteImported(toolRule);
  const remainingDecisions = promoteImported(decision);
  const remainingDocuments = promoteImported(document);

  const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
  return {
    sources: [
      ...instruction.sort(byPath),
      ...importTargets.sort(byPath),
      ...remainingToolRules.sort(byPath),
      ...remainingDecisions.sort(byPath),
      ...remainingDocuments.sort(byPath),
    ],
    skipped: [...skipped.values()].sort(byPath),
  };
}
