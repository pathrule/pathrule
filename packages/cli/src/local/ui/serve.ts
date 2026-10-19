// SPDX-License-Identifier: Apache-2.0
// `pathrule ui` from start to stop: reuse the home's running console when there is one, otherwise
// serve one over a host session until the caller's signal, then stop it cleanly (the server, the
// last hook index refreshes, the host session, the record).
import type { HostSession } from "@pathrule/host/session.js";

import { CLI_VERSION } from "../../cli-version.js";
import { cliHostSession } from "../host-session.js";
import { createLocalUiApi } from "./api.js";
import { resolveUiAssetsDir } from "./assets.js";
import { HookIndexRefresher, hostHookIndexSync, type HookIndexSync } from "./hook-index.js";
import {
  claimUiRecord,
  liveUiRecord,
  releaseUiRecord,
  requestLaunch,
  type UiInstanceRecord,
} from "./instance.js";
import { startLocalUiServer, type LocalUiServer } from "./server.js";
import { mintToken, type UiTokens } from "./tokens.js";

export interface ServeLocalUiOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** 0 or absent: any free port. */
  port?: number;
  /** Stops a console this call serves. */
  signal: AbortSignal;
  /** Tests: the session the console uses (closed on stop) and the server's parts. */
  session?: HostSession;
  assetsDir?: string | null;
  tokens?: UiTokens;
  hookIndexSync?: HookIndexSync;
  log?(line: string): void;
}

export interface LocalUiLaunch {
  /** The single-use link to open: `http://127.0.0.1:<port>/#launch=<token>`. */
  url: string;
  port: number;
  pid: number;
  /** True when another `pathrule ui` of this home serves it. */
  reused: boolean;
  /** The console's built assets; null when they are not built (and for a reused one). */
  assetsDir: string | null;
}

export interface ServingLocalUi {
  launch: LocalUiLaunch;
  /** Settles once a console this call serves has stopped; at once for a reused one. */
  done: Promise<void>;
  /** The running server, for a console this call serves. */
  server: LocalUiServer | null;
  hookIndex: HookIndexRefresher | null;
}

async function reuse(record: UiInstanceRecord): Promise<ServingLocalUi> {
  const answer = await requestLaunch(record);
  return {
    launch: {
      url: answer.launchUrl,
      port: answer.port,
      pid: answer.pid,
      reused: true,
      assetsDir: null,
    },
    done: Promise.resolve(),
    server: null,
    hookIndex: null,
  };
}

/** Starts (or finds) the home's console. Resolves once its link is ready. */
export async function serveLocalUi(options: ServeLocalUiOptions): Promise<ServingLocalUi> {
  const { env } = options;
  const log = options.log ?? (() => {});

  let stale: UiInstanceRecord | null = null;
  const existing = await liveUiRecord(env);
  if (existing) {
    try {
      return await reuse(existing);
    } catch (err) {
      log(
        `the recorded pathrule ui (pid ${existing.pid}) did not answer (${err instanceof Error ? err.message : String(err)}); starting a new one`,
      );
      stale = existing;
    }
  }

  const session = options.session ?? cliHostSession(env);
  const hookIndex = new HookIndexRefresher({
    sync: options.hookIndexSync ?? hostHookIndexSync(session, env, log),
    log,
  });
  const assetsDir = options.assetsDir === undefined ? resolveUiAssetsDir(env) : options.assetsDir;
  const controlToken = mintToken();
  let server: LocalUiServer;
  try {
    server = await startLocalUiServer({
      api: createLocalUiApi({
        session,
        env,
        cwd: options.cwd,
        cliVersion: CLI_VERSION,
        hookIndex,
      }),
      assetsDir,
      ...(options.port ? { port: options.port } : {}),
      ...(options.tokens ? { tokens: options.tokens } : {}),
      controlToken,
      log,
    });
  } catch (err) {
    await session.close();
    throw err;
  }

  const ours: UiInstanceRecord = {
    pid: process.pid,
    port: server.port,
    controlToken,
    version: CLI_VERSION,
  };
  const stop = async () => {
    await server.close();
    await hookIndex.close();
    await session.close("pathrule ui stopped");
    await releaseUiRecord(env, controlToken);
  };

  try {
    // Another `pathrule ui` may have claimed the home while this one started.
    const other = await claimUiRecord(env, ours, stale);
    if (other) {
      try {
        const reused = await reuse(other);
        await stop();
        return reused;
      } catch {
        await claimUiRecord(env, ours, other);
      }
    }
  } catch (err) {
    await stop();
    throw err;
  }

  const done = new Promise<void>((resolve) => {
    const finish = () => {
      // Once the server has closed, nothing else may hold the event loop open, and Node would exit
      // in the middle of the cleanup (the record of this instance would stay behind). Hold it open
      // until the cleanup is done.
      const keepAlive = setInterval(() => {}, 1_000);
      void stop().finally(() => {
        clearInterval(keepAlive);
        resolve();
      });
    };
    if (options.signal.aborted) finish();
    else options.signal.addEventListener("abort", finish, { once: true });
  });
  return {
    launch: {
      url: server.launchUrl(),
      port: server.port,
      pid: process.pid,
      reused: false,
      assetsDir,
    },
    done,
    server,
    hookIndex,
  };
}
