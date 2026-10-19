// SPDX-License-Identifier: Apache-2.0
/**
 * Local identity. The OSS edition has no auth and no user id — a single
 * implicit principal owns everything. We stamp content `created_by`/`last_edited_by` with a
 * stable, human-recognisable local principal (the OS username), overridable via
 * `PATHRULE_LOCAL_PRINCIPAL`. This is the only intended behavioral divergence from an
 * authenticated edition (which stamps the signed-in user id). `sessionIsCurrent()` is always
 * true locally.
 *
 * Node-only (reads `os.userInfo()`); kept out of the dependency-free InMemory reference, which
 * defaults to the literal "local".
 */
import { userInfo } from "node:os";

export const LOCAL_PRINCIPAL_FALLBACK = "local";

/** Resolve the local principal: env override → OS username → "local". Never throws. */
export function resolveLocalPrincipal(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PATHRULE_LOCAL_PRINCIPAL?.trim();
  if (override) return override;
  try {
    const name = userInfo().username?.trim();
    if (name) return name;
  } catch {
    // userInfo can throw on exotic platforms — fall through.
  }
  return LOCAL_PRINCIPAL_FALLBACK;
}
