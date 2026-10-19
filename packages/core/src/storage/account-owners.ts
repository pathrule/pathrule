// SPDX-License-Identifier: Apache-2.0
// Who is signed in on this machine, by account provider, with no credential in it.
//
// The hook delivers a person's profile block only while that person is signed in here. An account
// provider (a native Pathrule Cloud session, for one) is recognised through this record: its
// credential writer records the owner it authenticated and clears it on sign-out or an account
// change. The record never holds a token and is never a credential: a
// provider whose session ends removes its owner, and nothing here can sign anyone in.
//
// One owner per provider: recording another account for the same provider replaces the first, which
// is how an account switch stops the previous person's deliveries. Readers are the hook
// (`signedInAccountIds` in integrations/hook-supervisor/pathrule-hook.js, which reads this file
// directly) and the composition that resolves a provider's binding.

import { readFile, rm } from "node:fs/promises";

import { atomicWrite, serializeByPath } from "./atomic-write.js";
import { localRuntimePaths, PATHRULE_FILE_MODE } from "./paths.js";

export const ACCOUNT_OWNERS_SCHEMA_VERSION = 1;

/** A provider name: lowercase letters, digits and dashes, as a plugin name is. */
const PROVIDER = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface AccountOwnerEntry {
  user_id: string;
  updated_at: string;
}

export interface AccountOwnersFile {
  schema_version: typeof ACCOUNT_OWNERS_SCHEMA_VERSION;
  owners: Record<string, AccountOwnerEntry>;
}

function assertProvider(provider: string): void {
  if (!PROVIDER.test(provider)) throw new Error(`invalid account provider: ${provider}`);
}

function parse(raw: string): AccountOwnersFile {
  const empty: AccountOwnersFile = { schema_version: ACCOUNT_OWNERS_SCHEMA_VERSION, owners: {} };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!value || typeof value !== "object") return empty;
  const file = value as { schema_version?: unknown; owners?: unknown };
  if (file.schema_version !== ACCOUNT_OWNERS_SCHEMA_VERSION) return empty;
  if (!file.owners || typeof file.owners !== "object") return empty;
  const owners: Record<string, AccountOwnerEntry> = {};
  for (const [provider, entry] of Object.entries(file.owners as Record<string, unknown>)) {
    const e = entry as { user_id?: unknown; updated_at?: unknown } | null;
    if (!PROVIDER.test(provider) || !e || typeof e.user_id !== "string" || e.user_id === "")
      continue;
    owners[provider] = {
      user_id: e.user_id,
      updated_at: typeof e.updated_at === "string" ? e.updated_at : "",
    };
  }
  return { schema_version: ACCOUNT_OWNERS_SCHEMA_VERSION, owners };
}

async function readFileOf(path: string): Promise<AccountOwnersFile> {
  try {
    return parse(await readFile(path, "utf8"));
  } catch {
    return { schema_version: ACCOUNT_OWNERS_SCHEMA_VERSION, owners: {} };
  }
}

/** The recorded owner of each provider; empty when nobody is recorded or the file is unreadable. */
export async function readAccountOwners(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, AccountOwnerEntry>> {
  return (await readFileOf(localRuntimePaths(env).accountOwnersFile)).owners;
}

/**
 * Records `userId` as the signed-in owner of `provider`, replacing any previous owner of it. Returns
 * the owner it replaced, or null, so the caller can drop what it cached for that person.
 */
export async function recordAccountOwner(
  provider: string,
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): Promise<string | null> {
  assertProvider(provider);
  if (userId.trim() === "") throw new Error("an account owner needs a user id");
  const path = localRuntimePaths(env).accountOwnersFile;
  return serializeByPath(path, async () => {
    const file = await readFileOf(path);
    const previous = file.owners[provider]?.user_id ?? null;
    if (previous === userId) return previous;
    file.owners[provider] = { user_id: userId, updated_at: now().toISOString() };
    await atomicWrite(path, `${JSON.stringify(file, null, 2)}\n`, { mode: PATHRULE_FILE_MODE });
    return previous;
  });
}

/**
 * Forgets the owner of `provider`, or of every provider when none is named (signing out
 * everywhere). Returns the owners it removed.
 */
export async function clearAccountOwner(
  provider: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  if (provider !== null) assertProvider(provider);
  const path = localRuntimePaths(env).accountOwnersFile;
  return serializeByPath(path, async () => {
    const file = await readFileOf(path);
    const removed = Object.entries(file.owners)
      .filter(([name]) => provider === null || name === provider)
      .map(([, entry]) => entry.user_id);
    if (removed.length === 0) return [];
    if (provider === null) {
      await rm(path, { force: true });
      return removed;
    }
    delete file.owners[provider];
    await atomicWrite(path, `${JSON.stringify(file, null, 2)}\n`, { mode: PATHRULE_FILE_MODE });
    return removed;
  });
}
