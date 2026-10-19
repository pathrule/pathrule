// SPDX-License-Identifier: Apache-2.0
// `pathrule rule checks` and `pathrule rule approve-check <rule-id> <check-id>` (local/check-approval.ts),
// for the folder's edition: a Pathrule Local folder's store here, a Pathrule Cloud folder's Project
// backend from the Cloud plugin (it passes `store`).
import { createInterface } from "node:readline/promises";

import { resolveLocalPrincipal } from "@pathrule/core";

import { decideCheck, describeCheck, listRuleChecks, type CheckDecision } from "../local/check-approval.js";
import type { ContentStore } from "../local/content-local.js";
import { withCliHostSession } from "../local/host-session.js";
import { statusLabel, type CliOutputMode } from "../output.js";
import type { CliRuntime } from "../plugin.js";

export const RULE_CHECK_SUBCOMMANDS = new Set(["checks", "approve-check"]);

/** The store, its folder and the person, for a Local folder or the one the Cloud plugin passes. */
export interface CheckStore extends ContentStore {
  root: string;
  userId: string;
}

const OUTCOME: Record<CheckDecision, string> = {
  approved: "Approved. Agents' turns under this path now need this command to have passed.",
  declined: "Not approved. The check stays a proposal and holds nothing open.",
  changed: "Not approved: the check changed after it was shown. Run the command again to see it as it is now.",
  no_terminal: "Not approved: approving a check needs a person at a terminal. Run this in your own terminal.",
  already_active: "This check is already approved.",
};

function canAsk(runtime: CliRuntime, mode: CliOutputMode): boolean {
  if (mode.json || !mode.interactive) return false;
  if (runtime.promptLine) return true;
  if (process.env.NODE_ENV === "test") return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function ask(runtime: CliRuntime, question: string): Promise<string> {
  if (runtime.promptLine) return runtime.promptLine(question);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function withStore<T>(runtime: CliRuntime, store: CheckStore | undefined, fn: (s: CheckStore) => Promise<T>): Promise<T> {
  if (store) return fn(store);
  return withCliHostSession(runtime.env, async (session) => {
    const match = session.resolveLocal(runtime.cwd);
    if (!match) throw new Error("No local Pathrule workspace covers this folder. Run: pathrule init --local");
    return fn({
      backend: await session.store(match.workspaceId),
      workspaceId: match.workspaceId,
      root: match.root,
      userId: resolveLocalPrincipal(runtime.env),
    });
  });
}

/** Runs one check subcommand; returns the exit code. */
export async function runRuleChecks(
  sub: string,
  args: string[],
  runtime: CliRuntime,
  mode: CliOutputMode,
  store?: CheckStore,
): Promise<number> {
  return withStore(runtime, store, async (s) => {
    if (sub === "checks") {
      const rows = await listRuleChecks(s.backend, s.workspaceId);
      if (mode.json) {
        runtime.stdout.write(`${JSON.stringify({ ok: true, data: { checks: rows } })}\n`);
        return 0;
      }
      if (rows.length === 0) runtime.stdout.write("No rule has a check.\n");
      for (const row of rows) {
        runtime.stdout.write(`${row.status === "active" ? "approved" : "proposed"}  ${row.rule_id} ${row.check_id}\n`);
        for (const line of describeCheck(row).slice(0, 3)) runtime.stdout.write(`  ${line}\n`);
      }
      if (rows.some((r) => r.status === "proposed"))
        runtime.stdout.write("Decide on one: pathrule rule approve-check <rule-id> <check-id>\n");
      return 0;
    }
    const [ruleId, checkId] = args;
    if (!ruleId || !checkId) {
      runtime.stderr.write(`${statusLabel("error", mode)} Usage: pathrule rule approve-check <rule-id> <check-id>\n`);
      return 64;
    }
    const { decision } = await decideCheck({
      ...s,
      ruleId,
      checkId,
      env: runtime.env,
      ask: canAsk(runtime, mode) ? (q) => ask(runtime, q) : null,
      show: (lines) => {
        if (!mode.json) for (const line of lines) runtime.stdout.write(`${line}\n`);
      },
    });
    if (mode.json) runtime.stdout.write(`${JSON.stringify({ ok: decision === "approved" || decision === "already_active", data: { decision } })}\n`);
    else runtime.stdout.write(`${statusLabel(decision === "approved" || decision === "already_active" ? "ok" : "info", mode)} ${OUTCOME[decision]}\n`);
    return decision === "approved" || decision === "already_active" ? 0 : decision === "declined" ? 0 : 1;
  });
}
