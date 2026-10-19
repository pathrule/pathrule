// SPDX-License-Identifier: Apache-2.0
/**
 * Where the CLI keeps what the person chose for it: `<PATHRULE_HOME>/capabilities/`, which holds
 * `selection.json` (./selection.ts). Earlier CLI versions installed capability packages under
 * per-version homes here; the CLI builds its capabilities in now and installs nothing, and the
 * runtime-session leases still name this CLI copy's home so an update knows which copy runs.
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { pathruleHome } from "@pathrule/core/storage/paths.js";

/** `<PATHRULE_HOME>/capabilities`. */
export function capabilitiesRoot(env: NodeJS.ProcessEnv): string {
  return join(pathruleHome(env), "capabilities");
}

/**
 * The directory of this CLI package: its package.json sits there. This module is
 * `src/capabilities/home.ts` in the workspace; the npm package is one bundle, `dist/index.js`, with
 * package.json one level up. Both resolve to the package root.
 */
export function cliPackageDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return here.endsWith(join("src", "capabilities")) ? join(here, "..", "..") : join(here, "..");
}

/** A short, stable id for one copy of the CLI: a hash of its package directory's real path. */
export function installationId(cliDir: string): string {
  let real = cliDir;
  try {
    real = realpathSync(cliDir);
  } catch {
    // A directory that does not resolve keeps its given path.
  }
  return createHash("sha256").update(real).digest("hex").slice(0, 12);
}

/** The home of one copy of the CLI at one version: what its runtime-session leases name. */
export function capabilityHome(env: NodeJS.ProcessEnv, version: string, cliDir: string): string {
  return join(capabilitiesRoot(env), `${version}-${installationId(cliDir)}`);
}
