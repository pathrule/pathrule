// SPDX-License-Identifier: Apache-2.0
//
// Pattern import — the edition-agnostic orchestration behind the
// `::pathrule:package:<slug>` token.
//
// This handler lives in @pathrule/core (next to the write handlers it reuses)
// so EVERY surface gets identical behaviour: the MCP server (CLI and VS Code via
// `mcp run`) calls it, and because it composes the backend-agnostic write/delete
// handlers it works the same over Pathrule Cloud's Project backend and the Local
// backend (offline SQLite).
//
// The pattern catalog (`@pathrule/patterns`) is a public, Apache-2.0 package and
// the single source of truth. It is also the MANIFEST for removal: a pattern's
// pieces are deterministic (title + nodePath), so `removePatternHandler` can find
// and delete exactly what an import wrote without any provenance schema.
import { getPattern } from "@pathrule/patterns";
import { writeMemoryHandler } from "./memories.js";
import { writeRuleHandler } from "./rules.js";
import { writeSkillHandler } from "./skills.js";
import { deleteMemoryHandler } from "./memories.js";
import { deleteRuleHandler } from "./rules.js";
import { deleteSkillHandler } from "./skills.js";
import type { ToolContext, ToolResult } from "./types.js";

export interface ImportPatternArgs {
  /** Pattern slug — the part after `package:` in `::pathrule:package:<slug>`. */
  slug: string;
  /** Optional base path to re-root the whole bundle under. */
  node_path?: string;
}

export interface ImportPatternPieceDetail {
  kind: "memory" | "rule" | "skill";
  title: string;
  path: string;
  status: "imported" | "skipped" | "failed";
  /** Id of the created (or, when skipped, the existing) record when known. */
  id?: string;
  reason?: string;
}

export interface PatternAppliesToInfo {
  paths?: string[];
  stacks?: string[];
  packages?: string[];
}

export interface PatternPiecePreview {
  kind: "memory" | "rule" | "skill";
  title: string;
  summary: string;
  /** Path the piece would land on, after applying the optional base re-root. */
  path: string;
}

/** Dry-run preview: what a pattern is and where its pieces would go, NO writes. */
export interface PatternPreview {
  slug: string;
  name: string;
  version: string;
  problem?: string;
  audience?: string;
  appliesTo?: PatternAppliesToInfo;
  pieces: PatternPiecePreview[];
}

export interface ImportPatternData {
  slug: string;
  name: string;
  version: string;
  appliesTo?: PatternAppliesToInfo;
  imported: { memories: number; rules: number; skills: number };
  skipped: number;
  details: ImportPatternPieceDetail[];
}

export interface RemovePatternData {
  slug: string;
  name: string;
  removed: { memories: number; rules: number; skills: number };
  not_found: number;
  details: Array<{ kind: "memory" | "rule" | "skill"; title: string; path: string; status: "removed" | "not_found" | "failed"; reason?: string }>;
}

/**
 * Re-root a piece's declared path under an optional base. With no base (the
 * default), the pattern's own paths are used verbatim.
 */
export function joinPatternPaths(base: string | undefined, rel: string): string {
  const b = (base ?? "/").trim();
  if (!b || b === "/") return rel;
  const trimmed = b.replace(/\/+$/, "");
  if (rel === "/") return trimmed || "/";
  return trimmed + (rel.startsWith("/") ? rel : `/${rel}`);
}

/** Provenance tag stamped onto imported skills so they are findable as a group. */
export function patternProvenanceTag(slug: string): string {
  return `pattern:${slug}`;
}

/**
 * Preview a pattern WITHOUT writing anything — its fit metadata (appliesTo) and
 * the pieces + the paths they would land on (after an optional base re-root).
 * The agent uses this to decide the right base path for THIS workspace and to
 * confirm with the user when the pattern's stack/paths don't match the project.
 */
