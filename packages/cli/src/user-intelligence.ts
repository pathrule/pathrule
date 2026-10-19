// SPDX-License-Identifier: Apache-2.0
// `pathrule me` - what Pathrule has learned about how YOU work, and the controls over it.
//
// The CLI reads and writes the same per-user store the MCP server does, so the two surfaces can never grow
// separate opinions about the same person. Listing, explaining, forgetting and scoping a belief are
// the person reading and correcting the store: deterministic file IO, open. Deciding what an agent
// receives (`me context`) is the engine's, which adds it.
import {
  updateUserKnowledge,
  deleteUserKnowledge,
  readUserKnowledge,
  resolveUserKey,
} from "@pathrule/core/user-knowledge/user-knowledge-store.js";
import {
  narrowUserKnowledge,
  rejectUserKnowledge,
} from "@pathrule/core/user-knowledge/user-knowledge-lifecycle.js";
import { effectiveUserWorkspace, type UserKnowledgeAtom } from "@pathrule/core/user-knowledge/user-knowledge.js";
// After forget or scope: every workspace's hook index must say what the store now says, not only
// the next one to sync (Forget used to keep the hook delivering a belief in every other workspace).
import { refreshPersonalHookIndexes } from "@pathrule/integrations/index-writers/personal-index-refresh.js";
import { jsonEnvelope, renderJson, statusLabel } from "./output.js";
import { cliPlugins, type CliCommand, type CliCommandContext } from "./plugin.js";

export const meCommand: CliCommand = {
  name: "me",
  get help() {
    return {
      section: "diagnostics" as const,
      rank: 90,
      summary: "Inspect and correct what Pathrule knows about how you work",
    };
  },
  writesOwnJson: true,
  run: (ctx) => renderUserIntelligence(ctx),
};

/** The subcommands this run has, in the order the usage line names them. */
function meSubcommandNames(): string[] {
  const ranked: Array<[string, number]> = [
    ["list", 10],
    ["explain", 30],
    ["forget", 40],
    ["scope", 50],
    ...cliPlugins().flatMap((p) =>
      Object.entries(p.subcommands?.me ?? {}).map(([name, sub]): [string, number] => [name, sub.rank]),
    ),
  ];
  return ranked.sort((a, b) => a[1] - b[1]).map(([name]) => name);
}

/** All beliefs about this person, as stored. */
export function allUserKnowledge(env: NodeJS.ProcessEnv): Promise<UserKnowledgeAtom[]> {
  return readUserKnowledge(resolveUserKey(null), env);
}

export function shortId(atom: UserKnowledgeAtom): string {
  return atom.id.slice(0, 8);
}

/** Where a belief applies, including one kept in the only workspace it was seen in. */
function appliesLabel(atom: UserKnowledgeAtom): string {
  const pin = effectiveUserWorkspace(atom);
  if (pin === null) return "across workspaces";
  return atom.applies_to_workspace_id !== null ? `only in ${pin}` : `only in ${pin} until another workspace shows it`;
}

function describe(atom: UserKnowledgeAtom): string {
  const kind = atom.source_type === "EXPLICIT" ? "you told Pathrule" : `${atom.evidence.length} observation${atom.evidence.length === 1 ? "" : "s"}`;
  return `  ${shortId(atom)}  ${atom.claim}\n      ${atom.primitive} | ${atom.status} | ${atom.confidence} confidence | ${kind} | ${appliesLabel(atom)}`;
}

