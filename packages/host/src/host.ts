// SPDX-License-Identifier: Apache-2.0
/**
 * The Pathrule host: the one local process of a Pathrule home.
 *
 * - **Start:** listen on a loopback port, claim the home's discovery record (one host per home),
 *   activate the plugins, then serve. A request that arrives while plugins activate waits for them.
 * - **Stop** (a signal, `host.shutdown`, or the caller): refuse new requests, drain the ones in
 *   flight within a bound, deactivate the plugins in reverse order, close every store, and remove
 *   the record if it is still this instance's.
 *
 * The host runs and coordinates; it owns no intelligence. Pathrule Cloud arrives as a plugin
 * (./plugin.ts); every decision the host makes is its open default.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  HOST_RPC_VERSION,
  type HostDiscoveryRecord,
  type HostHello,
  type HostPluginStatus,
  type HostRpcRequest,
} from "@pathrule/protocol/host-rpc.js";

import { compileTurnContext, TurnContextCache } from "./context/compile.js";
import { hostTurnSources, parseCompileParams } from "./context/rpc.js";
import { claimHostRecord, releaseHostRecord } from "./discovery.js";
import { IdleWatch } from "./idle.js";
import { startHostJobs } from "./jobs.js";
import { HostMethodRegistry, HostRpcFailure, type HostMethodHandler } from "./methods.js";
import {
  hostPluginRefusal,
  type HostAccountEdition,
  type HostPlugin,
  type HostPluginContext,
} from "./plugin.js";
import { createHostRpcServer } from "./rpc-server.js";
import { ingestSignals } from "./signals.js";
import { HOST_STORE_CALLABLE } from "./store-methods.js";
import { invokeStoreMethod, parseStoreCall } from "./store-rpc.js";
import {
  InvalidWorkspaceIdError,
  StoresClosedError,
  WorkspaceStores,
  type StoreOpener,
} from "./stores.js";
import {
  listLocalWorkspaces,
  parseListParams,
  parseResolveParams,
  resolveWorkspaceIdentity,
} from "./workspace.js";
import { initLocalWorkspace, parseInitParams } from "./workspace-init.js";

const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_ACTIVATION_TIMEOUT_MS = 10_000;

export interface HostOptions {
  env?: NodeJS.ProcessEnv;
  /** Reported in the record and `host.hello`. Defaults to this package's version. */
  version?: string;
  plugins?: readonly HostPlugin[];
  maxBodyBytes?: number;
  /** How long one RPC method may run. */
  requestTimeoutMs?: number;
  /** How long a stop waits for requests in flight. */
  drainTimeoutMs?: number;
  /** How long one plugin's `activate` or `deactivate` may run. */
  activationTimeoutMs?: number;
  /**
   * Stop after this long without a request, unless a plugin keeps the host running
   * (`HostPluginContext.keepAlive`). Absent: the host never stops by itself.
   */
  idleTimeoutMs?: number;
  log?(line: string): void;
  /** How a store is opened; tests replace it. */
  openStore?: StoreOpener;
  /**
   * The host is the process's whole job (`runHostProcess`); the record says so, and the host runs
   * the home's background jobs (./jobs.ts).
   */
  standalone?: boolean;
}

export interface RunningHost {
  readonly record: Readonly<HostDiscoveryRecord>;
  readonly plugins: readonly HostPluginStatus[];
  readonly stores: WorkspaceStores;
  /** Stops the host; every call returns the same promise. */
  stop(reason?: string): Promise<void>;
  /** Settles once the host has stopped, however it was stopped. */
  readonly stopped: Promise<void>;
}

function packageVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      name?: string;
      version?: string;
    };
    return manifest.name === "@pathrule/host" && manifest.version ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
}

const TIMED_OUT = Symbol("timed out");

