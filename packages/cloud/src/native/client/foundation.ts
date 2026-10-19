// SPDX-License-Identifier: Apache-2.0
// The Foundation adapters over the native Cloud's `/foundation/(memory|learning)/:op` routes: the
// memory operations and the learning claim store, one workspace per instance.
import type { KnowledgeBackend } from "@pathrule/core/backend/knowledge-backend.js";
import {
  learningRevisionConflict,
  type LearningClaimStore,
} from "@pathrule/core/project-learning/claims.js";

import { cloudHttp, CloudHttpError, type CloudTransport } from "./http.js";

export type CloudMemoryAdapter = Pick<
  Required<KnowledgeBackend>,
  | "ensureNodeForPath"
  | "writeMemory"
  | "isDemoWorkspace"
  | "getNode"
  | "closestNode"
  | "checkContentDedup"
  | "readMemory"
  | "listMemories"
  | "updateMemory"
  | "deleteMemory"
  | "restoreMemory"
  | "relevantMemoriesForPath"
  | "buildHookIndexPayload"
  | "buildWarehousePayload"
>;
export type CloudLearningClaimStore = Required<LearningClaimStore>;

export function createCloudFoundationAdapters(config: CloudTransport, workspaceId: string) {
  const request = cloudHttp(config);
  const call = async <T>(family: string, method: string, args: unknown[]): Promise<T> => {
    try {
      return await request<T>(
        "/v1/workspaces/" +
          encodeURIComponent(workspaceId) +
          "/foundation/" +
          family +
          "/" +
          method,
        { args },
      );
    } catch (e) {
      if (e instanceof CloudHttpError && e.status === 409) {
        if (family === "learning") throw learningRevisionConflict();
        if (method === "updateMemory") throw new Error("content_version_conflict");
      }
      throw e;
    }
  };
  const memory: CloudMemoryAdapter = {
    ensureNodeForPath: (...args) => call("memory", "ensureNodeForPath", args),
    writeMemory: (...args) => call("memory", "writeMemory", args),
    isDemoWorkspace: (...args) => call("memory", "isDemoWorkspace", args),
    getNode: (...args) => call("memory", "getNode", args),
    closestNode: (...args) => call("memory", "closestNode", args),
    checkContentDedup: (...args) => call("memory", "checkContentDedup", args),
    readMemory: (...args) => call("memory", "readMemory", args),
    listMemories: (...args) => call("memory", "listMemories", args),
    updateMemory: (...args) => call("memory", "updateMemory", args),
    deleteMemory: (...args) => call("memory", "deleteMemory", args),
    restoreMemory: (...args) => call("memory", "restoreMemory", args),
    relevantMemoriesForPath: (...args) => call("memory", "relevantMemoriesForPath", args),
    buildHookIndexPayload: (...args) => call("memory", "buildHookIndexPayload", args),
    buildWarehousePayload: (...args) => call("memory", "buildWarehousePayload", args),
  };
  const learning: CloudLearningClaimStore = {
    putLearningClaim: (...args) => call("learning", "putLearningClaim", args),
    listLearningClaims: (...args) => call("learning", "listLearningClaims", args),
    retiredLearningClaimIds: (...args) => call("learning", "retiredLearningClaimIds", args),
    reviseLearningClaim: (...args) => call("learning", "reviseLearningClaim", args),
  };
  return { memory, learning };
}

// LearningClaimStore's workspace argument is part of its existing neutral contract.
export function createCloudHttpLearningClaimStore(config: CloudTransport): CloudLearningClaimStore {
  return {
    putLearningClaim: (claim) =>
      createCloudFoundationAdapters(config, claim.workspaceId).learning.putLearningClaim(claim),
    listLearningClaims: (ws, limit) =>
      createCloudFoundationAdapters(config, ws).learning.listLearningClaims(ws, limit),
    retiredLearningClaimIds: (ws, ids) =>
      createCloudFoundationAdapters(config, ws).learning.retiredLearningClaimIds(ws, ids),
    reviseLearningClaim: (input) =>
      createCloudFoundationAdapters(config, input.workspaceId).learning.reviseLearningClaim(input),
  };
}
