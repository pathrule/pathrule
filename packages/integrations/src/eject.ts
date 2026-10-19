// SPDX-License-Identifier: Apache-2.0
// `pathrule eject` — the plan half.
//
// Removing Pathrule from a repo has to be as cheap as adding it, or a
// mid-project install is a one-way door and nobody takes it. That makes eject a
// trust feature rather than a cleanup utility, and it is why this module PLANS
// before it touches anything: the user sees the exact list, then applies it.
//
// Read-only by construction. Nothing here writes, renames, or deletes.
//
// Two sources, deliberately unioned:
//   - the ledger (`.pathrule/managed-files.json`), which records what Pathrule
//     wrote. Authoritative about intent, but it can be stale: measured on this
//     repo it held 116 entries last touched three weeks before the files were.
//   - a bounded content walk, where a Pathrule banner is ground truth.
// Either alone leaves residue. The union does not, and every deletion still
// gates on `pathruleShare` (core paths/region.ts): a file holding the user's own
// text is stripped rather than removed, and one whose region cannot be told
// apart from their text is left as it is and listed.

import { readFile, readdir, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

import { isPathruleManaged } from "@pathrule/core/paths/ownership.js";
import { pathruleShare, regionBounds, retractRegion } from "@pathrule/core/paths/region.js";
import { PATHRULE_DIR } from "@pathrule/core/paths/workspace-files.js";
import {
  HookConfigUnreadableError,
  ensureClaudeSettingsHook,
  ensureCodexConfigToml,
  ensureCodexHooks,
  ensureCursorHooks,
} from "./pathrule-protocol.js";
import { invalidateRecoveryLatch } from "./client-renderers/protocol-channel-fs.js";
import { planRecovery } from "./client-renderers/recovery-scan.js";

export type EjectActionKind =
  /** Nothing in this file is the user's: remove it. */
  | "delete_file"
  /** The user's file carries our region: remove the region, keep their bytes. */
  | "strip_region"
  /** A marker-bound block inside a file the user owns (.gitignore). */
  | "strip_block"
  /** A config the user owns where only our entries come out (settings.json, hooks.json, config.toml). */
  | "unhook"
  /** The user's own content is waiting in a backup: put it back. */
  | "restore_backup"
  /** A backup that holds nothing of the user's: drop it. */
  | "discard_backup";

export interface EjectAction {
  kind: EjectActionKind;
  /** Workspace-relative, forward slashes. */
  path: string;
  /** Where a restore lands; the source ledger entry otherwise. */
  target?: string;
  bytes: number;
  /** Why this action, in one clause, for the confirmation list. */
  reason: string;
  /** Pathrule's ledger records writing this file: a config left as `{}` may go. */
  ledger?: boolean;
}

export interface EjectPlan {
  actions: EjectAction[];
  /** Ledger entries that are already gone. Reported, never an error. */
  missing: string[];
  /**
   * True when a restore is part of the plan. The apply step must do those
   * FIRST: stripping a region before restoring leaves the user staring at an
   * empty instruction file while their content sits in a backup.
   */
  restoresFirst: boolean;
  /**
   * Backups holding the user's content that apply will NOT resolve on its own,
   * because the live file holds their content too and picking a merge is not
   * ours to do.
   *
   * They are listed because they hold the whole plan back in one specific way:
   * `.pathrule/backups/` lives INSIDE `.pathrule`, so deleting that directory
   * would destroy a backup apply had just decided not to touch, and that backup
   * can be the user's only copy. Any directory containing one of these is left
   * alone until the user resolves it.
   */
  heldForRecovery: string[];
  /**
   * Files that carry a Pathrule marker where Pathrule's text cannot be told apart from the person's (an
   * anchor lost, two regions). Never changed; listed so the person can look.
   */
  unclear: Array<{ path: string; reason: string }>;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "Pods",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".gradle",
  ".idea",
  "DerivedData",
  "coverage",
  ".turbo",
]);

/** Instruction filenames a CLIENT dictates, which the user may own. */
const INSTRUCTION_BASENAMES = new Set([
  "CLAUDE.md",
  "CLAUDE.local.md",
  "AGENTS.md",
  "GEMINI.md",
  ".cursorrules",
  ".windsurfrules",
  ".clinerules",
  "copilot-instructions.md",
]);

