// SPDX-License-Identifier: Apache-2.0
//
// Rule tool handlers — read in Phase 5, writes in Phase 6, path-first in M8.7.

import type { ToolContext, ToolError, ToolResult, ToolWarning } from "./types.js";
import { DEMO_READONLY_MESSAGE, mapStoreError, mapRpcError } from "./types.js";
import type { Rule, RulePriority, RuleScope } from "@pathrule/protocol/content-types.js";
import type { DedupSimilarEntry } from "@pathrule/protocol/dedup-types.js";
import type { ContentEdit } from "./content-edit.js";
import { resolveEditedContent } from "./edit-resolution.js";
import { approveConstraint, isEnforceable, isGroundedIn, stampProposedConstraint, validateConstraintInput, type ConstraintInput, type RuleConstraint, activateVerifiedConstraint, stampVerifiedConstraint } from "@pathrule/agent-ir/atoms/constraint.js";
import {
  approveCheck,
  isCheckEnforceable,
  stampProposedCheck,
  validateCheckInput,
  type CheckInput,
  type RuleCheck,
} from "@pathrule/agent-ir/atoms/check.js";
import { isCheckAtom, isConstraintAtom, type RuleAtom } from "@pathrule/agent-ir/atoms/atoms.js";
import {
  compileConstraintIntent,
  type StructuredConstraintIntent,
} from "@pathrule/agent-ir/atoms/constraint-compiler.js";
import type { PackageScripts, ResolvedCommand } from "@pathrule/agent-ir/verification/script-resolution.js";
import { resolveScriptCommand } from "@pathrule/agent-ir/verification/script-resolution.js";

function similarRulesWarning(similar: DedupSimilarEntry[]): ToolWarning | null {
  if (similar.length === 0) return null;
  return {
    code: "similar_titles",
    message: `Found ${similar.length} rule(s) with a similar name.`,
    detail: { similar },
  };
}

/**
 * Validate an authored constraint and stamp it as a PROPOSAL.
 *
 * Every surface that writes knowledge reaches this function: the MCP tool the agent
 * calls, the CLI a person types into, the VS Code extension. None of them can be told
 * apart here, and `ToolContext.clientId` is not a sound discriminator (it is null both
 * for a human and for an MCP client whose name `resolveClientId()` does not recognise).
 * So the answer is not to guess: everything lands `inferred` + `proposed`, which
 * compiles to nothing, and authority arrives only via `approveRuleConstraintHandler`.
 */
function proposeConstraint(
  input: ConstraintInput,
  existing: readonly RuleAtom[],
): { ok: true; value: RuleConstraint } | { ok: false; error: ToolError } {
  if (existing.filter(isConstraintAtom).some((c) => isEnforceable(c))) {
    return {
      ok: false,
      error: {
        code: "invalid_args",
        message:
          "This rule already has an active constraint. Slice 1 supports one per rule; remove the existing one first.",
      },
    };
  }
  const check = validateConstraintInput(input);
  if (!check.ok) {
    return { ok: false, error: { code: "invalid_args", message: check.message, detail: { reason: check.code } } };
  }
  return {
    ok: true,
    value: stampProposedConstraint(check.value, { id: crypto.randomUUID(), now: new Date().toISOString() }),
  };
}

/**
 * Validate an authored CHECK and stamp it as a PROPOSAL.
 *
 * Same reasoning as `proposeConstraint`, and the same fail-closed default: this function
 * is what the agent's MCP tool, the CLI and VS Code all reach, none of them can be told
 * apart here, so nothing that arrives through it is ever enforceable.
 */
function proposeCheck(
  input: CheckInput,
  existing: readonly RuleAtom[],
  /**
   * Resolution from a surface that could read the repo. Absent on the remote MCP, which
   * has no repo filesystem: the atom is then stored without it and the non-terminating
   * gate has nothing to prove. The gate that MATTERS is at approval, which only ever
   * runs on a surface that can read the repo.
   */
  resolved?: ResolvedCommand,
): { ok: true; value: RuleCheck } | { ok: false; error: ToolError } {
  if (existing.filter(isCheckAtom).some((c) => isCheckEnforceable(c))) {
    return {
      ok: false,
      error: {
        code: "invalid_args",
        message:
          "This rule already has an active check. Slice 1 supports one per rule; remove the existing one first.",
      },
    };
  }
  const validated = validateCheckInput(input, { resolved });
  if (!validated.ok) {
    return {
      ok: false,
      error: { code: "invalid_args", message: validated.message, detail: { reason: validated.code } },
    };
  }
  return {
    ok: true,
    value: stampProposedCheck(validated.value, { id: crypto.randomUUID(), now: new Date().toISOString() }),
  };
}

