// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import {
  importPatternHandler,
  removePatternHandler,
  previewPattern,
  formatPatternImportMessage,
  formatPatternRemoveMessage,
} from "@pathrule/core/tools/import-pattern.js";
import { cacheInvalidate } from "../cache.js";
import { rerenderClaudeMdAfterWrite, resolveContext } from "./helpers.js";
import { formatThrown, formatToolError } from "../errors.js";
import type { ToolDef } from "./types.js";

interface ImportArgs {
  workspace_id: string;
  slug: string;
  node_path?: string;
  dry_run?: boolean;
  verbose?: boolean;
}

interface RemoveArgs {
  workspace_id: string;
  slug: string;
  node_path?: string;
  verbose?: boolean;
}

const slugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Lowercase slug, e.g. nextjs-app-router")
  .describe("Pattern slug — the part after 'package:' in ::pathrule:package:<slug>.");

export const importPatternTool: ToolDef<ImportArgs> = {
  name: "pathrule_import_pattern",
  title: "Import Pattern",
  description:
    "Import an official Pathrule pattern (a bundle of memories, rules, and skills) into the workspace when the user pastes a `::pathrule:package:<slug>` token. WORKFLOW: (1) First call with `dry_run: true` to see the pattern's `appliesTo` (stacks/packages/paths) and its pieces WITHOUT writing. (2) Judge fit against THIS workspace (its tree + stack). If the pattern does NOT fit (e.g. an Expo pattern but the project has no Expo), STOP and ask the user whether and where to add it. (3) Choose the `node_path` base that matches the user's actual structure (e.g. /apps/mobile) — the pattern's own paths are re-rooted under it. (4) Call again without dry_run to write. Pieces are path-first (missing nodes auto-create) and idempotent (existing content is skipped). Imported skills are tagged `pattern:<slug>`; the response lists each created id. Relay the returned human_message. Use pathrule_remove_pattern to undo a whole bundle.",
  inputSchema: {
    workspace_id: z.string().uuid().describe("The workspace UUID from pathrule_get_context."),
    slug: slugSchema,
    node_path: z
      .string()
      .optional()
      .describe(
        "Base path to re-root the whole bundle under, chosen to match this workspace (e.g. /apps/mobile). Omit only when the pattern's own paths already fit.",
      ),
    dry_run: z
      .boolean()
      .optional()
      .describe("True returns the pattern's appliesTo + pieces (with resolved paths) WITHOUT writing. Use first to decide fit + base path."),
    verbose: z
      .boolean()
      .optional()
      .describe("Set true for per-piece detail. Default false (compact summary)."),
  },
  handler: async (args) => {
    try {
      if (args.dry_run) {
        const preview = previewPattern(args.slug, args.node_path);
        if (!preview.ok) return formatToolError(preview.error);
        return { ok: true, dry_run: true, ...preview.data };
      }

      const ctx = await resolveContext(args.workspace_id);
      const result = await importPatternHandler(ctx, { slug: args.slug, node_path: args.node_path });
      if (!result.ok) return formatToolError(result.error);

      await cacheInvalidate({ workspaceId: args.workspace_id, kind: "context", id: "__root__" });
      await rerenderClaudeMdAfterWrite(ctx, args.workspace_id);

      const data = result.data;
      const human_message = formatPatternImportMessage(data);
      return args.verbose
        ? { ok: true, ...data, human_message }
        : {
            ok: true,
            slug: data.slug,
            imported: data.imported,
            skipped: data.skipped,
            applies_to: data.appliesTo,
            human_message,
          };
    } catch (e) {
      return formatThrown(e);
    }
  },
};

export const removePatternTool: ToolDef<RemoveArgs> = {
  name: "pathrule_remove_pattern",
  title: "Remove Pattern",
  description:
    "Remove a previously-imported Pathrule pattern bundle in one call — the reverse of pathrule_import_pattern. The pattern definition is the manifest, so this finds and deletes the memories/rules/skills whose titles match the pattern's pieces. Pass the SAME `node_path` base that was used at import (omit if the bundle used the pattern's own paths). Pieces that are not found are reported, not errors (idempotent). Relay the returned human_message.",
  inputSchema: {
    workspace_id: z.string().uuid().describe("The workspace UUID from pathrule_get_context."),
    slug: slugSchema,
    node_path: z
      .string()
      .optional()
      .describe("The base path the bundle was imported under. Must match the import to locate the pieces."),
    verbose: z
      .boolean()
      .optional()
      .describe("Set true for per-piece detail. Default false (compact summary)."),
  },
  handler: async (args) => {
    try {
      const ctx = await resolveContext(args.workspace_id);
      const result = await removePatternHandler(ctx, { slug: args.slug, node_path: args.node_path });
      if (!result.ok) return formatToolError(result.error);

      await cacheInvalidate({ workspaceId: args.workspace_id, kind: "context", id: "__root__" });
      await rerenderClaudeMdAfterWrite(ctx, args.workspace_id);

      const data = result.data;
      const human_message = formatPatternRemoveMessage(data);
      return args.verbose
        ? { ok: true, ...data, human_message }
        : { ok: true, slug: data.slug, removed: data.removed, not_found: data.not_found, human_message };
    } catch (e) {
      return formatThrown(e);
    }
  },
};
