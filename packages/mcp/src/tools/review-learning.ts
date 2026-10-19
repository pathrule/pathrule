// SPDX-License-Identifier: Apache-2.0
import { parseLearningClaim } from "@pathrule/core/project-learning/claims.js";
import { realpath } from "node:fs/promises";
import { noteLearningChanged, projectMapPath } from "@pathrule/core/project-learning/index.js";
import { z } from "zod";
import { loadLearningContext } from "@pathrule/core/project-learning/claim-service.js";
import { resolveWorkspaceTarget } from "./helpers.js";
import { formatThrown, formatToolError } from "../errors.js";
import type { ToolDef } from "./types.js";

const shape = {
  cwd: z.string().optional(),
  node_path: z.string().optional(),
  action: z.enum(["inspect", "retract"]),
  id: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
};
export const reviewLearningTool: ToolDef<z.infer<z.ZodObject<typeof shape>>> = {
  name: "pathrule_review_learning",
  title: "Review Project Learning",
  description:
    "Inspect current, stale and conflicting learning hypotheses, including the statements withheld from context. Retract an explicitly rejected finding by id; only the cloud author may retract it, and the retraction applies to the whole workspace. To correct one, use pathrule_record_learning with replaces_id and newly verified sources. Retractions are durable and cannot be undone by an old offline retry. This never promotes a hypothesis to a rule.",
  inputSchema: shape,
  handler: async (args) => {
    try {
      const cwd = args.cwd ?? process.cwd();
      const target = await resolveWorkspaceTarget({ cwd });
      if (!target.ok) return formatToolError(target.error);
      const backend = target.ctx.backend;
      const match = await backend?.resolveWorkspaceFromCwd(cwd);
      if (!backend || !match?.localRootPath || match.workspaceId !== target.workspaceId)
        throw new Error("Learning review requires a bound checkout");
      const root = await realpath(match.localRootPath);
      if (!(await projectMapPath(match.workspaceId, root, process.env)))
        throw new Error("Pathrule storage must be outside the source repository");
      if (args.action === "inspect") {
        const context = await loadLearningContext({
          backend,
          workspaceId: match.workspaceId,
          localRootPath: root,
          scope: args.node_path,
        });
        const withheld = new Set(context.withheld.map((claim) => claim.id));
        const candidates = withheld.size
          ? ((await backend.listLearningClaims?.(match.workspaceId, 100)) ?? [])
              .map(parseLearningClaim)
              .filter(
                (claim) =>
                  claim && claim.workspaceId === match.workspaceId && withheld.has(claim.id),
              )
          : [];
        while (JSON.stringify(candidates).length > 3000) candidates.pop();
        return {
          ok: true,
          ...context,
          inspection_candidates: {
            for_review_only: true,
            findings: candidates,
            instruction:
              "These withheld statements are shown only for review. They must not guide implementation until corrected and verified. Missing candidates may be beyond the inspection budget.",
          },
        };
      }
      // Retraction is destructive and workspace-wide, so it runs only when named, never as
      // the fallthrough for an action the schema did not expect.
      if (args.action !== "retract") throw new Error("Unknown learning review action");
      if (!args.id || !backend.reviseLearningClaim)
        throw new Error("Retraction requires an id and a learning-capable backend");
      const result = await backend.reviseLearningClaim({
        workspaceId: match.workspaceId,
        id: args.id,
      });
      await noteLearningChanged(match.workspaceId);
      return {
        ok: true,
        ...result,
        deferred: false,
        human_message: "Retraction saved. Deferred changes remain local until cloud confirmation.",
      };
    } catch (error) {
      return formatThrown(error);
    }
  },
};