/**
 * Where the POLICY came from, as asserted by the calling surface.
 *
 * Separate from where the REPRESENTATION came from, which the compiler decides. Both have
 * to be trusted for a constraint to activate without a human approval: an explicit human
 * policy does not license a representation nobody verified, and a verified representation
 * does not license a policy nobody stated.
 */
export type PolicyProvenance = "explicit" | "inferred";

/**
 * Compile a structured intent and decide whether it may activate itself.
 *
 * The AUTO gate, in one place. It grants `status: "active"` without an approval only when
 * BOTH facts hold: the policy is explicitly human-authored, and the deterministic compiler
 * verified the representation with both oracles. Anything else lands proposed, and a
 * representation the compiler could not verify is refused outright rather than weakened.
 */
/**
 * Can this call be trusted with `policy_provenance: "explicit"`?
 *
 * The provenance is a claim about WHO decided the ban, and a claim is not evidence, so it
 * is honoured only where it can be checked deterministically: the ban has to be written
 * in prose that ALREADY EXISTS on the rule, and this call must not be the one writing
 * that prose. A caller that authors the text and cites it in the same breath has proved
 * nothing.
 *
 * This is defence in depth behind the surface boundary, not the primary control. The
 * primary control is that no agent-facing surface exposes the field at all: `pathrule_
 * write_rule` and `pathrule_update_rule` pass "inferred" unconditionally, so an agent has
 * no way to assert the claim in the first place. What this function protects is a
 * human-driven surface, where the person is trusted but a typo is not.
 */
function explicitPolicyRefusal(
  intent: StructuredConstraintIntent,
  storedContent: string | null,
  callAuthorsContent: boolean,
): ToolError | null {
  if (storedContent === null) {
    return {
      code: "invalid_args",
      message:
        'policy_provenance "explicit" needs prose that predates this call. A rule created in the same call has none, so write the rule first and attach the constraint to the stored body.',
      detail: { reason: "POLICY_NOT_PREDATED" },
    };
  }
  if (callAuthorsContent) {
    return {
      code: "invalid_args",
      message:
        'policy_provenance "explicit" cannot be claimed by a call that also rewrites the rule body. Land the prose first, then attach the constraint to it.',
      detail: { reason: "POLICY_AUTHORED_IN_SAME_CALL" },
    };
  }
  const source = (intent.source_text ?? "").trim();
  if (source.length === 0 || !storedContent.includes(source)) {
    return {
      code: "invalid_args",
      message:
        'policy_provenance "explicit" requires source_text to be a verbatim excerpt of the stored rule body, so the policy is provably the one written down.',
      detail: { reason: "SOURCE_TEXT_NOT_IN_RULE_BODY" },
    };
  }
  for (const form of intent.forbidden_forms ?? []) {
    if (!storedContent.includes(form.literal)) {
      return {
        code: "invalid_args",
        message: `policy_provenance "explicit" requires every forbidden literal to appear in the stored rule body; ${JSON.stringify(form.literal)} does not.`,
        detail: { reason: "LITERAL_NOT_IN_RULE_BODY", literal: form.literal },
      };
    }
  }
  return null;
}