async function renderUserIntelligence(ctx: CliCommandContext): Promise<number> {
  const { args: positional, runtime, mode } = ctx;
  const sub = (positional[0] ?? "list").toLowerCase();
  const cmd = `me ${sub}`;
  const cfg = { env: runtime.env, userId: null as string | null };
  const added = cliPlugins().find((p) => p.subcommands?.me?.[sub])?.subcommands?.me?.[sub];
  if (added) return added.run(ctx);

  if (sub === "list") {
    const atoms = await allUserKnowledge(runtime.env);
    if (mode.json) { runtime.stdout.write(renderJson(jsonEnvelope({ command: cmd, cwd: runtime.cwd, ok: true, data: { atoms } }))); return 0; }
    if (atoms.length === 0) {
      runtime.stdout.write(`${statusLabel("info", mode)} Pathrule has not learned anything about how you work yet.\n`);
      return 0;
    }
    const active = atoms.filter((a) => a.status === "active");
    const other = atoms.filter((a) => a.status !== "active");
    runtime.stdout.write(`${statusLabel("info", mode)} How Pathrule understands your way of working (${active.length} active):\n`);
    for (const a of active) runtime.stdout.write(`${describe(a)}\n`);
    if (other.length > 0) {
      runtime.stdout.write(`\n  Not in use yet (${other.length}):\n`);
      for (const a of other) runtime.stdout.write(`${describe(a)}\n`);
    }
    return 0;
  }

  if (sub === "explain") {
    const id = (positional[1] ?? "").trim();
    const atoms = await allUserKnowledge(runtime.env);
    const atom = atoms.find((a) => a.id === id || a.id.startsWith(id));
    if (!atom) {
      runtime.stderr.write(`${statusLabel("error", mode)} No such belief: ${id || "(none given)"}\n`);
      return 1;
    }
    if (mode.json) { runtime.stdout.write(renderJson(jsonEnvelope({ command: cmd, cwd: runtime.cwd, ok: true, data: atom }))); return 0; }
    runtime.stdout.write(`${statusLabel("info", mode)} ${atom.claim}\n`);
    runtime.stdout.write(`  primitive:  ${atom.primitive}\n  status:     ${atom.status}\n  confidence: ${atom.confidence}\n`);
    runtime.stdout.write(`  source:     ${atom.source_type === "EXPLICIT" ? "you told Pathrule directly" : "inferred from what happened"}\n`);
    runtime.stdout.write(`  applies:    ${appliesLabel(atom)}${atom.applies_to_path ? ` under ${atom.applies_to_path}` : ""}\n`);
    if (atom.superseded_by) runtime.stdout.write(`  replaced by: ${atom.superseded_by.slice(0, 8)}\n`);
    runtime.stdout.write(`\n  Learned from ${atom.evidence.length} observation${atom.evidence.length === 1 ? "" : "s"}:\n`);
    for (const e of atom.evidence) {
      runtime.stdout.write(`    ${e.observed_at} (${e.kind}, ${e.surface}): ${JSON.stringify(e.quote.slice(0, 120))}\n`);
    }
    return 0;
  }

  if (sub === "forget") {
    const id = (positional[1] ?? "").trim();
    const hard = positional.includes("--delete");
    const atoms = await allUserKnowledge(runtime.env);
    const atom = atoms.find((a) => a.id === id || a.id.startsWith(id));
    if (!atom) { runtime.stderr.write(`${statusLabel("error", mode)} No such belief: ${id || "(none given)"}\n`); return 1; }
    const now = new Date().toISOString();
    const key = resolveUserKey(cfg.userId);
    if (hard) await deleteUserKnowledge(key, atom.id, { now, env: runtime.env });
    else await updateUserKnowledge(key, atom.id, (a) => rejectUserKnowledge(a, { now }), { now, env: runtime.env });
    await refreshPersonalHookIndexes(cfg);
    if (mode.json) { runtime.stdout.write(renderJson(jsonEnvelope({ command: cmd, cwd: runtime.cwd, ok: true, data: { id: atom.id, deleted: hard } }))); return 0; }
    runtime.stdout.write(`${statusLabel("ok", mode)} ${hard ? "Deleted" : "Will not be used again"}: ${atom.claim}\n`);
    return 0;
  }

  if (sub === "scope") {
    const id = (positional[1] ?? "").trim();
    const atoms = await allUserKnowledge(runtime.env);
    const atom = atoms.find((a) => a.id === id || a.id.startsWith(id));
    if (!atom) { runtime.stderr.write(`${statusLabel("error", mode)} No such belief: ${id || "(none given)"}\n`); return 1; }
    // "That was only for that project": pin it to the workspace this command ran in.
    const workspaceId = positional.includes("--everywhere") ? null : runtime.cwd;
    const now = new Date().toISOString();
    const updated = await updateUserKnowledge(resolveUserKey(cfg.userId), atom.id, (a) => narrowUserKnowledge(a, { workspace_id: workspaceId }, { now }), { now, env: runtime.env });
    await refreshPersonalHookIndexes(cfg);
    if (mode.json) { runtime.stdout.write(renderJson(jsonEnvelope({ command: cmd, cwd: runtime.cwd, ok: true, data: updated }))); return 0; }
    runtime.stdout.write(`${statusLabel("ok", mode)} ${workspaceId ? `Now applies only here (${workspaceId})` : "Now applies across workspaces"}: ${atom.claim}\n`);
    return 0;
  }

  if (mode.json) { runtime.stdout.write(renderJson(jsonEnvelope({ command: cmd, cwd: runtime.cwd, ok: false, error: { code: "unknown_subcommand", message: `unknown: me ${sub}` } }))); return 2; }
  runtime.stderr.write(`${statusLabel("error", mode)} unknown subcommand: me ${sub}\n  try: ${meSubcommandNames().join(" | ")}\n`);
  return 2;
}
