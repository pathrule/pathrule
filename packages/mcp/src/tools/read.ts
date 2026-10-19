// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { readMemoryHandler } from "@pathrule/core/tools/memories.js";
import { readRuleHandler } from "@pathrule/core/tools/rules.js";
import { readSkillHandler } from "@pathrule/core/tools/skills.js";
import { resolveContext } from "./helpers.js";
import { formatThrown, formatToolError } from "../errors.js";
import { compactMemory, compactRule, compactSkill } from "../lib/read-compact.js";
import type { ToolDef } from "./types.js";

interface Args {
  memory_ids?: string[];
  rule_ids?: string[];
  skill_ids?: string[];
}

const MAX_BATCH = 50;

// One MCP roundtrip to read many items. get_node / list_memories / resolve hand
// back id ARRAYS; reading them one-by-one is an N+1 roundtrip storm (a node with
// M+R+S items = M+R+S calls). This fans the existing per-id backend reads out in
// parallel IN-PROCESS behind a single tool call — no new backend seam, so Cloud
// and OSS local get it from the same code (no double-stitching).
export const readTool: ToolDef<Args> = {
  name: "pathrule_read",
  title: "Read Many",
  description:
    "Read several memories/rules/skills in ONE call. Pass any of `memory_ids`, `rule_ids`, `skill_ids` (ids from get_node, list_memories, resolve, or the injected context). Returns `{ memories, rules, skills, missing }` with full bodies + version_id for each. Use this instead of firing pathrule_read_memory/read_rule/read_skill once per id.",
  inputSchema: {
    memory_ids: z.array(z.string().uuid()).optional().describe("Memory UUIDs to read."),
    rule_ids: z.array(z.string().uuid()).optional().describe("Rule UUIDs to read."),
    skill_ids: z.array(z.string().uuid()).optional().describe("Skill UUIDs to read."),
  },
  handler: async (args) => {
    try {
      const memoryIds = args.memory_ids ?? [];
      const ruleIds = args.rule_ids ?? [];
      const skillIds = args.skill_ids ?? [];
      const total = memoryIds.length + ruleIds.length + skillIds.length;
      if (total === 0) {
        return formatToolError({
          code: "invalid_args",
          message: "Provide at least one of memory_ids / rule_ids / skill_ids.",
        });
      }
      if (total > MAX_BATCH) {
        return formatToolError({
          code: "invalid_args",
          message: `Too many ids (${total}); read at most ${MAX_BATCH} per call.`,
        });
      }

      const ctx = await resolveContext();
      const missing: Array<{ kind: "memory" | "rule" | "skill"; id: string }> = [];

      const [memories, rules, skills] = await Promise.all([
        Promise.all(
          memoryIds.map(async (id) => {
            const r = await readMemoryHandler(ctx, { memory_id: id });
            if (!r.ok) {
              missing.push({ kind: "memory", id });
              return null;
            }
            return compactMemory(r.data);
          }),
        ),
        Promise.all(
          ruleIds.map(async (id) => {
            const r = await readRuleHandler(ctx, { rule_id: id });
            if (!r.ok) {
              missing.push({ kind: "rule", id });
              return null;
            }
            return compactRule(r.data);
          }),
        ),
        Promise.all(
          skillIds.map(async (id) => {
            const r = await readSkillHandler(ctx, { skill_id: id });
            if (!r.ok) {
              missing.push({ kind: "skill", id });
              return null;
            }
            return compactSkill(r.data);
          }),
        ),
      ]);

      return {
        ok: true,
        memories: memories.filter((m): m is NonNullable<typeof m> => m !== null),
        rules: rules.filter((r): r is NonNullable<typeof r> => r !== null),
        skills: skills.filter((s): s is NonNullable<typeof s> => s !== null),
        ...(missing.length > 0 && { missing }),
      };
    } catch (e) {
      return formatThrown(e);
    }
  },
};