function compileAndStampConstraint(
  intent: StructuredConstraintIntent,
  provenance: PolicyProvenance,
  existing: readonly RuleAtom[],
  grounding: { storedContent: string | null; callAuthorsContent: boolean },
):
  | { ok: true; value: RuleConstraint; auto: boolean; supersedes: string[] }
  | { ok: false; error: ToolError } {
  const constraints = existing.filter(isConstraintAtom);
  // A person's decision is not the compiler's to overwrite: an active HUMAN-approved
  // constraint has to be removed deliberately. An active COMPILER-verified one is a
  // different case, handled below, because leaving it in place is what would strand a
  // representation proved against prose that has since moved on.
  if (constraints.some((c) => isEnforceable(c) && c.authority === "human")) {
    return {
      ok: false,
      error: {
        code: "invalid_args",
        message:
          "This rule already has a human-approved active constraint. Remove it deliberately before compiling another.",
      },
    };
  }
  if (provenance === "explicit") {
    const refusal = explicitPolicyRefusal(intent, grounding.storedContent, grounding.callAuthorsContent);
    if (refusal) return { ok: false, error: refusal };
  }
  const compiled = compileConstraintIntent(intent);
  if (compiled.status !== "VERIFIED") {
    return {
      ok: false,
      error: {
        code: "invalid_args",
        message: `The constraint could not be deterministically verified (${compiled.status}): ${compiled.detail}`,
        detail: { reason: compiled.status, oracle_detail: compiled.detail },
      },
    };
  }
  const stamped = stampVerifiedConstraint(compiled.representation, {
    id: crypto.randomUUID(),
    now: new Date().toISOString(),
  });
  // Supersede, never accumulate. A second active compiler-verified representation on the
  // same rule would mean two answers to one question, and `compileRuleConstraints` takes
  // the first, so the stale one could win.
  const supersedes = constraints
    .filter((c) => c.authority === "verified" && c.status === "active")
    .map((c) => c.id);
  if (provenance === "explicit") {
    // Belt and braces at the one place that grants AUTO. Every explicit path above
    // already proves the excerpt is in the stored body, so this cannot fire today — but
    // an atom stamped `verified/active` with nothing to re-prove is a claim the compile
    // gate would refuse anyway, and storing that lie is worse than refusing the write.
    if (!stamped.grounding?.source_text) {
      return {
        ok: false,
        error: {
          code: "invalid_args",
          message:
            "A verified representation cannot be activated without the prose it was proved against.",
          detail: { reason: "GROUNDING_NOT_RECORDED" },
        },
      };
    }
    return { ok: true, value: activateVerifiedConstraint(stamped), auto: true, supersedes };
  }
  return { ok: true, value: stamped, auto: false, supersedes };
}

/**
 * Demote every compiler-verified active constraint the NEW body no longer grounds.
 *
 * Called when the rule body changes without the constraint being re-proved against it.
 * A representation verified against prose that no longer exists stops enforcing and goes
 * back to being a proposal: losing enforcement on a prose edit is the cheap failure,
 * enforcing a ban the rule may no longer state is not.
 *
 * Grounding-aware rather than unconditional, and that is the deliberate part. Demoting
 * on any body rewrite made an unrelated paragraph appended to the same rule disarm a
 * constraint whose source sentence is untouched — an invalidation sensitive enough that
 * editing a rule becomes a reason not to. `isGroundedIn` is the same predicate the
 * compile gate uses, so the DB state and the projection agree by construction instead of
 * by two implementations happening to match.
 *
 * This is state hygiene, not the safety property. The invariant is held at the compile
 * boundary; what this adds is that a rule edited through the sanctioned handler does not
 * leave an atom claiming an authority its prose stopped supporting.
 */
function demoteUngroundedConstraints(atoms: readonly RuleAtom[], newContent: string): RuleAtom[] {
  return atoms.map((a) =>
    isConstraintAtom(a) && a.authority === "verified" && a.status === "active" && !isGroundedIn(a, newContent)
      ? { ...a, authority: "inferred" as const, status: "proposed" as const, approved_by: null }
      : a,
  );
}

export interface ReadRuleArgs {
  rule_id: string;
}

export async function readRuleHandler(
  ctx: ToolContext,
  args: ReadRuleArgs,
): Promise<ToolResult<Rule & { nodeRelativePath: string | null }>> {
  // Read through the injected backend. The node path resolves via
  // backend.getNodeForRule.
  if (!ctx.backend) {
    return { ok: false, error: { code: "upstream_error", message: "No backend configured." } };
  }
  try {
    const rule = await ctx.backend.readRule(args.rule_id);
    if (!rule) {
      return { ok: false, error: { code: "not_found", message: `Rule ${args.rule_id} not found` } };
    }
    const node = await ctx.backend.getNodeForRule(rule.id);
    return { ok: true, data: { ...rule, nodeRelativePath: node?.relativePath ?? null } };
  } catch (err) {
    return { ok: false, error: mapStoreError(err as { code?: string; message: string }) };
  }
}