/** Runs `fn` with a deadline. Throws on a throw; reports a timeout as a failure too. */
async function bounded(fn: () => unknown, timeoutMs: number, what: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const pending = Promise.resolve().then(fn);
    const winner = await Promise.race([
      pending,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
    if (winner === TIMED_OUT) {
      pending.catch(() => {});
      throw new Error(`${what} took longer than ${timeoutMs} ms`);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function startHost(options: HostOptions = {}): Promise<RunningHost> {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  const activationTimeoutMs = options.activationTimeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS;
  const registry = new HostMethodRegistry();
  const stores = new WorkspaceStores(env, options.openStore);

  const record: HostDiscoveryRecord = {
    schema_version: 1,
    rpc: HOST_RPC_VERSION,
    pid: process.pid,
    port: 0,
    token: randomBytes(32).toString("base64url"),
    version: options.version ?? packageVersion(),
    instance_id: randomUUID(),
    started_at: new Date().toISOString(),
    ...(options.standalone ? { standalone: true as const } : {}),
  };

  // The host's own methods come first: they fix the namespaces no plugin may take.
  let stop: (reason?: string) => Promise<void> = async () => {};
  const statuses: HostPluginStatus[] = [];
  const idle = new IdleWatch(options.idleTimeoutMs, () => {
    log(`idle for ${options.idleTimeoutMs} ms`);
    void stop("idle");
  });
  registry.register(
    "host.hello",
    (): HostHello => ({
      rpc: HOST_RPC_VERSION,
      version: record.version,
      pid: record.pid,
      instanceId: record.instance_id,
      startedAt: record.started_at,
      plugins: statuses.map((status) => ({ ...status })),
      ...(options.idleTimeoutMs === undefined
        ? {}
        : { idle: { timeoutMs: options.idleTimeoutMs, heldBy: idle.heldBy() } }),
      storeMethods: [...HOST_STORE_CALLABLE],
    }),
  );
  registry.register("host.shutdown", () => {
    setImmediate(() => void stop("host.shutdown"));
    return { stopping: true };
  });
  registry.register("workspace.resolve", (params) => {
    const { cwd, includeMirrors } = parseResolveParams(params);
    return resolveWorkspaceIdentity(cwd, env, { includeMirrors });
  });
  registry.register("workspace.list", (params) => {
    parseListParams(params);
    return listLocalWorkspaces(env);
  });
  registry.register("workspace.init", (params) =>
    initLocalWorkspace(parseInitParams(params), { env, stores, log }),
  );
  const storeOf = (workspaceId: unknown) => {
    if (typeof workspaceId !== "string") {
      throw new HostRpcFailure("invalid_params", "a store call needs a workspaceId");
    }
    try {
      return stores.get(workspaceId);
    } catch (err) {
      if (err instanceof InvalidWorkspaceIdError)
        throw new HostRpcFailure("invalid_params", err.message);
      if (err instanceof StoresClosedError) throw new HostRpcFailure("shutting_down", err.message);
      throw err;
    }
  };
  registry.register("store.invoke", (params) => {
    const call = parseStoreCall(params);
    return invokeStoreMethod(storeOf(call.workspaceId), call.method, call.args);
  });
  registry.register("signals.ingest", (params) => ingestSignals(params, env, stores));
  registry.register("store.capabilities", (params) => {
    return storeOf((params as { workspaceId?: unknown } | null)?.workspaceId).capabilities();
  });
  registry.register("store.markMirror", (params) => {
    const workspaceId = (params as { workspaceId?: unknown } | null)?.workspaceId;
    storeOf(workspaceId);
    stores.markMirror(workspaceId as string);
    return { marked: true as const };
  });
  // The account edition a plugin provides while it activates, and which plugin that was.
  // Assigned by a plugin's activation, so declared without the initial narrowing to null.
  let account = null as { plugin: string; edition: HostAccountEdition } | null;
  const turnSources = hostTurnSources(env, stores, () => account?.edition ?? null);
  const turnCache = new TurnContextCache();
  registry.register("context.compile", (params) =>
    compileTurnContext(parseCompileParams(params), turnSources, turnCache),
  );
  const hostNamespaces = registry.namespaces();

  const accepted: HostPlugin[] = [];
  for (const plugin of options.plugins ?? []) {
    const reason = hostPluginRefusal(plugin, {
      hostNamespaces,
      takenNames: new Set(accepted.map((p) => p.name)),
    });
    if (reason) {
      statuses.push({ name: plugin.name, contract: plugin.contract, state: "refused", reason });
      log(`plugin ${plugin.name} refused: ${reason}`);
    } else {
      accepted.push(plugin);
    }
  }

  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const server = createHostRpcServer({
    token: record.token,
    dispatch: async (request: HostRpcRequest, signal: AbortSignal) => {
      idle.begin();
      try {
        await ready;
        return await registry.dispatch(request.method, request.params, { signal });
      } finally {
        idle.end();
      }
    },
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    log,
  });
  record.port = await server.listen();

  try {
    await claimHostRecord(env, record);
  } catch (err) {
    await server.close(0);
    throw err;
  }

  const activated: HostPlugin[] = [];
  for (const plugin of accepted) {
    const registered: string[] = [];
    // A plugin whose activation fails keeps nothing running, then or later.
    const holds: Array<() => void> = [];
    let failed = false;
    let activating = true;
    const context: HostPluginContext = {
      env,
      stores,
      log: (line: string) => log(`[${plugin.name}] ${line}`),
      registerMethod(method: string, handler: HostMethodHandler) {
        if (!activating) {
          throw new Error(`${plugin.name} registered ${method} after its activation`);
        }
        const name = `${plugin.name}.${method}`;
        registry.register(name, handler);
        registered.push(name);
      },
      provideAccount(edition) {
        if (!activating) throw new Error(`${plugin.name} provided an account after its activation`);
        if (account) {
          throw new Error(`${account.plugin} already provides the account; ${plugin.name} cannot`);
        }
        account = { plugin: plugin.name, edition: edition as unknown as HostAccountEdition };
      },
      keepAlive(reason: string) {
        if (failed) return () => {};
        const release = idle.hold(`${plugin.name}: ${reason}`);
        holds.push(release);
        return release;
      },
    };
    activated.push(plugin);
    try {
      if (plugin.activate) {
        await bounded(
          () => plugin.activate?.(context),
          activationTimeoutMs,
          `${plugin.name} activation`,
        );
      }
      statuses.push({ name: plugin.name, contract: plugin.contract, state: "active" });
      log(`plugin ${plugin.name} active`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failed = true;
      for (const name of registered) registry.unregister(name);
      for (const release of holds.splice(0)) release();
      if (account?.plugin === plugin.name) account = null;
      statuses.push({ name: plugin.name, contract: plugin.contract, state: "failed", reason });
      log(`plugin ${plugin.name} failed: ${reason}`);
    } finally {
      activating = false;
    }
  }

  let stopJobs: (() => void) | null = null;
  let stopping: Promise<void> | null = null;
  let markStopped!: () => void;
  const stopped = new Promise<void>((resolve) => {
    markStopped = resolve;
  });
  stop = (reason = "stop") => {
    stopping ??= (async () => {
      log(`stopping (${reason})`);
      idle.close();
      stopJobs?.();
      try {
        await server.close(options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
        account = null;
        for (const plugin of [...activated].reverse()) {
          if (!plugin.deactivate) continue;
          try {
            await bounded(
              () => plugin.deactivate?.(),
              activationTimeoutMs,
              `${plugin.name} deactivation`,
            );
          } catch (err) {
            log(
              `plugin ${plugin.name} deactivation failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        for (const failure of stores.closeAll()) log(failure.message);
        const released = await releaseHostRecord(env, record.instance_id);
        if (!released) log("the discovery record belongs to another host now; left in place");
        log("stopped");
      } finally {
        markStopped();
      }
    })();
    return stopping;
  };

  markReady();
  idle.start();
  // The host that is its process's whole job runs the home's background jobs (./jobs.ts).
  if (options.standalone) stopJobs = startHostJobs(env, log);
  log(`ready on 127.0.0.1:${record.port} (rpc ${HOST_RPC_VERSION}, pid ${record.pid})`);

  return {
    record,
    plugins: statuses,
    stores,
    stop: (reason?: string) => stop(reason),
    stopped,
  };
}
