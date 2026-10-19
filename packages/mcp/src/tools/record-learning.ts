// SPDX-License-Identifier: Apache-2.0
import { verifyReviewEvidence } from "@pathrule/core/project-learning/review-history.js";
import { z } from "zod";
import { realpath } from "node:fs/promises";
import {
  createLearningClaim,
  verifyLearningSources,
} from "@pathrule/core/project-learning/claim-service.js";
import { noteLearningChanged, projectMapPath } from "@pathrule/core/project-learning/index.js";
import { resolveWorkspaceTarget } from "./helpers.js";
import { formatThrown, formatToolError } from "../errors.js";
import type { ToolDef } from "./types.js";

const shape = {
  cwd: z.string().optional().describe("Directory inside the checkout whose sources you read."),
  node_path: z.string().describe("Specific workspace-relative scope, starting with /; no glob."),
  replaces_id: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional()
    .describe(
      "Claim to correct atomically. Only its author may revise it; cite freshly verified sources.",
    ),
  topic: z
    .string()
    .min(1)
    .max(120)
    .describe("Stable name for the architectural topic; reuse it for revisions."),
  statement: z
    .string()
    .min(1)
    .max(1200)
    .describe(
      "Concise synthesis in your own words. No raw source, secrets, prompts or review comments.",
    ),
  category: z.enum(["architecture", "convention", "decision"]),
  review_sources: z
    .array(
      z.object({
        repository: z.string(),
        pullRequest: z.number().int().positive(),
        kind: z.enum(["review", "review_comment"]),
        id: z.number().int().positive(),
        digest: z.string(),
        commit: z.string(),
        mergedAt: z.string(),
        association: z.enum(["OWNER", "MEMBER", "COLLABORATOR"]),
        state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED"]),
        path: z.string().optional(),
      }),
    )
    .min(1)
    .max(6)
    .optional()
    .describe(
      "Exact source references from pathrule_review_history. Convention hypotheses need at least two independent PRs plus current code sources.",
    ),
  sources: z
    .array(
      z.object({
        path: z.string().describe("Workspace-relative source path without a leading slash."),
        digest: z
          .string()
          .describe(
            "sha256:<hex> of the bytes you inspected, or git:<blob-hash> from project_map. Never invent a hash.",
          ),
      }),
    )
    .min(1)
    .max(6),
};

export const recordLearningTool: ToolDef<z.infer<z.ZodObject<typeof shape>>> = {
  name: "pathrule_record_learning",
  title: "Record Project Learning",
  description:
    "Save a source-backed project synthesis in Pathrule's separate advisory learning layer. " +
    "Use only after reading the cited sources; provide their observed hashes. The server verifies current working bytes before saving. " +
    "This does not create a memory, rule, skill, or team policy. Findings reach every workspace member's context as advisory hypotheses with no human review step, so record only what the cited sources show. Context delivery rechecks evidence per checkout and withholds changed sources. " +
    "Works without a local LLM; does not run model inference or write files in the source repo. Cloud workspaces share only the synthesis and source references.",
  inputSchema: shape,
  handler: async (args) => {
    try {
      const cwd = args.cwd ?? process.cwd();
      const target = await resolveWorkspaceTarget({ cwd });
      if (!target.ok) return formatToolError(target.error);
      const backend = target.ctx.backend;
      const match = await backend?.resolveWorkspaceFromCwd(cwd);
      if (
        !backend?.putLearningClaim ||
        !match?.localRootPath ||
        match.workspaceId !== target.workspaceId
      )
        return formatToolError({
          code: "invalid_args",
          message: "Learning requires a bound local checkout and a learning-capable backend.",
        });
      const root = await realpath(match.localRootPath);
      if (!(await projectMapPath(match.workspaceId, root, process.env)))
        return formatToolError({
          code: "invalid_args",
          message: "Pathrule storage must be outside the source repository.",
        });
      const claim = createLearningClaim({
        workspaceId: match.workspaceId,
        nodePath: args.node_path,
        topic: args.topic,
        statement: args.statement,
        category: args.category,
        sources: args.sources,
        reviewSources: args.review_sources,
      });
      const currency = await verifyLearningSources(root, claim.sources);
      if (currency !== "current")
        return {
          ok: false,
          error: {
            code: "source_verification_required",
            currency,
            message:
              "Cited working bytes changed or could not be verified. Read the sources again before recording a synthesis.",
          },
        };
      if (
        claim.reviewSources?.length &&
        (await verifyReviewEvidence(
          {
            workspaceId: match.workspaceId,
            localRootPath: root,
          },
          claim.reviewSources,
        )) !== "current"
      )
        return {
          ok: false,
          error: {
            code: "review_verification_required",
            message:
              "Review evidence is missing, changed or expired. Use pathrule_review_history on this checkout before saving.",
          },
        };
      if (args.replaces_id) {
        if (!backend.reviseLearningClaim) throw new Error("Learning revisions unavailable");
        await backend.reviseLearningClaim({
          workspaceId: match.workspaceId,
          id: args.replaces_id,
          replacement: claim,
        });
        await noteLearningChanged(match.workspaceId);
        return {
          ok: true,
          id: claim.id,
          replaced_id: args.replaces_id,
          advisory: true,
          deferred: false,
          human_message:
            "Correction saved; the prior identity is retired. Deferred changes remain local until cloud confirmation.",
        };
      }
      const saved = await backend.putLearningClaim(claim);
      await noteLearningChanged(match.workspaceId);
      return {
        ok: true,
        id: saved.id,
        advisory: true,
        deferred: false,
        human_message:
          "Source-backed synthesis saved in Pathrule as advisory learning. It is rechecked against each checkout before use and withheld wherever its cited sources changed.",
      };
    } catch (error) {
      return formatThrown(error);
    }
  },
};