// -----------------------------------------------------------------------------
// Writes (M8.7 path-first)
// -----------------------------------------------------------------------------

export interface WriteRuleArgs {
  /** Workspace-relative path. Missing nodes auto-create. */
  node_path: string;
  name: string;
  content: string;
  scope_type: RuleScope;
  priority: RulePriority;
  /**
   * When false (default), insert is blocked if a rule with the same
   * normalised name already exists in this workspace. Pass true to insert a
   * deliberate duplicate.
   */
  allow_duplicate?: boolean;
  /**
   * Optional executable CONSTRAINT. Stored as a PROPOSAL regardless of who calls:
   * enforcement requires a separate human approval.
   */
  constraint?: ConstraintInput;
  /**
   * Optional executable CHECK. Stored as a PROPOSAL regardless of who calls:
   * requiring a verification is a gate, and a gate needs a human behind it.
   */
  check?: CheckInput;
  /**
   * package.json scripts read by the CALLING surface, for `check` resolution. Data, not
   * a filesystem handle, so this stays usable from a surface that has neither.
   */
  workspace_scripts?: PackageScripts[];
  /**
   * Structured constraint intent for the deterministic compiler. No regex: the caller
   * supplies grounded literals plus their form kind, and the compiler builds the pattern.
   */
  constraint_intent?: StructuredConstraintIntent;
  /**
   * Whether the POLICY is explicitly human-authored. Defaults to "inferred", the safe
   * answer. Not reachable on a rule being created: "explicit" requires prose that
   * predates the call, so it is refused here and only `updateRuleHandler` can honour it.
   */
  policy_provenance?: PolicyProvenance;
}

export async function writeRuleHandler(
  ctx: ToolContext,
  args: WriteRuleArgs,
): Promise<ToolResult<Rule>> {
  if (!ctx.workspaceId) {
    return {
      ok: false,
      error: {
        code: "invalid_args",
        message: "ctx.workspaceId is required for path-based writes",
      },
    };
  }
  if (!ctx.backend) {
    return { ok: false, error: { code: "upstream_error", message: "No backend configured." } };
  }
  // Composed on backend primitives: demo-guard → ensureNodeForPath →
  // dedup → writeRule (which inserts the rule and attaches it to the node).
  try {
    if (await ctx.backend.isDemoWorkspace(ctx.workspaceId)) {
      return { ok: false, error: { code: "permission_denied", message: DEMO_READONLY_MESSAGE } };
    }
    const node = await ctx.backend.ensureNodeForPath(ctx.workspaceId, args.node_path);

    const candidate = args.name.trim();
    const dedup = await ctx.backend.checkContentDedup({
      workspaceId: node.workspace_id,
      kind: "rule",
      candidate,
    });
    if (dedup.duplicate && !args.allow_duplicate) {
      return {
        ok: false,
        error: {
          code: "duplicate",
          message: `A rule named "${dedup.duplicate.title}" already exists in this workspace. Use update_rule, pick a different name, or pass allow_duplicate: true.`,
          detail: {
            existing_id: dedup.duplicate.id,
            existing_name: dedup.duplicate.title,
            similar: dedup.similar,
          },
        },
      };
    }

    let constraints: RuleAtom[] | undefined;
    if (args.constraint) {
      const proposal = proposeConstraint(args.constraint, []);
      if (!proposal.ok) return { ok: false, error: proposal.error };
      constraints = [proposal.value];
    }
    if (args.constraint_intent) {
      const result = compileAndStampConstraint(
        args.constraint_intent,
        args.policy_provenance ?? "inferred",
        constraints ?? [],
        // A rule being created has no prose that predates the call, so an "explicit"
        // claim is unprovable here and is refused rather than taken on trust.
        { storedContent: null, callAuthorsContent: true },
      );
      if (!result.ok) return { ok: false, error: result.error };
      constraints = [...(constraints ?? []), result.value];
    }
    if (args.check) {
      const resolved = args.workspace_scripts?.length
        ? resolveScriptCommand(args.check.command, args.workspace_scripts)
        : undefined;
      const proposal = proposeCheck(args.check, constraints ?? [], resolved);
      if (!proposal.ok) return { ok: false, error: proposal.error };
      constraints = [...(constraints ?? []), proposal.value];
    }

    const rule = await ctx.backend.writeRule({
      workspaceId: node.workspace_id,
      nodeId: node.id,
      name: candidate,
      content: args.content,
      scopeType: args.scope_type,
      priority: args.priority,
      constraints,
    });
    const warning = similarRulesWarning(dedup.similar);
    return warning ? { ok: true, data: rule, warnings: [warning] } : { ok: true, data: rule };
  } catch (err) {
    return { ok: false, error: mapStoreError(err as { code?: string; message: string }) };
  }
}

