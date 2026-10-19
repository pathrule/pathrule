// SPDX-License-Identifier: Apache-2.0
// The hook extension contract: how the standalone hook script reaches capability that is not its own.
//
// The hook (`pathrule-hook.js`, in @pathrule/integrations) observes the agent's tool and prompt events,
// reads the hook index and delivers what the index holds. It produces no intelligence and calls no
// hosted service. Anything beyond that arrives as an extension: a self-contained CommonJS module that
// an installer writes next to the hook. The hook loads an extension when its file is there and its
// contract version matches, and otherwise runs its open default, which the comments below name.
//
// The hook ships as one file with no node_modules, so it cannot import this module. Its loader carries
// the same constants, and a test in @pathrule/integrations pins the two together.

import type { HookIndex } from "./hook-index.js";

/** Bumped on any incompatible change. A loaded extension with another number is ignored, and logged. */
export const HOOK_EXTENSION_CONTRACT = 1;

/** File names, in the hook's own directory. */
export const HOOK_EXTENSION_FILES = {
  cloud: "pathrule-hook-cloud.cjs",
} as const;

export type HookExtensionKind = keyof typeof HOOK_EXTENSION_FILES;

/** What every extension module exports (`module.exports`). */
export interface HookExtensionModule<T> {
  contract: number;
  create(host: HookExtensionHost): T;
}

/** The session ledger the hook keeps per agent session. Extensions read and write named fields. */
export type HookSessionState = Record<string, unknown>;

/** The hook's output object, in Claude Code's shape; the hook converts it for other clients. */
export type HookOutput = Record<string, unknown>;

/** What the hook hands an extension: where things live, the event being handled, and its own helpers. */
export interface HookExtensionHost {
  pathruleHome: string;
  cacheDir: string;
  /** The directory the hook runs from, where the extensions and their helpers sit. */
  binDir: string;
  /** `hook-supervisor.json`: the desktop supervisor's port and token. */
  supervisorConfig: string;
  /** The hook's character budget for one prompt's body block, as delivered. */
  bodyBudgetChars: number;
  /** The event after normalisation into Claude Code's shape. */
  event: Record<string, unknown>;
  eventName: string | null;
  toolName: string | null;
  cwd: string;
  sessionId: string | null;
  sessionFile: string | null;
  clientShape: "claude" | "cursor" | "copilot" | "codex";
  index: HookIndex;
  workspaceId: string;
  logLatency(event: string | null, toolName: string | null, decision: string): void;
  /** Writes the output and exits the process. */
  emit(output: HookOutput): never;
  emitEmpty(): never;
  readSessionState(): HookSessionState;
  writeSessionState(state: HookSessionState): void;
  /** A raw path as a workspace-relative POSIX path, or null outside the workspace. */
  normalizePath(rawPath: string, workspaceRoot: string): string | null;
  /** An absolute path as a leading-slash workspace path, or null outside the workspace. */
  toRelative(absolutePath: string, workspaceRoot: string): string | null;
}

/** One emitted injection or decision. */
export interface HookInjectionRecord {
  workspaceId: string;
  sessionId: string | null;
  toolName: string | null;
  filePath: string | null;
  ruleCount: number;
  memoryCount: number;
  decision: string | null;
  ruleIds: string[];
  memoryIds: string[];
  skillIds: string[];
  injectionStrategyBreakdown?: Record<string, number>;
}

/** A ranking answer: a local query vector, or candidates a ranking service already ranked. */
export interface HookPromptRanking {
  vec: number[] | null;
  candidates: Array<{
    id: string;
    similarity: number;
    affinity?: number;
    title?: string;
    node_path?: string;
  }> | null;
  outcome: string;
}

/**
 * The cloud extension (proprietary, installed by the official build): hosted ranking, teammates' work
 * state and telemetry. The open default is in brackets.
 */
export interface HookCloudExtension {
  /** Rank a prompt over the hosted index, or null when this is not a signed-in cloud index. [null] */
  rankPrompt(input: {
    index: HookIndex;
    text: string;
    limit: number;
    minSimilarity: number;
  }): HookPromptRanking | null;
  /**
   * Before a write: ask when a teammate holds one of the paths the tool input writes (emits and
   * exits). True when the check could not complete, which never interrupts the write. [false]
   */
  askOnWorkConflict(toolInput: Record<string, unknown>): Promise<boolean>;
  /** Exploration metadata for a shell command, with a route follow-through noted. [not called] */
  exploreBash(command: string | null): Record<string, unknown>;
  /** Telemetry for a completed tool call: its outcome, exploration and verification fingerprint. [none] */
  recordToolOutcome(input: {
    response: unknown;
    failureText: string | null;
    isError: boolean;
    canonicalTool: string;
    exploration: Record<string, unknown> | null;
    verification: string | null;
  }): void;
  /** A file tool touched a routed path. [nothing] */
  noteRouteFollow(state: HookSessionState, relativePath: string): void;
  /** Route and session telemetry. [nothing] */
  logNavigation(workspaceId: string, record: Record<string, unknown>): void;
  /** The injection log the desktop drains. [nothing] */
  logInjection(record: HookInjectionRecord): void;
}
