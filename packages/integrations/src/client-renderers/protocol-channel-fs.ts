// SPDX-License-Identifier: Apache-2.0
// The disk edge of the protocol-channel decision. Node-only (it reads files);
// the decision itself stays pure in `protocol-channel.ts`.
//
// One call site for both halves of the sync, so the file writer and the index
// writer cannot disagree:
//
//   const channel = await resolveWorkspaceProtocolChannel({ workspaceRoot, enabled, env });
//   renderForClients(input, enabled, { protocolOnHook: channel.signatureClients });
//   await syncHookIndex({ ..., protocol: channel.protocol });
//
// Cost is why the checks run in this order. Measured 2026-08-25:
//
//   detectInstalledHooks   ~1 ms      (8 small config reads)
//   planRecovery           139 ms cold / 56 ms warm on this repo,
//                          315 ms cold / 113 ms warm on calcom-demo
//
// Companion re-render runs after every knowledge write, so a 300 ms tree walk on
// that path is not acceptable. The flag is checked FIRST and returns before any
// I/O, so a workspace with the switch off pays nothing at all. The recovery walk
// is then latched per workspace, because what it looks for (a leftover from an
// older Pathrule) is rare and changes only when the user acts on it.

import type { AgentTargetId } from "@pathrule/core/skills/agent-targets.js";
import { detectInstalledHooks } from "../skills/disk-detection.js";
import { renderProtocolRulesFile } from "../pathrule-protocol.js";
import { planRecovery } from "./recovery-scan.js";
import { resolveProtocolChannel } from "./protocol-channel.js";
import { KEEP_CURRENT } from "./claude-knowledge-renderer.js";

export type ProtocolChannelOffReason =
  /** The rollout switch is not on for this machine. */
  | "flag_off"
  /** No enabled client has a Pathrule hook installed, so nothing would deliver it. */
  | "no_hook"
  /** A real backup is still waiting to be restored: recovery first, signature after. */
  | "pending_recovery";

export interface WorkspaceProtocolChannel {
  /** Clients whose instruction file gets the signature. Empty ⇒ nothing changes. */
  signatureClients: AgentTargetId[];
  /** The rendered protocol, present exactly when `signatureClients` is non-empty. */
  protocol?: string;
  /** Why the channel is off. Absent when it is on. */
  off?: ProtocolChannelOffReason;
}

/**
 * The rollout switch, now ON by default. `PATHRULE_SIGNATURE_MODE=off` (or
 * `0`/`false`) is the kill switch.
 *
 * It shipped off because the rule here is to measure before declaring, and the
 * measurement is now in. On a 27-memory workspace, 20 prompts and 300 tool calls
 * (2026-09-01):
 *
 *   hook injection      14.543 → 16.893 tok   (+2.351, the protocol and team
 *                                              block now ride SessionStart)
 *   always-loaded files  4.977 →    170 tok   (−4.807, only the signature left)
 *   NET                                        −2.456 tok over 20 turns
 *   files written           26 →      0        (22 of them nested, 16.306 tok
 *                                              of lazy-loaded turn-zero text)
 *
 * So the change users asked for — stop writing into our repo — is also cheaper,
 * because a constant block on SessionStart is paid once into the system prompt
 * while a compiled file is paid on every turn that loads it.
 *
 * Two gates still stand between this flag and a user's checkout, and both matter
 * more than the flag: signature mode engages only for a client whose hook is
 * actually installed (no hook, no alternative channel, so the files stay), and
 * never while a recovery backup is pending.
 */
export function signatureModeEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = (env.PATHRULE_SIGNATURE_MODE ?? "").trim().toLowerCase();
  return !(raw === "off" || raw === "0" || raw === "false");
}

interface RecoveryLatch {
  pending: boolean;
  at: number;
}

const RECOVERY_LATCH = new Map<string, RecoveryLatch>();
/** Five minutes: long enough that a burst of writes walks the tree once. */
export const RECOVERY_LATCH_TTL_MS = 5 * 60 * 1000;