export function previewPattern(slug: string, node_path?: string): ToolResult<PatternPreview> {
  const pattern = getPattern(slug);
  if (!pattern) {
    return {
      ok: false,
      error: {
        code: "not_found",
        message: `No pattern named "${slug}". Browse pathrule.io/patterns for valid slugs.`,
      },
    };
  }
  return {
    ok: true,
    data: {
      slug: pattern.slug,
      name: pattern.name,
      version: pattern.version,
      problem: pattern.problem,
      audience: pattern.audience,
      appliesTo: pattern.appliesTo,
      pieces: pattern.pieces.map((p) => ({
        kind: p.kind,
        title: p.title,
        summary: p.summary,
        path: joinPatternPaths(node_path, p.nodePath),
      })),
    },
  };
}

/**
 * Import a published Pathrule pattern (memories + rules + skills) into the
 * workspace bound to `ctx`. Path-first (missing nodes auto-create), idempotent
 * (existing content is skipped). Backend-agnostic. Imported skills are tagged
 * `pattern:<slug>` for traceability; the response carries each created record's id.
 */
export async function importPatternHandler(
  ctx: ToolContext,
  args: ImportPatternArgs,
): Promise<ToolResult<ImportPatternData>> {
  const pattern = getPattern(args.slug);
  if (!pattern) {
    return {
      ok: false,
      error: {
        code: "not_found",
        message: `No pattern named "${args.slug}". Browse pathrule.io/patterns for valid slugs.`,
      },
    };
  }

  const imported = { memories: 0, rules: 0, skills: 0 };
  let skipped = 0;
  const details: ImportPatternPieceDetail[] = [];

  for (const piece of pattern.pieces) {
    const node_path = joinPatternPaths(args.node_path, piece.nodePath);
    const result =
      piece.kind === "memory"
        ? await writeMemoryHandler(ctx, {
            node_path,
            title: piece.title,
            content: piece.body,
            source: "manual",
          })
        : piece.kind === "rule"
          ? await writeRuleHandler(ctx, {
              node_path,
              name: piece.title,
              content: piece.body,
              scope_type: piece.scopeType ?? "project",
              priority: piece.priority ?? "medium",
            })
          : await writeSkillHandler(ctx, {
              node_path,
              name: piece.title,
              description: piece.summary ?? null,
              content: piece.body,
              source: "manual",
              // Provenance tag so imported skills are findable as a group.
              tags: [...(piece.skillTags ?? []), patternProvenanceTag(pattern.slug)],
            });

    if (result.ok) {
      if (piece.kind === "memory") imported.memories += 1;
      else if (piece.kind === "rule") imported.rules += 1;
      else imported.skills += 1;
      details.push({
        kind: piece.kind,
        title: piece.title,
        path: node_path,
        status: "imported",
        id: result.data.id,
      });
    } else if (result.error.code === "duplicate") {
      skipped += 1;
      const existingId =
        result.error.detail && typeof result.error.detail === "object"
          ? (result.error.detail as { existing_id?: string }).existing_id
          : undefined;
      details.push({
        kind: piece.kind,
        title: piece.title,
        path: node_path,
        status: "skipped",
        id: existingId,
        reason: "already present",
      });
    } else {
      details.push({
        kind: piece.kind,
        title: piece.title,
        path: node_path,
        status: "failed",
        reason: result.error.message,
      });
    }
  }

  return {
    ok: true,
    data: {
      slug: pattern.slug,
      name: pattern.name,
      version: pattern.version,
      appliesTo: pattern.appliesTo,
      imported,
      skipped,
      details,
    },
  };
}

/**
 * Remove a previously-imported pattern bundle in one call. The pattern
 * definition is the manifest: for each piece we resolve its node (base re-root
 * must match the import's) and delete the memory/rule/skill whose title matches.
 * Pieces not found are reported, never an error — removal is idempotent.
 */
