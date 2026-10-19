// SPDX-License-Identifier: Apache-2.0
/**
 * Executable CHECK atoms: knowledge that compiles into a verification requirement.
 *
 * Second consumer of the same idea CONSTRAINT proved. Where CONSTRAINT compiles to a
 * PreToolUse deny, CHECK compiles to "this turn is not finished until the required
 * verification has passed", enforced at Stop.
 *
 * Shares CONSTRAINT's authority model verbatim (`atoms/constraint.ts`): every write
 * through the knowledge path lands `inferred` + `proposed` and compiles to nothing; only
 * an explicit human approval sets `human` + `active`. Two independent checks gate
 * enforcement so a bug that flips one field cannot grant it.
 *
 * One field CONSTRAINT does not have: `scope_path`.
 *
 * A regex scopes itself, because it only fires on text it matches. A CHECK's trigger IS
 * a path, so the path has to be expressible. Measured on the real example: the rule
 * `Write and run tests with every change` is `scope_type: project`, attached at `/`, so
 * inheriting the rule's scope would fire `pnpm --filter @pathrule/shared test` on an edit
 * anywhere in the workspace. `scope_path` NARROWS the rule's applicability and can never
 * widen it: the hook requires both that the rule applies to the path and that the path
 * sits under `scope_path`.
 */

import type { RuleCheck } from "@pathrule/protocol/rule-atoms.js";
import { classifyVerificationCommand, classifyVerificationEvidenceCommand } from "../verification/verification-evidence.js";
import type { ResolvedCommand } from "../verification/script-resolution.js";

// The stored shape is part of the open format contract (@pathrule/protocol).
export type { RuleCheck } from "@pathrule/protocol/rule-atoms.js";

/** Authored shape. Authority, status and the fingerprint are derived, never claimed. */
export interface CheckInput {
  /** Workspace-relative path the requirement applies under, e.g. "/packages/shared". */
  scope_path: string;
  /** The verification command that must have passed. */
  command: string;
  /** Why, and what to run. Carried into the block reason. */
  message: string;
}

/** What `compileRuleChecks` projects onto the hook-index rule stub. */
export interface CompiledCheck {
  scope_path: string;
  command: string;
  fingerprint: string;
  message: string;
}

export type CheckValidationCode =
  | "check_scope_path_invalid"
  | "check_command_too_short"
  | "check_command_too_long"
  | "check_command_unfingerprintable"
  | "check_command_non_terminating"
  | "check_message_too_short";

export type CheckValidation =
  | { ok: true; value: CheckInput & { fingerprint: string; resolved?: ResolvedCommand } }
  | { ok: false; code: CheckValidationCode; message: string };

const MIN_COMMAND_CHARS = 3;
const MAX_COMMAND_CHARS = 300;
const MIN_MESSAGE_CHARS = 10;

/**
 * Workspace-relative, rooted, no traversal, no glob. `/` is allowed and means the whole
 * workspace, which is only sane for a command that covers it.
 */
function normaliseScopePath(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const token = raw.trim();
  if (!token || token.length > 300) return null;
  if (!token.startsWith("/")) return null;
  if (token.includes("..")) return null;
  if (/[*?[\]{}]/.test(token)) return null;
  const trimmed = token.length > 1 ? token.replace(/\/+$/, "") : token;
  return trimmed.length > 0 ? trimmed : "/";
}

/**
 * Every check that can be made while a human is present to read the error.
 *
 * The load-bearing one is the fingerprint. A requirement whose command cannot be
 * canonicalised can never be satisfied by any observed run, so accepting it would create
 * a CHECK that blocks forever. Refused at the write boundary instead.
 */
export function validateCheckInput(
  input: CheckInput,
  /**
   * Resolution supplied by a caller that could read the repo. Omitted where no filesystem
   * exists, in which case the non-terminating gate simply has nothing to prove and the
   * command is accepted on its other merits.
   */
  opts: { resolved?: ResolvedCommand } = {},
): CheckValidation {
  return validateCheck(input,opts,false);
}