/** Configs the user owns where only Pathrule's entries come out. */
const UNHOOK_FILES = new Set([
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".cursor/hooks.json",
  ".codex/hooks.json",
  ".codex/config.toml",
]);

/** Filenames Pathrule invented, so the whole file is ours. */
export function isPathruleOwnedName(rel: string): boolean {
  if (rel === PATHRULE_DIR || rel.startsWith(`${PATHRULE_DIR}/`)) return true;
  if (/(^|\/)\.claude\/rules\/pathrule-[^/]+\.md$/.test(rel)) return true;
  if (/(^|\/)\.cursor\/rules\/pathrule-[^/]+\.mdc$/.test(rel)) return true;
  if (/(^|\/)\.windsurf\/rules\/pathrule-[^/]+\.md$/.test(rel)) return true;
  if (/(^|\/)\.github\/instructions\/pathrule-[^/]+$/.test(rel)) return true;
  if (rel === ".github/hooks/pathrule.json") return true;
  return false;
}

/** Claude Code's rules folder that Pathrule writes (claude-knowledge-renderer.ts). */
const RULES_DIR = ".claude/rules/pathrule";

/** A file in the rules folder that carries Pathrule's marker: the folder's own ignore file included. */
function isRulesFolderFile(rel: string, body: string): boolean {
  return rel.startsWith(`${RULES_DIR}/`) && (isPathruleManaged(body) || body.startsWith("# Pathrule managed"));
}

const GITIGNORE_START = "# >>> Pathrule managed";
const MAX_FILE_BYTES = 512 * 1024;
const MAX_DEPTH = 8;

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

async function readIfSmall(abs: string): Promise<string | null> {
  try {
    if ((await stat(abs)).size > MAX_FILE_BYTES) return null;
    return await readFile(abs, "utf8");
  } catch {
    return null;
  }
}

async function byteSize(abs: string): Promise<number> {
  try {
    return (await stat(abs)).size;
  } catch {
    return 0;
  }
}

/** Ledger paths, or an empty list when there is no ledger to read. */
async function ledgerPaths(root: string): Promise<string[]> {
  const body = await readIfSmall(join(root, PATHRULE_DIR, "managed-files.json"));
  if (body === null) return [];
  try {
    const parsed = JSON.parse(body) as { files?: Array<{ path?: unknown }> };
    if (!Array.isArray(parsed.files)) return [];
    return parsed.files
      .map((f) => (typeof f.path === "string" ? f.path.replace(/\\/g, "/").replace(/^\/+/, "") : ""))
      .filter((p) => p.length > 0 && !p.includes("../"));
  } catch {
    return [];
  }
}

/**
 * Candidate paths worth reading. Bounded on purpose: only files that could
 * plausibly carry a Pathrule banner, so a monorepo with 600 markdown files does
 * not get every one of them read.
 */
export async function walkCandidates(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = toPosix(relative(root, abs));
      if (entry.isDirectory()) {
        if (entry.name === PATHRULE_DIR) {
          out.push(rel);
          continue; // the whole directory goes; no need to enumerate it here
        }
        if (!SKIP_DIRS.has(entry.name)) await walk(abs, depth + 1);
        continue;
      }
      if (
        INSTRUCTION_BASENAMES.has(entry.name) ||
        isPathruleOwnedName(rel) ||
        rel.startsWith(`${RULES_DIR}/`) ||
        UNHOOK_FILES.has(rel) ||
        entry.name === ".gitignore"
      ) {
        out.push(rel);
      }
    }
  }
  await walk(root, 0);
  return out;
}