export async function removePatternHandler(
  ctx: ToolContext,
  args: ImportPatternArgs,
): Promise<ToolResult<RemovePatternData>> {
  if (!ctx.backend) {
    return { ok: false, error: { code: "upstream_error", message: "No backend configured." } };
  }
  if (!ctx.workspaceId) {
    return { ok: false, error: { code: "invalid_args", message: "ctx.workspaceId is required." } };
  }
  const pattern = getPattern(args.slug);
  if (!pattern) {
    return {
      ok: false,
      error: {
        code: "not_found",
        message: `No pattern named "${args.slug}". Browse pathrule.io/patterns for valid slugs.`,
      },
    };
  }

  const removed = { memories: 0, rules: 0, skills: 0 };
  let notFound = 0;
  const details: RemovePatternData["details"] = [];
  const norm = (s: string) => s.trim().toLowerCase();

  for (const piece of pattern.pieces) {
    const node_path = joinPatternPaths(args.node_path, piece.nodePath);
    try {
      const node = await ctx.backend.findNodeByPath(ctx.workspaceId, node_path);
      if (!node) {
        notFound += 1;
        details.push({ kind: piece.kind, title: piece.title, path: node_path, status: "not_found" });
        continue;
      }
      const content = await ctx.backend.getNodeContent(node.id);
      const target =
        piece.kind === "memory"
          ? content.memories.find((m) => norm(m.title) === norm(piece.title))
          : piece.kind === "rule"
            ? content.rules.find((r) => norm(r.name) === norm(piece.title))
            : content.skills.find((s) => norm(s.name) === norm(piece.title));

      if (!target) {
        notFound += 1;
        details.push({ kind: piece.kind, title: piece.title, path: node_path, status: "not_found" });
        continue;
      }

      const del =
        piece.kind === "memory"
          ? await deleteMemoryHandler(ctx, { memory_id: target.id })
          : piece.kind === "rule"
            ? await deleteRuleHandler(ctx, { rule_id: target.id })
            : await deleteSkillHandler(ctx, { skill_id: target.id });

      if (del.ok) {
        if (piece.kind === "memory") removed.memories += 1;
        else if (piece.kind === "rule") removed.rules += 1;
        else removed.skills += 1;
        details.push({ kind: piece.kind, title: piece.title, path: node_path, status: "removed" });
      } else {
        details.push({
          kind: piece.kind,
          title: piece.title,
          path: node_path,
          status: "failed",
          reason: del.error.message,
        });
      }
    } catch (err) {
      details.push({
        kind: piece.kind,
        title: piece.title,
        path: node_path,
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    ok: true,
    data: { slug: pattern.slug, name: pattern.name, removed, not_found: notFound, details },
  };
}

/** Compose the agent-facing summary line from an import result. */
export function formatPatternImportMessage(data: ImportPatternData): string {
  const total = data.imported.memories + data.imported.rules + data.imported.skills;
  const failed = data.details.filter((d) => d.status === "failed").length;
  return (
    `Imported "${data.name}": ${total} item${total === 1 ? "" : "s"} ` +
    `(${data.imported.rules} rules, ${data.imported.memories} memories, ${data.imported.skills} skills)` +
    `${data.skipped ? `, ${data.skipped} already present` : ""}` +
    `${failed ? `, ${failed} failed` : ""}.`
  );
}

/** Compose the agent-facing summary line from a remove result. */
export function formatPatternRemoveMessage(data: RemovePatternData): string {
  const total = data.removed.memories + data.removed.rules + data.removed.skills;
  const failed = data.details.filter((d) => d.status === "failed").length;
  return (
    `Removed "${data.name}": ${total} item${total === 1 ? "" : "s"} ` +
    `(${data.removed.rules} rules, ${data.removed.memories} memories, ${data.removed.skills} skills)` +
    `${data.not_found ? `, ${data.not_found} not found (already gone or under a different path)` : ""}` +
    `${failed ? `, ${failed} failed` : ""}.`
  );
}