export interface UpdateRuleArgs {
  rule_id: string;
  expected_version_id?: string;
  patch: Partial<{
    name: string;
    content: string;
    scope_type: RuleScope;
    priority: RulePriority;
    /** Adds an executable CONSTRAINT as a PROPOSAL. Never grants enforcement. */
    constraint: ConstraintInput;
    /** Adds an executable CHECK as a PROPOSAL. Never grants enforcement. */
    check: CheckInput;
    /**
     * Adds an executable CONSTRAINT through the deterministic compiler. Activates itself
     * only when `policy_provenance` is "explicit" AND both oracles pass.
     */
    constraint_intent: StructuredConstraintIntent;
  }>;
  /** package.json scripts read by the calling surface, for `patch.check` resolution. */
  workspace_scripts?: PackageScripts[];
  /**
   * Whether the POLICY in `patch.constraint_intent` is explicitly human-authored.
   * Defaults to "inferred". "explicit" is honoured only when the ban is provably written
   * in the STORED rule body and this call does not rewrite that body; see
   * `explicitPolicyRefusal`. No agent-facing surface offers this field.
   */
  policy_provenance?: PolicyProvenance;
  /** Surgical delta applied server-side to the current body — avoids resending the whole content. */
  content_edit?: ContentEdit;
  /** Optional — move the rule's node_rules attachment to a different path (materialises on demand). */
  move_to_path?: string;
  /** Bypass duplicate-name check on rename. */
  allow_duplicate?: boolean;
}

