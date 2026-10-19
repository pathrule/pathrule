// SPDX-License-Identifier: Apache-2.0
/**
 * A person's decision on a CHECK (agent-ir atoms/check.ts): `pathrule rule checks` lists them and
 * `pathrule rule approve-check <rule-id> <check-id>` asks for one decision.
 *
 * Pathrule never runs a CHECK's command. An approved CHECK means an agent's turn that changes files
 * under its path cannot finish until the agent has run exactly that command and it passed. A
 * proposal compiles to nothing; only this approval, which core's `approveRuleCheckHandler` makes,
 * lets it hold a turn open.
 *
 * - The person sees the command as its exact words, the path it applies under and what approving
 *   does, and answers in a terminal. Anything but "yes" is a refusal, which leaves the CHECK inert.
 * - The decision is bound to an approval hash of the workspace, rule, check, path, command and
 *   fingerprint shown. The CHECK is read again before approving: if any of them changed since it was
 *   shown, nothing is approved. A changed command is a new proposal (a new atom), so an approval
 *   never carries over to another command.
 * - No terminal, no approval: a script, CI or an agent without a terminal cannot approve.
 * - Each decision is appended to ~/.pathrule/logs/check-approvals.jsonl: the time, the ids, the path,
 *   the approval hash and the outcome. Never the command's words, which may carry a secret.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type { KnowledgeBackend } from "@pathrule/core";
import type { RuleCheck } from "@pathrule/protocol/rule-atoms.js";
import { localRuntimePaths } from "@pathrule/core/storage/paths.js";
import { approveRuleCheckHandler } from "@pathrule/core/tools/rules.js";

export interface CheckRow {
  rule_id: string;
  rule: string;
  check_id: string;
  scope_path: string;
  command: string;
  status: "proposed" | "active";
  approval_hash: string;
}

/** A package.json's scripts, as core's approval resolves a command against them. */
interface PackageScripts {
  name: string | null;
  dir: string;
  scripts: Record<string, string>;
}

/** Approved here means what the store says; the approval itself re-checks everything in core. */
const approved = (check: RuleCheck) => check.authority === "human" && check.status === "active";

export type CheckDecision = "approved" | "declined" | "changed" | "no_terminal" | "already_active";

/** The approval hash: what the person saw, as one value a decision is bound to. */
export function checkApprovalHash(workspaceId: string, ruleId: string, check: RuleCheck): string {
  const shown = [workspaceId, ruleId, check.id, check.scope_path, check.requires.command, check.requires.fingerprint];
  return createHash("sha256").update(JSON.stringify(shown)).digest("hex").slice(0, 16);
}

/** Every CHECK of the workspace's rules, proposed first. */
export async function listRuleChecks(backend: KnowledgeBackend, workspaceId: string): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];
  for (const rule of await backend.listRules({ workspaceId })) {
    for (const atom of rule.constraints ?? []) {
      if ((atom as { kind?: string }).kind !== "check") continue;
      const check = atom as RuleCheck;
      rows.push({
        rule_id: rule.id,
        rule: rule.name,
        check_id: check.id,
        scope_path: check.scope_path,
        command: check.requires.command,
        status: approved(check) ? "active" : "proposed",
        approval_hash: checkApprovalHash(workspaceId, rule.id, check),
      });
    }
  }
  return rows.sort((a, b) => (a.status === b.status ? 0 : a.status === "proposed" ? -1 : 1));
}

/** What the person reads before deciding. */
export function describeCheck(row: CheckRow): string[] {
  return [
    `Rule: ${row.rule}`,
    `Command (exact words): ${row.command}`,
    `Applies under: ${row.scope_path}`,
    "What approving does: Pathrule never runs this command. An AI agent's turn that changes files",
    `under ${row.scope_path} cannot finish until the agent has run exactly this command and it passed.`,
    `Approval hash: ${row.approval_hash}`,
  ];
}

/** package.json scripts under `root` (four levels, no node_modules), for the approval's resolution. */
export async function readWorkspaceScripts(root: string): Promise<PackageScripts[]> {
  const found: PackageScripts[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    try {
      const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
        name?: unknown;
        scripts?: unknown;
      };
      const scripts =
        manifest.scripts && typeof manifest.scripts === "object"
          ? Object.fromEntries(Object.entries(manifest.scripts).filter(([, v]) => typeof v === "string"))
          : {};
      const rel = relative(root, dir).split(sep).join("/");
      found.push({ name: typeof manifest.name === "string" ? manifest.name : null, dir: rel ? `/${rel}` : "/", scripts: scripts as Record<string, string> });
    } catch {
      // No readable package.json here.
    }
    if (depth >= 4) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        await walk(join(dir, entry.name), depth + 1);
      }
    }
  };
  await walk(root, 0);
  return found;
}

async function logDecision(
  env: NodeJS.ProcessEnv,
  entry: { workspace_id: string; rule_id: string; check_id: string; scope_path: string; approval_hash: string; decision: CheckDecision },
): Promise<void> {
  const dir = localRuntimePaths(env).logsDir;
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, "check-approvals.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
}

export interface CheckApprovalInput {
  backend: KnowledgeBackend;
  workspaceId: string;
  userId: string;
  /** The workspace's folder, read for package.json scripts. */
  root: string;
  ruleId: string;
  checkId: string;
  env: NodeJS.ProcessEnv;
  /** Asks the person; null when there is no terminal a person answers. */
  ask: ((question: string) => Promise<string>) | null;
  /** Writes the description before the question. */
  show: (lines: string[]) => void;
}

/** One person's decision on one CHECK. Throws when the rule or the check does not exist. */
export async function decideCheck(input: CheckApprovalInput): Promise<{ decision: CheckDecision; row: CheckRow }> {
  const find = async () =>
    (await listRuleChecks(input.backend, input.workspaceId)).find(
      (r) => r.rule_id === input.ruleId && r.check_id === input.checkId,
    );
  const row = await find();
  if (!row) throw new Error(`check_not_found: rule ${input.ruleId} has no check ${input.checkId}`);
  const log = (decision: CheckDecision) =>
    logDecision(input.env, {
      workspace_id: input.workspaceId,
      rule_id: row.rule_id,
      check_id: row.check_id,
      scope_path: row.scope_path,
      approval_hash: row.approval_hash,
      decision,
    }).then(() => ({ decision, row }));
  if (row.status === "active") return { decision: "already_active", row };
  input.show(describeCheck(row));
  if (!input.ask) return log("no_terminal");
  const answer = (await input.ask("Approve this check? Type yes to approve [no]: ")).trim().toLowerCase();
  if (answer !== "yes") return log("declined");
  // Bound to what was shown: anything changed since is a new decision.
  const again = await find();
  if (!again || again.approval_hash !== row.approval_hash || again.status !== "proposed") return log("changed");
  const result = await approveRuleCheckHandler(
    { backend: input.backend, userId: input.userId, workspaceId: input.workspaceId },
    { rule_id: input.ruleId, check_id: input.checkId, confirm: true, workspace_scripts: await readWorkspaceScripts(input.root) },
  );
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return log("approved");
}
