// SPDX-License-Identifier: Apache-2.0
// The Project `KnowledgeBackend` of one native Cloud workspace, over its
// `/v1/workspaces/:ws/foundation/project/:op` routes. One instance per explicitly mapped workspace.
import { isAbsolute } from "node:path";
import type { BackendCapabilities } from "@pathrule/core/backend/capabilities.js";
import type { KnowledgeBackend } from "@pathrule/core/backend/knowledge-backend.js";
import type { StatementExtraction, StatementPrompt } from "@pathrule/core/maintenance/model-statements.js";
import { learningRevisionConflict } from "@pathrule/core/project-learning/claims.js";
import type { Skill } from "@pathrule/protocol/content-types.js";
import { normalizeFilesTouched } from "@pathrule/protocol/normalize-workspace-path.js";

import {
  runtimeEventGroupFromCloud,
  type CloudSignalGroupRow,
  type RuntimeEventHistoryEntry,
  type RuntimeEventsPage,
  type RuntimeEventsStatus,
  type SignalEnvironment,
} from "@pathrule/protocol/runtime-events.js";
import { cloudHttp, CloudHttpError, type CloudTransport } from "./http.js";
import { createCloudSignalsClient } from "./signals.js";
import type { CloudEmbeddingSpace } from "./semantic.js";

export interface CloudProjectOptions {
  localRootPath?: string;
  runtimeId?: string;
  embeddingSpace?: CloudEmbeddingSpace;
}

/** A skill with its package files, as the Cloud stores them. */
export interface CloudSkillPackage {
  skill: Skill;
  files: { path: string; body: string; object_key: string | null; revision: number }[];
}

/** An item's revisions, newest first, 20 at a time (the Cloud service's `knowledgeHistory`). */
export interface CloudKnowledgeHistory {
  // The snapshot is the stored revision as the Cloud wrote it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  items: {
    revision: number;
    snapshot: Record<string, any>;
    created_by: string;
    created_at: number;
  }[];
  nextBeforeRevision: number | null;
}

/** The Project backend, plus the two reads only the Cloud keeps: history and skill packages. */
export interface CloudProjectHttpBackend extends KnowledgeBackend {
  /** The Cloud's model tier for the stated-decision capture: the statements it copied out of these prompts. */
  extractStatements(prompts: StatementPrompt[]): Promise<StatementExtraction>;
  knowledgeHistory(id: string, before?: number): Promise<CloudKnowledgeHistory>;
  skillPackage(id: string): Promise<CloudSkillPackage>;
}

/** `/signals/groups` as the Cloud answers it. */
interface CloudSignalGroupsPage {
  items: CloudSignalGroupRow[];
  nextCursor: string | null;
  history?: RuntimeEventHistoryEntry[];
}

/** The part of `/signals/status` a runtime events read uses. */
interface CloudRuntimeStatus {
  connected: boolean;
  lastSeen: string | null;
  activeCount: number;
  declaredCount: number;
  groupCount: number;
  releases?: Array<{
    environment: string;
    release: string | null;
    envelopes: number;
    firstSeen: string;
    lastSeen: string;
  }>;
}

/**
 * The version of the Local to Cloud knowledge copy a workspace's Project routes accept, read from
 * its capabilities (`knowledgeTransfer`): create-only writes with a client id (`ifAbsent`) and an
 * item's `origin`. 0 when the Cloud does not offer it, and then nothing may be copied: an older
 * Cloud would ignore `ifAbsent` and overwrite an item a second run finds.
 */