export async function updateRuleHandler(
  ctx: ToolContext,
  args: UpdateRuleArgs,
): Promise<ToolResult<Rule | { conflict: true; current_version_id: string }>> {
  if (!ctx.backend) {
    return { ok: false, error: { code: "upstream_error", message: "No backend configured." } };
  }
  // Conflict + rename-dedup + move policy stays here; backend.updateRule
  // bumps the version (optimistic guard) and re-homes node_rules when nodeId is given.
  try {
    const current = await ctx.backend.readRule(args.rule_id);
    if (!current) {
      return { ok: false, error: { code: "not_found", message: `Rule ${args.rule_id} not found` } };
    }

    if (args.expected_version_id && current.versionId !== args.expected_version_id) {
      return {
        ok: false,
        error: {
          code: "conflict",
          message: "Rule has been modified since you last read it.",
          detail: { current_version_id: current.versionId },
        },
      };
    }

    if (args.patch.name !== undefined) {
      const candidate = args.patch.name.trim();
      if (candidate !== current.name && !args.allow_duplicate) {
        const dedup = await ctx.backend.checkContentDedup({
          workspaceId: current.workspaceId,
          kind: "rule",
          candidate,
          excludeId: args.rule_id,
          maxSimilar: 0,
        });
        if (dedup.duplicate) {
          return {
            ok: false,
            error: {
              code: "duplicate",
              message: `Another rule in this workspace already uses the name "${dedup.duplicate.title}". Pick a different name or pass allow_duplicate: true.`,
              detail: { existing_id: dedup.duplicate.id, existing_name: dedup.duplicate.title },
            },
          };
        }
      }
    }

    let targetNodeId: string | undefined;
    if (args.move_to_path) {
      const target = await ctx.backend.ensureNodeForPath(current.workspaceId, args.move_to_path);
      targetNodeId = target.id;
    }

    const resolved = resolveEditedContent({
      currentContent: current.content,
      content: args.patch.content,
      contentEdit: args.content_edit,
    });
    if (!resolved.ok) return { ok: false, error: resolved.error };

    // Did this call rewrite the body? `resolved.content` is undefined for "don't touch",
    // and an edit that produces identical text is not a change.
    const bodyRewritten = resolved.content !== undefined && resolved.content !== current.content;

    let constraints: RuleAtom[] | undefined;
    if (args.patch.constraint) {
      const proposal = proposeConstraint(args.patch.constraint, current.constraints ?? []);
      if (!proposal.ok) return { ok: false, error: proposal.error };
      constraints = [...(current.constraints ?? []), proposal.value];
    }
    if (args.patch.constraint_intent) {
      const base = constraints ?? current.constraints ?? [];
      const result = compileAndStampConstraint(
        args.patch.constraint_intent,
        args.policy_provenance ?? "inferred",
        base,
        { storedContent: current.content, callAuthorsContent: bodyRewritten },
      );
      if (!result.ok) return { ok: false, error: result.error };
      // The superseded atom is dropped, not demoted: it has been replaced by a
      // representation proved against the same prose, so keeping it would leave two
      // answers to one question.
      constraints = [...base.filter((a) => !result.supersedes.includes(a.id)), result.value];
    } else if (bodyRewritten) {
      const base = constraints ?? current.constraints ?? [];
      const demoted = demoteUngroundedConstraints(base, resolved.content!);
      // Only write the atom list back when something actually changed, so an ordinary
      // prose edit on a rule with no compiled constraint stays a content-only update.
      if (demoted.some((a, i) => a !== base[i])) constraints = demoted;
    }
    if (args.patch.check) {
      const base = constraints ?? current.constraints ?? [];
      const resolved = args.workspace_scripts?.length
        ? resolveScriptCommand(args.patch.check.command, args.workspace_scripts)
        : undefined;
      const proposal = proposeCheck(args.patch.check, base, resolved);
      if (!proposal.ok) return { ok: false, error: proposal.error };
      constraints = [...base, proposal.value];
    }

    const updated = await ctx.backend.updateRule({
      id: args.rule_id,
      name: args.patch.name !== undefined ? args.patch.name.trim() : undefined,
      content: resolved.content,
      scopeType: args.patch.scope_type,
      priority: args.patch.priority,
      nodeId: targetNodeId,
      constraints,
    });
    return { ok: true, data: updated };
  } catch (err) {
    return { ok: false, error: mapStoreError(err as { code?: string; message: string }) };
  }
}

// -----------------------------------------------------------------------------
// Constraint approval — the only transition that grants enforcement authority
// -----------------------------------------------------------------------------

export interface ApproveRuleConstraintArgs {
  rule_id: string;
  /** Which proposal to approve. Required: approving "whatever is pending" is not a decision. */
  constraint_id: string;
  /**
   * Positive assertion that a person decided this. It exists so no default-shaped call
   * can approve anything by accident, and so the CLI has something to gate on a TTY.
   */
  confirm: true;
}

/**
 * Deliberately NOT registered in `packages/mcp/src/tools/index.ts`.
 *
 * The knowledge-write path cannot tell an agent from a person, so it stamps every
 * constraint as a proposal. This handler is the separate step, reachable from the CLI
 * and (later) VS Code, that turns one into something the runtime will enforce.
 *
 * Known limit, stated rather than papered over: an agent with shell access can run the
 * CLI. No local developer tool can prevent that. What this design does guarantee is
 * that inferred knowledge never gains enforcement SILENTLY through the path agents
 * actually use.
 *
 * Also deferred: in a shared workspace, any member who can update the rule can approve
 * here. Restricting approval to the workspace owner is a permissions decision that
 * needs its own backend surface, and a single-user slice does not exercise it.
 */