/** Stored approval identity is revalidated without silently replacing its fingerprint. */
function validateCheck(input: CheckInput, opts: {resolved?: ResolvedCommand}, stored: boolean): CheckValidation {
  const scope = normaliseScopePath(input.scope_path);
  if (scope === null) {
    return {
      ok: false,
      code: "check_scope_path_invalid",
      message: `scope_path must be a workspace-relative path starting with "/" (got "${String(input.scope_path)}").`,
    };
  }

  const command = (input.command ?? "").trim();
  if (command.length < MIN_COMMAND_CHARS) {
    return {
      ok: false,
      code: "check_command_too_short",
      message: `A verification command needs at least ${MIN_COMMAND_CHARS} characters.`,
    };
  }
  if (command.length > MAX_COMMAND_CHARS) {
    return {
      ok: false,
      code: "check_command_too_long",
      message: `A verification command is capped at ${MAX_COMMAND_CHARS} characters (got ${command.length}).`,
    };
  }

  const signal = classifyVerificationCommand(command);
  const evidence = classifyVerificationEvidenceCommand(command);
  if ((!signal && !evidence) || (!stored && !evidence)) {
    return {
      ok: false,
      code: "check_command_unfingerprintable",
      message:
        `"${command}" cannot be recognised as a verification, so no observed run could ever satisfy it. ` +
        `Use a form the evidence channel canonicalises (for example "pnpm --filter <package> test") ` +
        `and avoid pipes, which move the exit code off the verification.`,
    };
  }

  // The measured gap this closes: `pnpm test:watch` is `vitest` with no `run`, so it
  // never exits and its exit code can never be evidence. Rejected only when the
  // resolution PROVED it, never on the strength of the name containing "watch".
  if (opts.resolved?.status === "non_terminating") {
    return {
      ok: false,
      code: "check_command_non_terminating",
      message:
        `"${command}" resolves to a command that never exits (${opts.resolved.reason ?? "non-terminating"}), ` +
        `so its result could never satisfy the check. Name a one-shot form instead.`,
    };
  }

  const message = (input.message ?? "").trim();
  if (message.length < MIN_MESSAGE_CHARS) {
    return {
      ok: false,
      code: "check_message_too_short",
      message: `A check needs a message of at least ${MIN_MESSAGE_CHARS} characters; a bare block leaves the agent stuck.`,
    };
  }

  return {
    ok: true,
    value: {
      scope_path: scope,
      command,
      message,
      fingerprint: signal?.fingerprint ?? evidence!.legacyFingerprint,
      ...(opts.resolved ? { resolved: opts.resolved } : {}),
    },
  };
}

/** Stamp a validated input as a PROPOSAL. The only entry point from the write path. */
export function stampProposedCheck(
  value: CheckInput & { fingerprint: string; resolved?: ResolvedCommand },
  opts: { id: string; now: string },
): RuleCheck {
  return {
    id: opts.id,
    kind: "check",
    scope_path: value.scope_path,
    requires: {
      kind: "command",
      command: value.command,
      fingerprint: value.fingerprint,
      ...(value.resolved ? { resolved: value.resolved } : {}),
    },
    message: value.message,
    authority: "inferred",
    status: "proposed",
    created_at: opts.now,
    approved_by: null,
  };
}

/** The only transition that turns a check into something the runtime will act on. */
export function approveCheck(check: RuleCheck, approvedBy: string): RuleCheck {
  return { ...check, authority: "human", status: "active", approved_by: approvedBy };
}

/** Two independent conditions, so one flipped field cannot grant enforcement. */
export function isCheckEnforceable(check: RuleCheck): boolean {
  return check.authority === "human" && check.status === "active";
}

/**
 * Deterministic projection onto the hook-index rule stub. No LLM, no I/O.
 *
 * Slice 1 compiles at most one check per rule: `required_check` is singular, and a rule
 * with two requirements would need the stub to carry a list plus per-check pending
 * state. Validation refuses a second active check for the same reason.
 */