export function knowledgeTransferVersion(backend: Pick<KnowledgeBackend, "capabilities">): number {
  // The flag is not a field of core's BackendCapabilities: the Cloud's answer is kept whole.
  const value = (backend.capabilities() as unknown as { knowledgeTransfer?: unknown })
    .knowledgeTransfer;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

const NO_RUNTIME_STATUS: RuntimeEventsStatus = {
  source: "cloud",
  connected: false,
  lastSeen: null,
  activeCount: 0,
  declaredCount: 0,
  groupCount: 0,
  releases: [],
};

export async function createCloudProjectHttpBackend(
  transport: CloudTransport,
  workspaceId: string,
  options: CloudProjectOptions = {},
): Promise<CloudProjectHttpBackend> {
  const request = cloudHttp(transport);
  async function call<K extends keyof CloudProjectHttpBackend>(
    method: K,
    args: unknown[],
  ): Promise<Awaited<ReturnType<NonNullable<CloudProjectHttpBackend[K]>>>> {
    try {
      return await request<Awaited<ReturnType<NonNullable<CloudProjectHttpBackend[K]>>>>(
        "/v1/workspaces/" + encodeURIComponent(workspaceId) + "/foundation/project/" + method,
        { args, embeddingSpace: options.embeddingSpace, runtimeId: options.runtimeId },
      );
    } catch (e) {
      if (e instanceof CloudHttpError && e.status === 409) {
        if (method === "reviseLearningClaim" || method === "putLearningClaim")
          throw learningRevisionConflict();
        if (["updateMemory", "updateRule", "updateSkill"].includes(method))
          throw new Error("content_version_conflict");
      }
      throw e;
    }
  }
  // Runtime events have their own Signals routes on the Cloud, not Project operations.
  const signals = createCloudSignalsClient<CloudRuntimeStatus, CloudSignalGroupsPage>(transport);
  const capabilities = await request<BackendCapabilities>(
    "/v1/workspaces/" + encodeURIComponent(workspaceId) + "/foundation/project/capabilities",
    { args: [], embeddingSpace: options.embeddingSpace },
  );
  const backend: CloudProjectHttpBackend = {
    readMemory: (...args) => call("readMemory", args),
    writeMemory: (...args) => call("writeMemory", args),
    updateMemory: (...args) => call("updateMemory", args),
    deleteMemory: (...args) => call("deleteMemory", args),
    restoreMemory: (...args) => call("restoreMemory", args),
    listMemories: (...args) => call("listMemories", args),
    extractStatements: (...args) => call("extractStatements", args),
    readRule: (...args) => call("readRule", args),
    writeRule: (...args) => call("writeRule", args),
    updateRule: (...args) => call("updateRule", args),
    deleteRule: (...args) => call("deleteRule", args),
    restoreRule: (...args) => call("restoreRule", args),
    listRules: (...args) => call("listRules", args),
    readSkill: (...args) => call("readSkill", args),
    writeSkill: (...args) => call("writeSkill", args),
    updateSkill: (...args) => call("updateSkill", args),
    deleteSkill: (...args) => call("deleteSkill", args),
    restoreSkill: (...args) => call("restoreSkill", args),
    listSkills: (...args) => call("listSkills", args),
    closestNode: (...args) => call("closestNode", args),
    getTree: (...args) => call("getTree", args),
    getNode: (...args) => call("getNode", args),
    getNodeDetail: (...args) => call("getNodeDetail", args),
    workspaceOverview: (...args) => call("workspaceOverview", args),
    findNodeByPath: (...args) => call("findNodeByPath", args),
    getNodeContent: (...args) => call("getNodeContent", args),
    listSkillsForInvocation: (...args) => call("listSkillsForInvocation", args),
    getNodeForRule: (...args) => call("getNodeForRule", args),
    getNodeForSkill: (...args) => call("getNodeForSkill", args),
    ensureNodeForPath: (...args) => call("ensureNodeForPath", args),
    isDemoWorkspace: (...args) => call("isDemoWorkspace", args),
    checkContentDedup: (...args) => call("checkContentDedup", args),
    subtreeMemoryIndex: (...args) => call("subtreeMemoryIndex", args),
    projectMapSearch: (...args) => call("projectMapSearch", args),
    getHotPaths: (...args) => call("getHotPaths", args),
    recordMemoryContextPaths: async (...args) => {
      await call("recordMemoryContextPaths", args);
    },
    rankPriorSolutions: (...args) => call("rankPriorSolutions", args),
    findCoupledNodes: (...args) => call("findCoupledNodes", args),
    refreshWorkEpisodes: (...args) => call("refreshWorkEpisodes", args),
    searchWorkEpisodes: (...args) => call("searchWorkEpisodes", args),
    assembleBriefing: (...args) => call("assembleBriefing", args),
    relevantMemoriesForPath: (...args) => call("relevantMemoriesForPath", args),
    buildHookIndexPayload: (...args) => call("buildHookIndexPayload", args),
    buildWarehousePayload: (...args) => call("buildWarehousePayload", args),
    buildHookInputPayload: (...args) => call("buildHookInputPayload", args),
    buildKnowledgePayload: (...args) => call("buildKnowledgePayload", args),
    logActivity: (input) =>
      call("logActivity", [
        {
          ...input,
          filesTouched: normalizeFilesTouched(input.filesTouched, options.localRootPath ?? "")
            .normalized,
        },
      ]),
    learningActivities: (...args) => call("learningActivities", args),
    recentActivities: (...args) => call("recentActivities", args),
    recentActivitiesForRouter: (...args) => call("recentActivitiesForRouter", args),
    listPendingRefreshes: (...args) => call("listPendingRefreshes", args),
    getRefreshBrief: (...args) => call("getRefreshBrief", args),
    resolveRefresh: (...args) => call("resolveRefresh", args),
    requestRefresh: (...args) => call("requestRefresh", args),
    putLearningClaim: (...args) => call("putLearningClaim", args),
    listLearningClaims: (...args) => call("listLearningClaims", args),
    retiredLearningClaimIds: (...args) => call("retiredLearningClaimIds", args),
    reviseLearningClaim: (...args) => call("reviseLearningClaim", args),
    semanticCandidates: (...args) => call("semanticCandidates", args),
    async listRuntimeEventGroups(ws, query = {}) {
      try {
        const page = await signals.readSignalGroups(ws, {
          groupId: query.groupId,
          path: query.path,
          kind: query.kind,
          environment: query.environment,
          status: query.status,
          verification: query.verification,
          limit: query.limit,
          before: query.cursor,
        });
        const result: RuntimeEventsPage = {
          source: "cloud",
          items: page.items.map(runtimeEventGroupFromCloud),
          nextCursor: page.nextCursor,
        };
        if (page.history) result.history = page.history;
        return result;
      } catch (e) {
        // A query the Cloud refuses is the caller's to fix; a group it does not know reads as none.
        if (e instanceof CloudHttpError && e.status === 400) return { error: e.message };
        if (e instanceof CloudHttpError && e.status === 404)
          return { source: "cloud", items: [], nextCursor: null, history: [] };
        throw e;
      }
    },
    async runtimeEventStatus(ws) {
      try {
        const status = await signals.readRuntimeStatus(ws);
        return {
          source: "cloud",
          connected: status.connected,
          lastSeen: status.lastSeen,
          activeCount: status.activeCount,
          declaredCount: status.declaredCount,
          groupCount: status.groupCount,
          releases: (status.releases ?? []).map((r) => ({
            environment: r.environment as SignalEnvironment,
            release: r.release,
            envelopes: r.envelopes,
            firstSeen: r.firstSeen,
            lastSeen: r.lastSeen,
          })),
        };
      } catch {
        // Coverage only adds to a read that already succeeded; without it the groups still stand.
        return { ...NO_RUNTIME_STATUS, releases: [] };
      }
    },
    recordRuntimeCorrection: (ws, input) => signals.recordRuntimeCorrection(ws, input),
    knowledgeHistory: (...args) => call("knowledgeHistory", args),
    skillPackage: (...args) => call("skillPackage", args),
    async sessionIsCurrent() {
      try {
        return await call("sessionIsCurrent", []);
      } catch (e) {
        if (e instanceof CloudHttpError && (e.status === 401 || e.status === 403)) return false;
        throw e;
      }
    },
    async resolveWorkspaceFromCwd(cwd) {
      if (!options.localRootPath) return call("resolveWorkspaceFromCwd", [cwd]);
      // Filesystem paths remain local when the composition supplies a durable root.
      await request("/v1/workspaces/" + encodeURIComponent(workspaceId));
      if (
        typeof cwd !== "string" ||
        !isAbsolute(cwd) ||
        cwd.split(/[\\/]/).some((p) => p === "." || p === "..")
      )
        throw new Error("Absolute canonical cwd required");
      // Compared with forward slashes, so a Windows root and cwd (`C:\repo`) match as on POSIX.
      const root = options.localRootPath.replace(/\\/g, "/").replace(/\/$/, "") || "/",
        p = cwd.replace(/\\/g, "/").replace(/\/$/, "") || "/";
      return p === root || p.startsWith(root === "/" ? "/" : root + "/")
        ? {
            workspaceId,
            localRootPath: options.localRootPath.replace(/[\\/]$/, "") || root,
            relativePath: p === root ? "" : root === "/" ? p : p.slice(root.length),
          }
        : null;
    },
    capabilities: () => ({ ...capabilities }),
  };
  return backend;
}