export async function approveRuleConstraintHandler(
  ctx: ToolContext,
  args: ApproveRuleConstraintArgs,
): Promise<ToolResult<Rule>> {
  if (!ctx.backend) {
    return { ok: false, error: { code: "upstream_error", message: "No backend configured." } };
  }
  if (args.confirm !== true) {
    return { ok: false, error: { code: "invalid_args", message: "Approval requires confirm: true." } };
  }
  try {
    const current = await ctx.backend.readRule(args.rule_id);
    if (!current) {
      return { ok: false, error: { code: "not_found", message: `Rule ${args.rule_id} not found` } };
    }
    if (await ctx.backend.isDemoWorkspace(current.workspaceId)) {
      return { ok: false, error: { code: "permission_denied", message: DEMO_READONLY_MESSAGE } };
    }
    const existing = current.constraints ?? [];
    // Narrowed to constraint atoms: the list also holds checks, and approving a check
    // through the constraint path would stamp the wrong authority on the wrong atom.
    const target = existing.filter(isConstraintAtom).find((c) => c.id === args.constraint_id);
    if (!target) {
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Rule ${args.rule_id} has no constraint ${args.constraint_id}.`,
          detail: { available: existing.filter(isConstraintAtom).map((c) => ({ id: c.id, status: c.status })) },
        },
      };
    }
    if (isEnforceable(target)) {
      return { ok: true, data: current };
    }
    // Re-validated at the approval boundary too: this is the moment the pattern stops
    // being a note and starts being able to block work. A path-only atom has no pattern
    // to re-validate; its predicate was already normalised when it was stored.
    if (target.match) {
      const check = validateConstraintInput({
        mode: "forbid",
        pattern: target.match.pattern,
        flags: target.match.flags,
        message: target.message,
      });
      if (!check.ok) {
        return { ok: false, error: { code: "invalid_args", message: check.message, detail: { reason: check.code } } };
      }
    } else if (!target.path?.scope_path) {
      return {
        ok: false,
        error: { code: "invalid_args", message: "This constraint has neither a pattern nor a path narrowing." },
      };
    }
    const approved = approveConstraint(target, ctx.userId);
    const updated = await ctx.backend.updateRule({
      id: args.rule_id,
      constraints: existing.map((a) => (isConstraintAtom(a) && a.id === approved.id ? approved : a)),
    });
    return { ok: true, data: updated };
  } catch (err) {
    return { ok: false, error: mapStoreError(err as { code?: string; message: string }) };
  }
}

export interface ApproveRuleCheckArgs {
  rule_id: string;
  check_id: string;
  /** Positive assertion that a person decided this. Same gate as constraint approval. */
  confirm: true;
  /**
   * package.json scripts read by the approving surface.
   *
   * REQUIRED in practice, and this is the load-bearing placement. Approval is the moment
   * authority is granted, and approval only ever runs on a surface that can read the repo
   * (a CLI or VS Code, never the remote MCP). So the non-terminating proof is demanded
   * here rather than at proposal, where a surface may legitimately have no filesystem.
   *
   * Omitting it does not silently pass: the approval records `resolved: unresolved` with
   * a reason, so a later reader can see the proof was never obtained.
   */
  workspace_scripts?: PackageScripts[];
}

/**
 * Deliberately NOT registered in `packages/mcp/src/tools/index.ts`.
 *
 * Sibling of `approveRuleConstraintHandler` and the same limits apply: an agent with
 * shell access can run the CLI, and in a shared workspace any member who can update the
 * rule can approve here. What this guarantees is that a check written through the path
 * agents actually use never silently starts gating anything.
 */
export async function approveRuleCheckHandler(
  ctx: ToolContext,
  args: ApproveRuleCheckArgs,
): Promise<ToolResult<Rule>> {
  if (!ctx.backend) {
    return { ok: false, error: { code: "upstream_error", message: "No backend configured." } };
  }
  if (args.confirm !== true) {
    return { ok: false, error: { code: "invalid_args", message: "Approval requires confirm: true." } };
  }
  try {
    const current = await ctx.backend.readRule(args.rule_id);
    if (!current) {
      return { ok: false, error: { code: "not_found", message: `Rule ${args.rule_id} not found` } };
    }
    if (await ctx.backend.isDemoWorkspace(current.workspaceId)) {
      return { ok: false, error: { code: "permission_denied", message: DEMO_READONLY_MESSAGE } };
    }
    const existing = current.constraints ?? [];
    const target = existing.filter(isCheckAtom).find((c) => c.id === args.check_id);
    if (!target) {
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Rule ${args.rule_id} has no check ${args.check_id}.`,
          detail: { available: existing.filter(isCheckAtom).map((c) => ({ id: c.id, status: c.status })) },
        },
      };
    }
    if (isCheckEnforceable(target)) return { ok: true, data: current };

    // Re-validated at the approval boundary: this is the moment the requirement stops
    // being a note and starts being able to hold a turn open. Resolution is re-run here
    // from the approving surface's own filesystem read rather than trusted from the
    // proposal, because the proposal may have come from an agent on a surface with no
    // repo access, and a stored resolution is data the proposer could have supplied.
    const resolved = args.workspace_scripts?.length
      ? resolveScriptCommand(target.requires.command, args.workspace_scripts)
      : ({
          status: "unresolved",
          runs: null,
          chain: [],
          reason: "the approving surface supplied no package.json data",
        } satisfies ResolvedCommand);
    const validated = validateCheckInput(
      {
        scope_path: target.scope_path,
        command: target.requires.command,
        message: target.message,
      },
      { resolved },
    );
    if (!validated.ok) {
      return {
        ok: false,
        error: {
          code: "invalid_args",
          message: validated.message,
          detail: { reason: validated.code, resolved },
        },
      };
    }
    // Stamp the resolution the APPROVER obtained, overwriting anything the proposer
    // stored. This is what makes the field provenance rather than a claim.
    const approved = approveCheck(
      { ...target, requires: { ...target.requires, resolved } },
      ctx.userId,
    );
    const updated = await ctx.backend.updateRule({
      id: args.rule_id,
      constraints: existing.map((a) => (isCheckAtom(a) && a.id === approved.id ? approved : a)),
    });
    return { ok: true, data: updated };
  } catch (err) {
    return { ok: false, error: mapStoreError(err as { code?: string; message: string }) };
  }
}

