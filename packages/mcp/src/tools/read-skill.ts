// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { readSkillHandler } from "@pathrule/core/tools/skills.js";
// Deep import: the ledger does node:fs IO, so it is deliberately not in the shared
// barrel — that barrel is also loaded by browser bundles.
import { cacheGet, cachePut } from "../cache.js";
import { resolveContext } from "./helpers.js";
import { recordExplicitRead } from "../lib/delivery.js";
import { formatThrown, formatToolError } from "../errors.js";
import { compactSkill, type CompactSkill } from "../lib/read-compact.js";
import type { ToolDef } from "./types.js";

export const readSkillTool: ToolDef<{ skill_id?: string; id?: string }> = {
  name: "pathrule_read_skill",
  title: "Read Skill",
  description:
    "Return a single skill's stored package primary SKILL.md body. Response is flat (no wrapper): id, name, content, node_path, source, version_id, updated_at. For source='github_ref', reads the approved Pathrule snapshot, not live GitHub. version_id is the optimistic concurrency token for pathrule_update_skill. Legacy response.skill.* wrapper removed in M14.",
  inputSchema: {
    skill_id: z.string().uuid().optional().describe("Skill UUID."),
    // Agents read "(id: …)" in the hook's lines and pass `id`; refusing it cost a retry step (measured 2026-10-15).
    id: z.string().uuid().optional().describe("Same as skill_id."),
  },
  handler: async (args) => {
    const skillId = args.skill_id ?? args.id;
    if (!skillId) return formatToolError({ code: "invalid_args", message: "Pass skill_id (the skill's UUID)." });
    try {
      const ctx = await resolveContext();
      const result = await readSkillHandler(ctx, { skill_id: skillId });
      if (!result.ok) return formatToolError(result.error);
      const compact = compactSkill(result.data);

      // Keep github_ref reads uncached so package snapshot replacements are
      // visible immediately after explicit review.
      if (result.data.source !== "github_ref") {
        const key = { workspaceId: "__by_id__", kind: "skill" as const, id: skillId };
        const cached = await cacheGet<CompactSkill>(key);
        if (cached) {
          void recordExplicitRead(ctx.workspaceId, "skill", cached, "pathrule_read_skill");
          return { ok: true, ...cached, cache_hit: true };
        }
        await cachePut(key, compact);
      }
      void recordExplicitRead(ctx.workspaceId, "skill", compact, "pathrule_read_skill");
      return { ok: true, ...compact };
    } catch (e) {
      return formatThrown(e);
    }
  },
};
