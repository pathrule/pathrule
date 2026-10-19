// SPDX-License-Identifier: Apache-2.0
/**
 * Bring the personal half of every hook index on this machine up to date with the person store.
 *
 * A hook index is rewritten whole only when ITS workspace syncs (get_context, `pathrule sync`, the host's
 * warm-up). So a belief the person forgot or narrowed kept its old line in every other workspace's index
 * until that workspace happened to sync again, and the hook went on delivering it: Forget did not mean
 * forget. The same gap kept preferences compiled by an older build alive after an upgrade.
 *
 * This rewrites only the personal fields of each index, compiled by the open compiler (the same entries a
 * full sync carries), and leaves every other byte of the index as it was. Best-effort throughout: a missing,
 * unreadable or foreign file is skipped and never fails the control that called this. The write re-reads
 * the file first, so a full sync that landed while this compiled is never overwritten with older content.
 *
 * Entries belong to a person (`personal_owner`, absent for the accountless local file). A refresh for
 * one person rewrites only the indexes that carry that person's entries, or none, so an account's
 * beliefs never replace the local person's in an unrelated workspace, nor the other way round.
 * `forgetPersonalFieldsOf` removes an account's entries from every index when it signs out.
 */
import { randomUUID } from "node:crypto";
import { chmod, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { localRuntimePaths } from "@pathrule/core/storage/paths.js";
import type { PersonalEntriesConfig } from "@pathrule/core/engine/contracts.js";
import { openPersonalIndexEntries } from "@pathrule/core/user-knowledge/user-knowledge-capture.js";
import { userKnowledgeStoreFor } from "@pathrule/core/user-knowledge/user-knowledge-store.js";

export interface PersonalIndexRefresh {
  /** Indexes whose personal fields changed and were rewritten. */
  refreshed: number;
  /** Indexes already carrying exactly what the store says. */
  unchanged: number;
  /** Index files that could not be read, did not belong to their directory, or changed underneath. */
  skipped: number;
}

/** `user_preference_risk_terms` is written by no current build; an index that still has it predates them. */
const PERSONAL_FIELDS = ["user_preferences", "guidance", "user_preference_risk_terms", "personal_owner"] as const;

const ownerOf = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

type IndexObject = Record<string, unknown>;

function personalOf(index: IndexObject): string {
  return JSON.stringify(PERSONAL_FIELDS.map((field) => index[field] ?? null));
}

async function refreshOne(path: string, dirName: string, cfg: PersonalEntriesConfig): Promise<keyof PersonalIndexRefresh | null> {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) return null; // no index in this directory: not a workspace cache
  let index: IndexObject;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "skipped";
    index = parsed as IndexObject;
  } catch {
    return "skipped";
  }
  if (index["workspace_id"] !== dirName) return "skipped";
  const root = typeof index["workspace_root"] === "string" && index["workspace_root"] !== "" ? index["workspace_root"] : null;
  // Another person's entries are not this refresh's to replace.
  const owner = ownerOf(cfg.userId);
  const hasPersonal = index["user_preferences"] !== undefined || index["guidance"] !== undefined;
  if (hasPersonal && ownerOf(index["personal_owner"]) !== owner) return "unchanged";
  // The open compiler, as a sync writes it.
  const personal = await openPersonalIndexEntries(
    userKnowledgeStoreFor(cfg),
    join(localRuntimePaths(cfg.env ?? process.env).home, "cache", dirName),
    dirName,
    [root],
  );

  // Same rule as the full writer: a field is present only when it carries something.
  const next: IndexObject = { ...index };
  delete next["user_preference_risk_terms"];
  if (personal.userPreferences.length > 0) next["user_preferences"] = personal.userPreferences;
  else delete next["user_preferences"];
  if (personal.guidance.length > 0) next["guidance"] = personal.guidance;
  else delete next["guidance"];
  if (owner !== null && (next["user_preferences"] || next["guidance"])) next["personal_owner"] = owner;
  else delete next["personal_owner"];
  if (personalOf(next) === personalOf(index)) return "unchanged";

  if ((await readFile(path, "utf8").catch(() => null)) !== raw) return "skipped"; // a sync wrote meanwhile
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch {
    await rm(tmp, { force: true }).catch(() => undefined);
    return "skipped";
  }
  return "refreshed";
}

/**
 * Remove what belongs to `owners` from every hook index under `<PATHRULE_HOME>/cache`: their personal
 * entries (`personal_owner`) and their profile block (`intelligence_profiles.owner`). Called when an
 * account signs out, is switched away from or is revoked; the hook already withholds these once the
 * owner is gone, and this takes them off the disk. Project knowledge and the accountless local
 * person's entries are never touched. Never throws; returns how many indexes changed.
 */
export async function forgetPersonalFieldsOf(owners: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const gone = new Set(owners.map(ownerOf).filter((o): o is string => o !== null));
  if (gone.size === 0) return 0;
  const cacheDir = join(localRuntimePaths(env).home, "cache");
  const dirs = await readdir(cacheDir, { withFileTypes: true }).catch(() => []);
  let changed = 0;
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const path = join(cacheDir, dir.name, "hook-index.json");
    const raw = await readFile(path, "utf8").catch(() => null);
    if (raw === null) continue;
    let index: IndexObject;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      index = parsed as IndexObject;
    } catch {
      continue;
    }
    const next: IndexObject = { ...index };
    const personalOwner = ownerOf(index["personal_owner"]);
    if (personalOwner !== null && gone.has(personalOwner)) {
      for (const field of PERSONAL_FIELDS) delete next[field];
    }
    const profiles = index["intelligence_profiles"] as { owner?: unknown } | undefined;
    if (profiles && typeof profiles === "object" && gone.has(ownerOf(profiles.owner) ?? "")) {
      delete next["intelligence_profiles"];
    }
    if (Object.keys(next).length === Object.keys(index).length) continue;
    if ((await readFile(path, "utf8").catch(() => null)) !== raw) continue; // a sync wrote meanwhile
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
      await chmod(tmp, 0o600);
      await rename(tmp, path);
      changed += 1;
    } catch {
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }
  return changed;
}

/** Recompile the personal fields of every hook index under `<PATHRULE_HOME>/cache`. Never throws. */
export async function refreshPersonalHookIndexes(cfg: PersonalEntriesConfig = {}): Promise<PersonalIndexRefresh> {
  const result: PersonalIndexRefresh = { refreshed: 0, unchanged: 0, skipped: 0 };
  const cacheDir = join(localRuntimePaths(cfg.env ?? process.env).home, "cache");
  const dirs = await readdir(cacheDir, { withFileTypes: true }).catch(() => []);
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const outcome = await refreshOne(join(cacheDir, dir.name, "hook-index.json"), dir.name, cfg).catch(() => "skipped" as const);
    if (outcome) result[outcome] += 1;
  }
  return result;
}
