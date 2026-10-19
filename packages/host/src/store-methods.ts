// SPDX-License-Identifier: Apache-2.0
/**
 * The store methods a client reaches through `store.invoke`: every asynchronous public method of
 * core's `LocalBackend`, the local store the host owns. The host serves the processes that, until
 * Phase 4, open the store themselves, so it gives them the same surface.
 *
 * Not reachable: `close` (the host owns the lifetime), the synchronous methods but the few below
 * (the hook-index builders run where the store is), and `capabilities`, which a remote store
 * answers from the value it read once (`store.capabilities`). `store-methods.test.ts` fails when
 * `LocalBackend` gains or loses an asynchronous method this list does not match.
 */
export const HOST_STORE_METHODS = [
  "sessionIsCurrent",
  "resolveWorkspaceFromCwd",
  "closestNode",
  "readMemory",
  "writeMemory",
  "updateMemory",
  "deleteMemory",
  "restoreMemory",
  "listMemories",
  "readRule",
  "writeRule",
  "updateRule",
  "deleteRule",
  "restoreRule",
  "listRules",
  "readSkill",
  "writeSkill",
  "updateSkill",
  "deleteSkill",
  "restoreSkill",
  "listSkills",
  "getTree",
  "getNode",
  "getNodeDetail",
  "workspaceOverview",
  "findNodeByPath",
  "getNodeContent",
  "listSkillsForInvocation",
  "getNodeForRule",
  "getNodeForSkill",
  "ensureNodeForPath",
  "moveNodePath",
  "isDemoWorkspace",
  "checkContentDedup",
  "subtreeMemoryIndex",
  "projectMapSearch",
  "getHotPaths",
  "recordMemoryContextPaths",
  "rankPriorSolutions",
  "findCoupledNodes",
  "refreshWorkEpisodes",
  "searchWorkEpisodes",
  "compiledMemoryDeliveries",
  "buildHookIndexPayload",
  "buildWarehousePayload",
  "buildKnowledgeMapInput",
  "knowledgeMapFingerprint",
  "buildEmbeddingsPayload",
  "embeddingSpace",
  "embeddingCoverage",
  "reindexEmbeddings",
  "buildKnowledgePayload",
  "assembleBriefing",
  "relevantMemoriesForPath",
  "logActivity",
  "putLearningClaim",
  "retiredLearningClaimIds",
  "reviseLearningClaim",
  "listLearningClaims",
  "learningActivities",
  "ingestRuntimeEvents",
  "listRuntimeEventGroups",
  "runtimeEventIndicator",
  "runtimeEventStatus",
  "runtimeIndicatorSnapshot",
  "recordRuntimeCorrection",
  "pruneRuntimeEvents",
  "recentActivities",
  "recentActivitiesForRouter",
  "proposeRemedyAtom",
  "listProposedRemedyAtoms",
  "listActiveRemedyAtoms",
  "listActiveScopedRemedies",
  "proposeSelectionAtom",
  "proposeProcedureAtom",
  "listProposedSelectionAtoms",
  "listProposedProcedureAtoms",
  "decideSelectionAtom",
  "decideProcedureAtom",
  "listActiveScopedSelections",
  "listActiveScopedProcedures",
  "proposeContextAtom",
  "proposeRationaleAtom",
  "listProposedContextAtoms",
  "listProposedRationaleAtoms",
  "decideContextAtom",
  "decideRationaleAtom",
  "listActiveScopedContexts",
  "listActiveScopedRationales",
  "proposePrecedenceAtom",
  "listProposedPrecedenceAtoms",
  "decidePrecedenceAtom",
  "listActiveScopedPrecedences",
  "recordRemedyDelivery",
  "listRemedyDeliveries",
  "recordKnowledgeEvidence",
  "observeToolEvent",
  "observeErrorPersistence",
  "listKnowledgeEvidence",
  "explainAtomEvidence",
  "ingestObservationsFromDisk",
  "recordGroundedAtom",
  "aggregateAtomEvidence",
  "listRemedyAtomsForSubject",
  "decideRemedyAtom",
  "listPendingRefreshes",
  "getRefreshBrief",
  "resolveRefresh",
  "requestRefresh",
  "routeIntent",
  "semanticCandidates",
] as const;

export type HostStoreMethod = (typeof HOST_STORE_METHODS)[number];

/**
 * The synchronous methods a client may call too, because a surface uses them away from the store:
 * registering a workspace's root (the CLI's init, Cloud's mirror), its name (the CLI's companion
 * files), and the approved atoms the learning hints read. The host runs them where the store is;
 * a remote store answers them asynchronously, so callers await them.
 */
export const HOST_STORE_SYNC_METHODS = [
  "registerWorkspace",
  "getWorkspaceName",
  "contextsForHookIndex",
  "rationalesForHookIndex",
] as const;

export type HostStoreSyncMethod = (typeof HOST_STORE_SYNC_METHODS)[number];

/** Every store method a client may call, as `host.hello` lists them (`storeMethods`). */
export const HOST_STORE_CALLABLE: readonly (HostStoreMethod | HostStoreSyncMethod)[] = [
  ...HOST_STORE_METHODS,
  ...HOST_STORE_SYNC_METHODS,
];

const METHODS: ReadonlySet<string> = new Set(HOST_STORE_CALLABLE);

export function isHostStoreMethod(name: string): name is HostStoreMethod | HostStoreSyncMethod {
  return METHODS.has(name);
}