export function compileRuleChecks(
  // Same reason as `compileRuleConstraints`: the atom union lives in a module that
  // imports this one, so the narrowing is the guard.
  atoms: readonly unknown[] | null | undefined,
): CompiledCheck | null {
  if (!atoms || atoms.length === 0) return null;
  const enforceable = atoms.find(
    (a): a is RuleCheck => (a as RuleCheck).kind === "check" && isCheckEnforceable(a as RuleCheck),
  );
  if (!enforceable) return null;
  // Revalidate the approved legacy identity without replacing it or migrating the atom.
  // A preexisting unsafe command retains approval and compilation but cannot earn strict
  // PASS evidence; it needs explicit user review. Never relax shell attribution to clear it.
  const check = validateCheck({
    scope_path: enforceable.scope_path,
    command: enforceable.requires.command,
    message: enforceable.message,
  },{},true);
  if (!check.ok) return null;
  if (check.value.fingerprint !== enforceable.requires.fingerprint) return null;
  // Belt and braces. A stored atom whose resolution proved non-terminating should not
  // exist, because the write and approval boundaries refuse it. If one does, refuse to
  // compile it. This is a VETO, not a matching authority: evidence is still matched on
  // the fingerprint alone and this field is never consulted at runtime.
  if (enforceable.requires.resolved?.status === "non_terminating") return null;
  return {
    scope_path: enforceable.scope_path,
    command: enforceable.requires.command,
    fingerprint: enforceable.requires.fingerprint,
    message: enforceable.message,
  };
}

/** Defensive read. Anything malformed is dropped, never repaired into an active check. */
export function parseRuleChecks(raw: unknown): RuleCheck[] {
  const rows = Array.isArray(raw) ? raw : typeof raw === "string" ? safeJsonArray(raw) : [];
  const out: RuleCheck[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (r["kind"] !== "check") continue;
    const requires = r["requires"] as Record<string, unknown> | undefined;
    if (!requires || requires["kind"] !== "command") continue;
    if (typeof requires["command"] !== "string" || typeof requires["fingerprint"] !== "string") continue;
    if (typeof r["id"] !== "string" || typeof r["message"] !== "string") continue;
    if (typeof r["scope_path"] !== "string") continue;
    const authority = r["authority"];
    const status = r["status"];
    if (authority !== "human" && authority !== "inferred") continue;
    if (status !== "active" && status !== "proposed") continue;
    out.push({
      id: r["id"],
      kind: "check",
      scope_path: r["scope_path"],
      requires: {
        kind: "command",
        command: requires["command"],
        fingerprint: requires["fingerprint"],
        ...(parseResolved(requires["resolved"]) ? { resolved: parseResolved(requires["resolved"])! } : {}),
      },
      message: r["message"],
      authority,
      status,
      created_at: typeof r["created_at"] === "string" ? r["created_at"] : "",
      approved_by: typeof r["approved_by"] === "string" ? r["approved_by"] : null,
    });
  }
  return out;
}

/**
 * Read a stored resolution. An unrecognised status is dropped rather than coerced: the
 * only status that changes behaviour is `non_terminating`, and silently downgrading a
 * malformed one to `resolved` would undo the gate.
 */
function parseResolved(raw: unknown): ResolvedCommand | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const status = r["status"];
  if (status !== "resolved" && status !== "unresolved" && status !== "non_terminating") return null;
  return {
    status,
    runs: typeof r["runs"] === "string" ? r["runs"] : null,
    chain: Array.isArray(r["chain"]) ? r["chain"].filter((x): x is string => typeof x === "string") : [],
    reason: typeof r["reason"] === "string" ? r["reason"] : null,
  };
}

function safeJsonArray(text: string): unknown[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Does a mutated path fall inside a compiled check's scope?
 *
 * Exact or descendant only, and `/` covers everything. Ancestors deliberately do not
 * count: an edit to `/packages` is not an edit inside `/packages/shared`, and counting it
 * would make the requirement fire on work the command does not verify.
 */
export function pathInCheckScope(mutatedPath: string, scopePath: string): boolean {
  if (!mutatedPath || !scopePath) return false;
  if (scopePath === "/") return true;
  const p = mutatedPath.startsWith("/") ? mutatedPath : `/${mutatedPath}`;
  const s = scopePath.replace(/\/+$/, "");
  return p === s || p.startsWith(`${s}/`);
}
