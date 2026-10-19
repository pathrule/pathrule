// SPDX-License-Identifier: Apache-2.0
// Local binding: the folder's local store, reached through the home's Pathrule host
// (@pathrule/host), the stores' one owner (open-core step 4h3). The extension keeps one host
// session for its life. It uses the running host, or launches one with the bundled CLI under
// Electron as Node (activate.ts says how); only when no host can be launched does it run the host
// here. Which store serves a folder is the folder's edition (./folder-mode.ts), read with SQLite in
// this extension host only when ./local.ts finds it loads.
//
// The import is DYNAMIC: if the store's code cannot load in this extension host, local mode
// degrades gracefully instead of failing activation. Nothing else in the extension may import the
// SQLite-backed parts of @pathrule/core statically (types via `import type` only).

import type { WorkspaceMatch } from "@pathrule/core/backend/inputs.js";
import type { HostSession } from "@pathrule/host/session.js";

import type { BoundFolder } from "./types.js";

let session: HostSession | null | undefined;

/** The Node-API version better-sqlite3 13 is built against (Node 22.14.0 and Electron 35 on). */
export const SQLITE_NODE_API = 10;

/**
 * Opens an in-memory database with the SQLite binary this extension host would load. Loading the
 * store's code does not load the binary, so without this an editor where it cannot load reported
 * local mode as available and showed a local folder as not set up.
 */
async function sqliteOpens(): Promise<boolean> {
  const versions = process.versions as NodeJS.ProcessVersions & { electron?: string };
  const runtime = versions.electron ? `Electron ${versions.electron}` : `Node ${versions.node}`;
  // better-sqlite3 is built against this Node-API version; an older runtime does not refuse the
  // binary, it crashes the process that loads it, and here that is the whole extension host.
  if (!(Number(versions.napi) >= SQLITE_NODE_API)) {
    console.warn(
      `[pathrule] local mode is unavailable: ${runtime} has Node-API ${versions.napi ?? "unknown"}, ` +
        `and SQLite needs ${SQLITE_NODE_API} (VS Code 1.102 or newer)`,
    );
    return false;
  }
  try {
    const { default: Database } = await import("better-sqlite3");
    new Database(":memory:").close();
    return true;
  } catch (err) {
    console.warn(
      `[pathrule] local mode is unavailable: SQLite does not load in ${runtime} ` +
        `(Node-API ${versions.napi}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

async function localSession(): Promise<HostSession | null> {
  if (session !== undefined) return session;
  try {
    if (!(await sqliteOpens())) {
      session = null;
      return session;
    }
    const [{ HostSession: Session }, { cliHostLaunch }] = await Promise.all([
      import("@pathrule/host/session.js"),
      import("#cli/local/self-command.js"),
    ]);
    session = new Session({ env: process.env, launch: cliHostLaunch(), version: "vscode" });
  } catch {
    session = null;
  }
  return session;
}

export async function localModeAvailable(): Promise<boolean> {
  return (await localSession()) !== null;
}

/** Opens the Local workspace the folder's edition named, or null when local mode cannot run here. */
export async function openLocalBinding(match: WorkspaceMatch): Promise<BoundFolder | null> {
  const local = await localSession();
  if (!local) return null;
  return {
    kind: "local",
    backend: await local.store(match.workspaceId),
    workspaceId: match.workspaceId,
    workspaceName: null,
    localRootPath: match.localRootPath,
    relativePath: match.relativePath,
  };
}

/** Ends the session: a host this extension host ran stops; a launched one keeps serving. */
export async function closeLocalBinding(): Promise<void> {
  const current = session;
  session = undefined;
  await current?.close("the extension deactivated");
}