/**
 * Drop the latch after a recovery action, so the very next sync sees the new
 * truth instead of waiting out the TTL. Call it from restore, discard, and eject.
 */
export function invalidateRecoveryLatch(workspaceRoot?: string): void {
  if (workspaceRoot === undefined) RECOVERY_LATCH.clear();
  else RECOVERY_LATCH.delete(workspaceRoot);
}

async function hasPendingRecovery(workspaceRoot: string, now: number): Promise<boolean> {
  const cached = RECOVERY_LATCH.get(workspaceRoot);
  if (cached && now - cached.at < RECOVERY_LATCH_TTL_MS) return cached.pending;
  let pending = false;
  try {
    const plan = await planRecovery(workspaceRoot);
    // Only a RESTORABLE leftover blocks. Pathrule's own leftover output does
    // not, or the measured 7-of-8 case would hold the migration forever.
    pending = plan.restorable.length > 0 || plan.needsChoice.length > 0;
  } catch {
    // A scan we cannot complete must not silently unblock the migration: the
    // whole point of the gate is that we do not shrink a file while the user's
    // content might be sitting in a backup.
    pending = true;
  }
  RECOVERY_LATCH.set(workspaceRoot, { pending, at: now });
  return pending;
}

/**
 * Claude Code's rules folder (`.claude/rules/pathrule/`), on unless `PATHRULE_RULES_FILES` is
 * `off`/`0`/`false`. Off, Pathrule writes nothing into the project for Claude Code but its hook entry,
 * and the keep-current ask rides the session-start protocol instead.
 *
 * Keep it on. Measured 2026-10-19 on PathruleBench (Python, 500 items, 3 chains an arm, same build):
 * on 25.7 of 26 memory probes at $1.74 a chain, off 18.7 at $1.84. Every off chain scored below every on
 * chain, and the losses were lessons, changed decisions and team decisions. The hook delivered 3.6× more
 * at session start and the agent still explored more (+43% Read/Grep/Glob). What the folder adds is the
 * channel: Claude Code loads it as project instructions, which a hook's context is not. So the folder is
 * the one place Pathrule writes for Claude Code (its own names, self-ignored, removed by eject), and the
 * switch is only for a person who will not have it.
 */
export function rulesFilesEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = (env.PATHRULE_RULES_FILES ?? "").trim().toLowerCase();
  return !(raw === "off" || raw === "0" || raw === "false");
}

export async function resolveWorkspaceProtocolChannel(args: {
  workspaceRoot: string;
  enabled: readonly AgentTargetId[];
  /**
   * Clients whose hook this very sync installs (a renderer that writes the hook config). Counted as
   * installed, or the first sync of a new client writes the full protocol into the person's file and
   * only the second one takes it out again.
   */
  installing?: readonly AgentTargetId[];
  env?: NodeJS.ProcessEnv;
  /** Home directory for user-level hook configs; defaults to the real one. */
  home?: string;
  now?: number;
}): Promise<WorkspaceProtocolChannel> {
  const env = args.env ?? process.env;
  if (!signatureModeEnabled(env)) return { signatureClients: [], off: "flag_off" };

  const hookInstalled = [...(await detectInstalledHooks(args.workspaceRoot, { home: args.home })), ...(args.installing ?? [])];
  const pendingRecovery = await hasPendingRecovery(args.workspaceRoot, args.now ?? Date.now());

  const decision = resolveProtocolChannel({
    enabled: args.enabled,
    hookInstalled,
    pendingRecovery,
  });

  if (decision.signatureClients.length === 0) {
    return {
      signatureClients: [],
      off: pendingRecovery ? "pending_recovery" : "no_hook",
    };
  }

  const protocol = renderProtocolRulesFile({ skills: false });
  // Without the rules folder, its first file's ask to keep the knowledge current has no file to ride.
  const ask = decision.signatureClients.includes("claude-code") && !rulesFilesEnabled(env) ? `\n${KEEP_CURRENT}` : "";
  return { signatureClients: decision.signatureClients, protocol: `${protocol}${ask}` };
}