// -----------------------------------------------------------------------------
// Delete + restore (DX-1)
// -----------------------------------------------------------------------------

export interface DeleteRuleArgs {
  rule_id: string;
  hard?: boolean;
  expected_version_id?: string;
}

export interface DeleteRuleResult {
  id: string;
  workspaceId: string;
  hard: boolean;
}

export async function deleteRuleHandler(
  ctx: ToolContext,
  args: DeleteRuleArgs,
): Promise<ToolResult<DeleteRuleResult>> {
  if (!ctx.backend) {
    return { ok: false, error: { code: "upstream_error", message: "No backend configured." } };
  }
  try {
    const res = await ctx.backend.deleteRule({
      id: args.rule_id,
      hard: args.hard,
      expectedVersionId: args.expected_version_id,
    });
    if (res.status === "rejected") {
      return { ok: false, error: mapRpcError(res.reason) };
    }
    if (res.status === "conflict") {
      return {
        ok: false,
        error: {
          code: "conflict",
          message: "Rule has been modified since you last read it.",
          detail: { current_version_id: res.currentVersionId },
        },
      };
    }
    return { ok: true, data: { id: res.id, workspaceId: res.workspaceId, hard: !!args.hard } };
  } catch (err) {
    return { ok: false, error: mapStoreError(err as { code?: string; message: string }) };
  }
}

export interface RestoreRuleArgs {
  rule_id: string;
}

export async function restoreRuleHandler(
  ctx: ToolContext,
  args: RestoreRuleArgs,
): Promise<ToolResult<{ id: string; workspaceId: string }>> {
  // Restore owned by the backend (cloud: restore_rule_rpc; local: status flip).
  if (!ctx.backend) {
    return { ok: false, error: { code: "upstream_error", message: "No backend configured." } };
  }
  try {
    const res = await ctx.backend.restoreRule(args.rule_id);
    if (res.status === "rejected") return { ok: false, error: mapRpcError(res.reason) };
    return { ok: true, data: { id: res.id, workspaceId: res.workspaceId } };
  } catch (err) {
    return { ok: false, error: mapStoreError(err as { code?: string; message: string }) };
  }
}
