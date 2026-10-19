// SPDX-License-Identifier: Apache-2.0
// Where Pathrule's Claude Code hook entries live when no plugin delivers the hook.
//
// `.claude/settings.json` is the team's shared file: it is committed, and a hook entry in it names one
// machine's absolute path (`/Users/<name>/.pathrule/bin/pathrule-hook.js`), which no teammate has. So the
// entries go to `.claude/settings.local.json`, Claude Code's personal project file, and nowhere when the
// person's user-level settings already run the hook (a second entry would run it twice).
//
// Entries an older Pathrule put into the shared file come out of it again; nothing else in it changes.
// A file Pathrule cannot read is never rewritten: it is reported and left as it is.
//
// Node-only.

import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import { atomicWrite } from "@pathrule/core/storage/atomic-write.js";

import { ensureClaudeSettingsHook } from "../pathrule-protocol.js";
import { configInstallsPathruleHook } from "./hook-installed.js";

export const CLAUDE_SHARED_SETTINGS = ".claude/settings.json";
export const CLAUDE_LOCAL_SETTINGS = ".claude/settings.local.json";

export interface ClaudeHookSync {
  /** The project file that carries Pathrule's entries after this run, or null (user level, or none). */
  target: string | null;
  /** Project files this run changed or removed (workspace-relative). */
  changed: string[];
  /** Files whose Pathrule entries could not be touched, and why. */
  errors: Array<{ path: string; message: string }>;
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Takes Pathrule's entries out of one settings file. A file left as `{}` goes only when Pathrule's ledger
 * says Pathrule wrote it (`created`); a file of the person's stays, however little is left in it.
 */
async function removeEntries(root: string, rel: string, created: boolean, out: ClaudeHookSync): Promise<void> {
  const abs = join(root, rel);
  const body = await readIfExists(abs);
  if (body === null || !body.includes("pathrule")) return;
  try {
    const result = ensureClaudeSettingsHook(body, { uninstall: true });
    if (!result.changed) return;
    if (created && result.body.trim() === "{}") await unlink(abs);
    else await atomicWrite(abs, result.body);
    out.changed.push(rel);
  } catch (err) {
    out.errors.push({ path: rel, message: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Bring Claude Code's project hook entries in line: in `.claude/settings.local.json`, unless the user-level
 * settings under `home` already install the hook. `ledger` lists the paths Pathrule's ledger records.
 */
export async function syncClaudeSettingsHook(
  root: string,
  opts: { home: string; ledger: readonly string[] },
): Promise<ClaudeHookSync> {
  const out: ClaudeHookSync = { target: null, changed: [], errors: [] };
  const created = (rel: string) => opts.ledger.includes(rel);
  await removeEntries(root, CLAUDE_SHARED_SETTINGS, created(CLAUDE_SHARED_SETTINGS), out);

  const userLevel = configInstallsPathruleHook((await readIfExists(join(opts.home, ".claude", "settings.json"))) ?? "");
  if (userLevel) {
    await removeEntries(root, CLAUDE_LOCAL_SETTINGS, created(CLAUDE_LOCAL_SETTINGS), out);
    return out;
  }

  const abs = join(root, CLAUDE_LOCAL_SETTINGS);
  try {
    const result = ensureClaudeSettingsHook(await readIfExists(abs));
    if (result.changed) {
      await atomicWrite(abs, result.body);
      out.changed.push(CLAUDE_LOCAL_SETTINGS);
    }
    out.target = CLAUDE_LOCAL_SETTINGS;
  } catch (err) {
    out.errors.push({ path: CLAUDE_LOCAL_SETTINGS, message: err instanceof Error ? err.message : String(err) });
  }
  return out;
}
