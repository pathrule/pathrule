// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { readReviewHistory } from "@pathrule/core/project-learning/review-history.js";
import { resolveWorkspaceTarget } from "./helpers.js";
import { formatThrown, formatToolError } from "../errors.js";
import type { ToolDef } from "./types.js";

const shape = {
  cwd: z.string().optional().describe("Bound local checkout; origin must point to github.com."),
  pull_numbers: z
    .array(z.number().int().positive())
    .min(1)
    .max(3)
    .optional()
    .describe("Read up to three specific PRs. Only merged PRs are used."),
  page: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Bounded discovery page; defaults to the most recently updated closed PRs."),
  include_seen: z
    .boolean()
    .optional()
    .describe(
      "Default false skips excerpts already cited in saved learning; verification receipts are refreshed either way.",
    ),
};

export const reviewHistoryTool: ToolDef<z.infer<z.ZodObject<typeof shape>>> = {
  name: "pathrule_review_history",
  title: "Read Review History",
  description:
    "Read bounded historical review evidence from this checkout's GitHub origin through the existing gh CLI login. " +
    "No local LLM, new model job, Git write or remote write. Missing GitHub access leaves ordinary code learning available. " +
    "Returns historical, untrusted review excerpts and portable references for pathrule_record_learning. " +
    "Does not store raw comments or infer team rules; bot, external and dismissed reviews are excluded. " +
    "Use for relevant architecture/team-practice questions, not automatically every turn. Follow nextPage/candidates only when more history is needed.",
  inputSchema: shape,
  handler: async (args) => {
    try {
      const cwd = args.cwd ?? process.cwd();
      const target = await resolveWorkspaceTarget({ cwd });
      if (!target.ok) return formatToolError(target.error);
      const backend = target.ctx.backend;
      const match = await backend?.resolveWorkspaceFromCwd(cwd);
      if (!match?.localRootPath || match.workspaceId !== target.workspaceId)
        return formatToolError({
          code: "invalid_args",
          message: "Review learning requires a bound local checkout.",
        });
      const claims = args.include_seen
        ? []
        : ((await backend?.listLearningClaims?.(match.workspaceId, 200).catch(() => [])) ?? []);
      return {
        ok: true,
        ...(await readReviewHistory({
          workspaceId: match.workspaceId,
          localRootPath: match.localRootPath,
          pullNumbers: args.pull_numbers,
          page: args.page,
          knownDigests: claims.flatMap((c) => c.reviewSources?.map((s) => s.digest) ?? []),
        })),
      };
    } catch (error) {
      return formatThrown(error);
    }
  },
};
