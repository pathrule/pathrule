// SPDX-License-Identifier: Apache-2.0
// @pathrule/core — the open, backend-agnostic knowledge layer.
//
// This barrel is the package's PUBLIC API: the backend seam (the interface +
// its capability flags + the I/O contract types), the two shipped backends
// (the embedded-SQLite LocalBackend and the dependency-light InMemory reference,
// which third-party backend authors can use as a behavioral template), and the
// local principal resolver. Storage internals (the SQLite schema/migrations), the
// identity fallback constant, and the bring-your-own-embedding adapter are
// intentionally NOT re-exported — they are implementation details reachable
// internally by relative import, and exporting them would lock them into the
// package's compatibility surface.

export type { BackendCapabilities } from "./backend/capabilities.js";
export type { KnowledgeBackend } from "./backend/knowledge-backend.js";
export type * from "./backend/inputs.js";
export type * from "./backend/knowledge-map-input.js";
// Native Knowledge Compilation: the per-directory payload type referenced by
// KnowledgeBackend.buildKnowledgePayload, plus the pure assembler itself —
// exported so every backend (including Pathrule Cloud's and any
// third-party backend) compiles knowledge identically from its own store.
export type {
  AssembleKnowledgeOptions,
  CompiledKnowledgeNode,
  KnowledgeRenderMode,
} from "./backend/knowledge-compiler.js";
export { assembleKnowledgeNodes } from "./backend/knowledge-compiler.js";
export type { HookIndexInput } from "./backend/hook-index.js";
// The deterministic hook-index + full-body warehouse assemblers, so an offline
// runtime (and the benchmark harness) can build exactly what the supervisor reads.
export { assembleHookIndex, assembleWarehouse } from "./backend/hook-index.js";
// BYO embedding helpers — exposed so the benchmark harness can precompute a
// fixture's embeddings.json (the same vectors the hook ranks against).
export { embedTextBYO, hasEmbeddingKey } from "./backend/embedding-adapter.js";
export { composeEmbeddingText, cosineSimilarity } from "./backend/semantic-rank.js";
export { InMemoryKnowledgeBackend } from "./backend/in-memory-backend.js";
export type { InMemoryBackendOptions } from "./backend/in-memory-backend.js";
export { LocalBackend } from "./backend/local/local-backend.js";
export type { LocalBackendOptions } from "./backend/local/local-backend.js";
// The local principal resolver, so the local MCP server composition can stamp
// ctx.userId without re-deriving the OS-username logic.
export { resolveLocalPrincipal } from "./backend/local/identity.js";
// Path-segment classification. Exported because every surface that places a
// path-scoped file (knowledge compilation, the client renderers, node
// materialisation) must agree on what counts as a directory, and Pathrule runs
// on Xcode, Gradle, and Unity trees as much as on TypeScript ones.
export { isDirectoryLeafName, isDirectoryPath, lastSegment } from "./paths/leaf-type.js";
// Well-known workspace locations (the .pathrule state dir, the backup vault),
// shared so desktop, CLI, and MCP never disagree about where a backup lives.
export {
  BACKUP_DIR,
  MANAGED_FILES_LEDGER,
  PATHRULE_DIR,
  backupRelativePath,
} from "./paths/workspace-files.js";
// Anchored-region contract + ownership detection. Exported from core because
// EVERY writer must agree on them: the multi-client disk writer, the dedicated
// root-CLAUDE.md path, the CLI, and any recovery flow. Two code paths checking
// different banners is exactly the bug this consolidation removed.
export {
  PATHRULE_REGION,
  hasRegion,
  isEntirelyPathrule,
  mergeRegionInto,
  spliceRegion,
  stripRegion,
  type RegionAnchors,
} from "./paths/region.js";
export { PATHRULE_MANAGED_MARKERS, isPathruleManaged } from "./paths/ownership.js";
// Which files each agent reads as project instructions, and how strong the
// evidence for that is. The delivery promise is only as good as this table.
export {
  AGENT_INSTRUCTION_CHANNELS,
  coversAgent,
  instructionChannel,
  matchesReadPattern,
  type AgentInstructionChannel,
  type ChannelEvidence,
  type InstructionPrecedence,
  type PathScopedChannel,
} from "./paths/agent-instruction-channels.js";
// Recovery for repos synced by an older Pathrule that took instruction files
// over. Report-only by design: the user decides what comes back.
export {
  buildRecoveryPlan,
  restoredBody,
  type Leftover,
  type LeftoverKind,
  type RecoveryPlan,
  type ScannedFile,
} from "./paths/recovery.js";

// Navigation ROI — the hook writes navigation.jsonl on every routed prompt, and until
// 2026-08-22 nothing but its own test read it. Exported here because the MCP server now
// summarizes it at the activity-log boundary and ships the numbers to the Summary
// surface: a routing engine with no measured accuracy cannot be tuned, only guessed at.
export {
  parseNavigationLines,
  summarizeNavigationRoi,
  type NavigationEvent,
  type NavigationRoiSummary,
} from "./backend/navigation-roi.js";
