// SPDX-License-Identifier: Apache-2.0
// Which channel carries the agent protocol, decided ONCE for both halves.
//
// The protocol can live on disk (compiled into the user's instruction file) or
// on the hook index (injected once per session). The two halves are written by
// two different code paths — `renderForClients` for the files, `syncHookIndex`
// for the index — and the failure mode of letting each decide for itself is not
// symmetric:
//
//   both channels  → the agent reads the protocol twice on the first prompt.
//                    Wasteful, harmless.
//   neither        → the protocol is gone. Silent behaviour regression.
//
// So the decision is a single pure function whose output feeds both, and the
// invariant `protocolOnIndex === (signatureClients.length > 0)` is pinned by a
// test rather than by hoping two call sites stay in step.

import type { AgentTargetId } from "@pathrule/core/skills/agent-targets.js";

/**
 * Clients Pathrule can install a hook for. Derived from what
 * `hook-supervisor/client-config-writer.ts` can actually emit
 * (renderClaudeSettings / Cursor / Codex / Copilot). Windsurf has no hook
 * builder, so its protocol must stay on disk: signature mode there would remove
 * the protocol with nothing delivering it.
 */
export const HOOK_CAPABLE_CLIENTS: readonly AgentTargetId[] = [
  "claude-code",
  "cursor",
  "codex",
  "copilot",
];

/**
 * Hook clients whose prompt event carries context, so the hook delivers the person's preferences and
 * guidance on the prompt they match. Cursor's beforeSubmitPrompt and Copilot's userPromptSubmitted
 * accept none (`pathrule-hook.js` skips their prompt event); all four accept the session start.
 */
export const PROMPT_CONTEXT_HOOK_CLIENTS: readonly AgentTargetId[] = ["claude-code", "codex"];

export interface ProtocolChannelInput {
  /** Clients this workspace renders companion files for. */
  enabled: readonly AgentTargetId[];
  /**
   * True when this workspace still has RESTORABLE leftovers: an older Pathrule
   * took a user's instruction file over and their content is sitting in a
   * `backup.*` file (see paths/recovery.ts).
   *
   * Such a workspace must not go to signature mode yet. Shrinking the region to
   * three lines there leaves the user looking at a three-line CLAUDE.md while
   * their real instructions are still in a backup, which reads as "Pathrule
   * deleted my file" no matter how correct the mechanism is. Recovery first,
   * signature after.
   *
   * Only RESTORABLE leftovers block. Pathrule's own leftover output does not:
   * measured on a real repo, 7 of 8 leftovers across two workspaces were
   * Pathrule backing up its own bytes, and letting those block the migration
   * forever would be a permanent hold for junk.
   */
  pendingRecovery?: boolean;
  /**
   * Clients whose Pathrule hook is verified installed for this workspace. Being
   * hook-CAPABLE is not enough: the user may never have installed it, and a
   * signature with no hook is a workspace that silently lost its protocol.
   */
  hookInstalled: readonly AgentTargetId[];
}

export interface ProtocolChannelDecision {
  /** Clients whose instruction file gets the signature instead of the protocol. */
  signatureClients: AgentTargetId[];
  /** True when the hook index must carry the rendered protocol. */
  protocolOnIndex: boolean;
}

export function resolveProtocolChannel(input: ProtocolChannelInput): ProtocolChannelDecision {
  if (input.pendingRecovery === true) return { signatureClients: [], protocolOnIndex: false };
  const capable = new Set(HOOK_CAPABLE_CLIENTS);
  const installed = new Set(input.hookInstalled);
  const signatureClients = [...new Set(input.enabled)].filter(
    (id) => capable.has(id) && installed.has(id),
  );
  return { signatureClients, protocolOnIndex: signatureClients.length > 0 };
}