export async function planEject(root: string): Promise<EjectPlan> {
  const [fromLedger, fromWalk, recovery] = await Promise.all([
    ledgerPaths(root),
    walkCandidates(root),
    planRecovery(root).catch(() => ({ leftovers: [], restorable: [], needsChoice: [], discardable: [] })),
  ]);

  const candidates = [...new Set([...fromLedger, ...fromWalk])].sort();
  const actions: EjectAction[] = [];
  const missing: string[] = [];
  const unclear: EjectPlan["unclear"] = [];
  const seen = new Set<string>();

  // A path a restore will WRITE must not also be planned for deletion or
  // stripping. Without this the plan contradicts itself and the apply order
  // makes it worse rather than better: the restore lands first, then the delete
  // removes the file it just put back, so the user's recovered instructions are
  // destroyed by the very operation that recovered them. Caught by
  // "restores the user's backup BEFORE removing the file it belongs to".
  //
  // Only RESTORABLE leftovers claim their target. A needs-choice leftover is not
  // applied, so its live file still wants its region stripped.
  const restoreTargets = new Set(
    recovery.restorable.map((l) => l.restoresTo).filter((t): t is string => typeof t === "string"),
  );

  // Backups apply will not resolve by itself. See EjectPlan.heldForRecovery.
  const heldForRecovery = recovery.needsChoice.map((l) => l.path);
  const holdsUserContent = (dir: string): boolean =>
    heldForRecovery.some((held) => held === dir || held.startsWith(`${dir}/`));

  for (const rel of candidates) {
    if (seen.has(rel)) continue;
    if (restoreTargets.has(rel)) continue; // the restore owns this path
    const abs = join(root, rel);

    // The whole Pathrule directory, including the ledger itself, goes last but
    // is planned as one action rather than a file list.
    if (rel === PATHRULE_DIR) {
      seen.add(rel);
      // Held while a backup inside it still needs the user's decision: removing
      // the directory would destroy the very bytes apply declined to touch.
      if (!holdsUserContent(rel)) {
        actions.push({
          kind: "delete_file",
          path: rel,
          bytes: 0,
          reason: "Pathrule's own directory",
        });
      }
      continue;
    }
    if (rel.startsWith(`${PATHRULE_DIR}/`)) continue; // covered by the directory action

    const body = await readIfSmall(abs);
    if (body === null) {
      // On the ledger but gone, or too large to judge. Either way: report, never fail.
      if (fromLedger.includes(rel)) missing.push(rel);
      continue;
    }
    seen.add(rel);

    if (isPathruleOwnedName(rel)) {
      actions.push({
        kind: "delete_file",
        path: rel,
        bytes: await byteSize(abs),
        reason: "a file Pathrule created",
      });
      continue;
    }

    if (isRulesFolderFile(rel, body)) {
      actions.push({
        kind: "delete_file",
        path: rel,
        bytes: await byteSize(abs),
        reason: "Pathrule's compiled rules for Claude Code",
      });
      continue;
    }

    if (UNHOOK_FILES.has(rel)) {
      // Case-insensitive: Codex's config block says "Pathrule", the hook entries "pathrule-hook".
      if (/pathrule/i.test(body)) {
        actions.push({
          kind: "unhook",
          path: rel,
          bytes: await byteSize(abs),
          reason: "remove Pathrule's entries, keep the rest of your config",
          ...(fromLedger.includes(rel) ? { ledger: true } : {}),
        });
      }
      continue;
    }

    if (basename(rel) === ".gitignore") {
      if (body.includes(GITIGNORE_START)) {
        actions.push({
          kind: "strip_block",
          path: rel,
          bytes: await byteSize(abs),
          reason: "remove the Pathrule block",
        });
      }
      continue;
    }

    // What of it is Pathrule's, decided as the sync decides it (core paths/region.ts).
    const share = pathruleShare(rel, body);
    if (share.kind === "none") continue;
    if (share.kind === "ambiguous") {
      unclear.push({ path: rel, reason: share.reason });
      continue;
    }
    actions.push({
      kind: share.kind === "whole" ? "delete_file" : "strip_region",
      path: rel,
      bytes: await byteSize(abs),
      reason: share.kind === "whole" ? "nothing in this file is yours" : "remove Pathrule's block, keep your file",
    });
  }

  // Backups: the user's own content goes back, our own output goes away.
  for (const l of recovery.restorable) {
    actions.push({
      kind: "restore_backup",
      path: l.path,
      target: l.restoresTo ?? undefined,
      bytes: await byteSize(join(root, l.path)),
      reason: "your content is in here; put it back",
    });
  }
  for (const l of recovery.needsChoice) {
    actions.push({
      kind: "restore_backup",
      path: l.path,
      target: l.restoresTo ?? undefined,
      bytes: await byteSize(join(root, l.path)),
      reason: "your content is in here, and the live file also has yours: needs your call",
    });
  }
  for (const l of recovery.discardable) {
    actions.push({
      kind: "discard_backup",
      path: l.path,
      bytes: await byteSize(join(root, l.path)),
      reason: "Pathrule backed up its own output; nothing of yours in it",
    });
  }

  return {
    actions,
    missing,
    unclear,
    restoresFirst: actions.some((a) => a.kind === "restore_backup"),
    heldForRecovery,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Apply
// ─────────────────────────────────────────────────────────────────────────────

export type EjectOutcome = "done" | "skipped" | "failed";

export interface EjectActionResult {
  action: EjectAction;
  outcome: EjectOutcome;
  /** Why it was skipped, or what failed. */
  note?: string;
}

export interface EjectResult {
  results: EjectActionResult[];
  done: number;
  skipped: number;
  failed: number;
}

/**
 * Order is part of the contract, not an implementation detail.
 *
 * Restores run FIRST: strip a region or delete a file before putting the user's
 * backup back and they are left staring at an empty instruction file while their
 * content sits in a `backup.*` they were not told about. The Pathrule directory
 * goes LAST because the ledger lives in it and is read while applying.
 */
const ORDER: Record<EjectActionKind, number> = {
  restore_backup: 0,
  discard_backup: 1,
  strip_region: 2,
  strip_block: 3,
  unhook: 4,
  delete_file: 5,
};

/** A path from a plan (or a stale ledger) must never escape the workspace. */
function resolveInside(root: string, rel: string): string {
  const abs = resolve(root, rel);
  const back = relative(root, abs);
  if (back === "" || back.startsWith("..") || back.startsWith(`..${sep}`)) {
    throw new Error("path_outside_workspace");
  }
  return abs;
}

function stripGitignoreBlock(body: string): string {
  const start = body.indexOf(GITIGNORE_START);
  if (start < 0) return body;
  const endMarker = "# <<< Pathrule managed";
  const endIdx = body.indexOf(endMarker, start);
  if (endIdx < 0) return body;
  const lineEnd = body.indexOf("\n", endIdx);
  const after = lineEnd < 0 ? "" : body.slice(lineEnd + 1);
  const before = body.slice(0, start);
  const joined = `${before.replace(/\n+$/, "")}\n${after.replace(/^\n+/, "")}`;
  return joined.trim() === "" ? "" : joined.replace(/\n+$/, "") + "\n";
}

/** Remove Pathrule's entries from one config, reusing the same mergers that wrote them. */
function unhookBody(rel: string, body: string): string | null {
  if (rel === ".claude/settings.json" || rel === ".claude/settings.local.json") {
    return ensureClaudeSettingsHook(body, { uninstall: true }).body;
  }
  if (rel === ".cursor/hooks.json") return ensureCursorHooks(body, { uninstall: true }).body;
  if (rel === ".codex/hooks.json") return ensureCodexHooks(body, { uninstall: true }).body;
  if (rel === ".codex/config.toml") return ensureCodexConfigToml(body, { uninstall: true }).body;
  return null;
}

/**
 * Apply a plan. Idempotent: running it twice reaches the same state, because
 * every action is expressed as "make this true", not "change this".
 *
 * A `needsChoice` restore is never applied automatically. Those are the cases
 * where the live file ALSO holds the user's content, and picking a merge for
 * them is the one thing eject must not do behind their back.
 */
export async function applyEject(root: string, plan: EjectPlan): Promise<EjectResult> {
  const ordered = [...plan.actions].sort(
    (a, b) => ORDER[a.kind] - ORDER[b.kind] || a.path.localeCompare(b.path),
  );
  const results: EjectActionResult[] = [];
  // Paths a restore has already written this run. A stale plan (built before a
  // recovery, applied after) could still carry a delete for one of them, and
  // deleting a just-restored file is the worst outcome eject has.
  const restored = new Set<string>();
  // Paths apply declined to touch. A delete must not remove a directory that
  // contains one: the skip decision and the delete decision come from different
  // parts of the plan, and only this check makes them agree.
  const skippedPaths = new Set<string>();

  for (const action of ordered) {
    try {
      const abs = resolveInside(root, action.path);
      if (action.kind !== "restore_backup" && restored.has(action.path)) {
        results.push({ action, outcome: "skipped", note: "just restored from a backup" });
        continue;
      }
      if (action.kind === "delete_file") {
        const blocking = [...skippedPaths].find(
          (p) => p === action.path || p.startsWith(`${action.path}/`),
        );
        if (blocking) {
          results.push({
            action,
            outcome: "skipped",
            note: `holds ${blocking}, which still needs your decision`,
          });
          continue;
        }
      }

      if (action.kind === "restore_backup") {
        if (!action.target) {
          skippedPaths.add(action.path);
          results.push({ action, outcome: "skipped", note: "no target to restore to" });
          continue;
        }
        if (action.reason.includes("needs your call")) {
          skippedPaths.add(action.path);
          results.push({ action, outcome: "skipped", note: "live file also holds your content" });
          continue;
        }
        const body = await readFile(abs, "utf8");
        await writeFile(resolveInside(root, action.target), body);
        await unlink(abs);
        restored.add(action.target);
        results.push({ action, outcome: "done" });
        continue;
      }

      if (action.kind === "discard_backup") {
        await rm(abs, { force: true });
        results.push({ action, outcome: "done" });
        continue;
      }

      if (action.kind === "strip_region") {
        const body = await readFile(abs, "utf8");
        const bounds = regionBounds(body);
        if (bounds.kind !== "one") {
          results.push({ action, outcome: "skipped", note: bounds.kind === "none" ? "region already gone" : `left as it is: ${bounds.reason}` });
          continue;
        }
        const rest = retractRegion(body, bounds);
        if (rest === "") {
          // The region was the whole file after all: nothing of the user's left.
          await rm(abs, { force: true });
          results.push({ action, outcome: "done", note: "file was entirely Pathrule's" });
          continue;
        }
        await writeFile(abs, rest);
        results.push({ action, outcome: "done" });
        continue;
      }

      if (action.kind === "strip_block") {
        const body = await readFile(abs, "utf8");
        const next = stripGitignoreBlock(body);
        if (next === body) {
          results.push({ action, outcome: "skipped", note: "block already gone" });
          continue;
        }
        if (next === "") await rm(abs, { force: true });
        else await writeFile(abs, next);
        results.push({ action, outcome: "done" });
        continue;
      }

      if (action.kind === "unhook") {
        const body = await readFile(abs, "utf8");
        const next = unhookBody(action.path, body);
        if (next === null) {
          results.push({ action, outcome: "skipped", note: "no merger for this file" });
          continue;
        }
        // A merger that answers with an empty body is asking for the file to go
        // (it was ours outright), as is a JSON config left as `{}` that Pathrule's
        // ledger says it wrote; anything else keeps the user's config.
        if (next.trim() === "" || (action.ledger === true && next.trim() === "{}")) await rm(abs, { force: true });
        else await writeFile(abs, next);
        results.push({ action, outcome: "done" });
        continue;
      }

      // delete_file, including the Pathrule directory.
      await rm(abs, { recursive: true, force: true });
      results.push({ action, outcome: "done" });
    } catch (err) {
      // A config Pathrule cannot read is left exactly as it is: skipped, and said why.
      const unreadable = err instanceof HookConfigUnreadableError;
      results.push({
        action,
        outcome: unreadable ? "skipped" : "failed",
        note: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Folders Pathrule's files lived in, once nothing is left in them: never one holding anything else.
  for (const dir of [RULES_DIR, ".claude/rules", ".codex", ".claude"]) {
    await rmdir(join(root, dir)).catch(() => undefined);
  }

  // Eject changes the answer to "is a backup still waiting", so the latch must
  // not keep serving the pre-eject verdict for another five minutes.
  invalidateRecoveryLatch(root);

  return {
    results,
    done: results.filter((r) => r.outcome === "done").length,
    skipped: results.filter((r) => r.outcome === "skipped").length,
    failed: results.filter((r) => r.outcome === "failed").length,
  };
}
