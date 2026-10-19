// SPDX-License-Identifier: Apache-2.0
/**
 * How a Pathrule surface (the CLI, the MCP server, VS Code) uses the host of its Pathrule home. The
 * rules are Studio's composition since step 4b3, generalised:
 *
 * - **Client:** a running host serves the home and every store method this surface calls (its
 *   `storeMethods`). The surface uses its stores over the RPC.
 * - **Launched:** none runs and the surface's composition says how to run one (`launch`, the CLI's
 *   own entry with `host run`). It starts as a process of its own, which outlives this surface and
 *   stops by itself when idle, and the surface is its client.
 * - **Own:** none runs and none can be launched (no launch command, or the launch failed). This
 *   process runs the host until the session closes; other surfaces are its clients meanwhile.
 * - **Degraded:** a host that cannot be used holds the home (another RPC version, a store method it
 *   lacks). This process opens the stores itself with the host's opener and says why in the log:
 *   the behaviour from before the host, with two owners, rather than no local knowledge.
 *
 * A store is a proxy. When the host a call went to has gone, the call starts over once on whatever
 * the session finds next: the next host, a newly launched one, or this process.
 *
 * Which store serves a folder is read in this process (`resolveLocal`): it opens no store and never
 * starts a host.
 */
import type {
  HostLocalWorkspace,
  HostLocalWorkspaceSummary,
  HostWorkspaceIdentity,
} from "@pathrule/protocol/host-rpc.js";

import { connectHost, HostClientError, type HostClient } from "./client.js";
import { HostAlreadyRunningError } from "./discovery.js";
import { startHost, type RunningHost } from "./host.js";
import { launchHost, type HostLaunchCommand } from "./launch.js";
import type { HostPlugin } from "./plugin.js";
import { connectRemoteStore, type RemoteStore } from "./remote-store.js";
import { HOST_STORE_CALLABLE } from "./store-methods.js";
import { WorkspaceStores } from "./stores.js";
import { listLocalWorkspaces, resolveWorkspaceIdentity } from "./workspace.js";
import { initLocalWorkspace } from "./workspace-init.js";

export interface HostSessionOptions {
  env?: NodeJS.ProcessEnv;
  /** How to run the home's host as a process of its own; absent: this process runs it instead. */
  launch?: HostLaunchCommand | null;
  /** What a host this process runs reports as its version. */
  version?: string;
  /** The plugins of a host this process runs. */
  plugins?: () => readonly HostPlugin[] | Promise<readonly HostPlugin[]>;
  /** How long to wait for a launched host to answer. */
  launchWaitMs?: number;
  log?(line: string): void;
}

export type HostSessionMode = "client" | "own" | "degraded";

type SessionState =
  | { kind: "client"; client: HostClient; stores: Map<string, Promise<RemoteStore>> }
  | { kind: "own"; host: RunningHost }
  | { kind: "degraded"; stores: WorkspaceStores; reason: string };

/** True when an error says the host this session talked to is gone. */
function hostGone(err: unknown): boolean {
  return err instanceof HostClientError && err.code === "unreachable";
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class HostSession {
  private state: Promise<SessionState> | null = null;
  private closed = false;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: (line: string) => void;

  constructor(private readonly options: HostSessionOptions = {}) {
    this.env = options.env ?? process.env;
    this.log = options.log ?? (() => {});
  }

  /** How this session reaches the stores now, starting it when needed. */
  async mode(): Promise<HostSessionMode> {
    return (await this.current()).kind;
  }

  /** The client of the host this session uses, or null when this process runs it or is degraded. */
  async client(): Promise<HostClient | null> {
    const state = await this.current();
    return state.kind === "client" ? state.client : null;
  }

  /** Which local store serves `cwd`, read in this process; it opens no store and starts no host. */
  resolveLocal(
    cwd: string,
    options: { includeMirrors?: boolean } = {},
  ): HostWorkspaceIdentity | null {
    return resolveWorkspaceIdentity(cwd, this.env, options);
  }

  /**
   * Every local workspace of the home, mirrors left out (`workspace.list`). A host of an older
   * release that lacks the method is answered by the same read-only scan in this process, which
   * opens no store for writing.
   */
  listWorkspaces(): Promise<HostLocalWorkspaceSummary[]> {
    return this.withHost(async (state) => {
      if (state.kind !== "client") return listLocalWorkspaces(this.env);
      try {
        return await state.client.call("workspace.list", {});
      } catch (err) {
        if (err instanceof HostClientError && err.code === "method_not_found") {
          return listLocalWorkspaces(this.env);
        }
        throw err;
      }
    });
  }

  /** The local store of `workspaceId`, opened by the host on first use. */
  async store(workspaceId: string): Promise<RemoteStore> {
    const first = await this.withHost((state) => this.storeIn(state, workspaceId));
    const proxy: Record<string, unknown> = { capabilities: () => first.capabilities() };
    for (const method of HOST_STORE_CALLABLE) {
      proxy[method] = (...args: unknown[]) =>
        this.withHost(async (state) => {
          const target = (await this.storeIn(state, workspaceId)) as unknown as Record<
            string,
            (...a: unknown[]) => unknown
          >;
          return target[method]!(...args);
        });
    }
    return proxy as unknown as RemoteStore;
  }

  /** The local workspace for `folder`: one that covers it, or a new one with its first hook index. */
  initWorkspace(input: { folder: string; name?: string }): Promise<HostLocalWorkspace> {
    return this.withHost(async (state) => {
      if (state.kind === "client") return state.client.call("workspace.init", input);
      const stores = state.kind === "own" ? state.host.stores : state.stores;
      return initLocalWorkspace(input, { env: this.env, stores, log: this.log });
    });
  }

  /** Marks the store of `workspaceId` as a mirror of a hosted workspace. */
  markMirror(workspaceId: string): Promise<void> {
    return this.withHost(async (state) => {
      if (state.kind === "client") {
        await state.client.call("store.markMirror", { workspaceId });
        return;
      }
      const stores = state.kind === "own" ? state.host.stores : state.stores;
      stores.get(workspaceId);
      stores.markMirror(workspaceId);
    });
  }

  /**
   * Ends the session: a host this process runs stops (another surface may launch or run the next),
   * and stores it opened while degraded close. A launched host keeps running.
   */
  async close(reason = "the session closed"): Promise<void> {
    this.closed = true;
    const state = this.state ? await this.state.catch(() => null) : null;
    this.state = null;
    if (state?.kind === "own") await state.host.stop(reason);
    if (state?.kind === "degraded") state.stores.closeAll();
  }

  private current(): Promise<SessionState> {
    if (this.closed) return Promise.reject(new Error("the host session is closed"));
    this.state ??= this.begin().catch((err: unknown) => {
      this.state = null;
      throw err;
    });
    return this.state;
  }

  private async begin(attempt = 1): Promise<SessionState> {
    let running: HostClient | null;
    try {
      running = await connectHost({ env: this.env });
    } catch (err) {
      return this.degraded(err);
    }
    if (running) return this.use(running);

    if (this.options.launch) {
      try {
        const { client } = await launchHost({
          env: this.env,
          launch: this.options.launch,
          ...(this.options.launchWaitMs === undefined ? {} : { waitMs: this.options.launchWaitMs }),
          log: this.log,
        });
        return this.use(client);
      } catch (err) {
        this.log(`could not launch the host (${message(err).split("\n")[0]}); running it here`);
      }
    }

    try {
      const host = await startHost({
        env: this.env,
        ...(this.options.version === undefined ? {} : { version: this.options.version }),
        plugins: [...((await this.options.plugins?.()) ?? [])],
        log: this.log,
      });
      return { kind: "own", host };
    } catch (err) {
      // Another surface claimed the home meanwhile: use its host, once.
      if (err instanceof HostAlreadyRunningError && attempt === 1) return this.begin(2);
      return this.degraded(err);
    }
  }

  private async use(client: HostClient): Promise<SessionState> {
    let served: readonly string[];
    try {
      served = (await client.call("host.hello", {})).storeMethods ?? [];
    } catch (err) {
      return this.degraded(err);
    }
    const missing = HOST_STORE_CALLABLE.filter((method) => !served.includes(method));
    if (missing.length > 0) {
      return this.degraded(
        new Error(
          `the running host (pid ${client.record.pid}, ${client.record.version}) does not serve ${missing.join(", ")}`,
        ),
      );
    }
    return { kind: "client", client, stores: new Map() };
  }

  private degraded(err: unknown): SessionState {
    const reason = message(err);
    this.log(`no usable host, opening local stores in this process: ${reason}`);
    return { kind: "degraded", stores: new WorkspaceStores(this.env), reason };
  }

  private storeIn(state: SessionState, workspaceId: string): Promise<RemoteStore> | RemoteStore {
    if (state.kind !== "client") {
      const stores = state.kind === "own" ? state.host.stores : state.stores;
      return stores.get(workspaceId) as unknown as RemoteStore;
    }
    let store = state.stores.get(workspaceId);
    if (!store) {
      store = connectRemoteStore(state.client, workspaceId);
      state.stores.set(workspaceId, store);
      store.catch(() => state.stores.delete(workspaceId));
    }
    return store;
  }

  /** Runs `fn` on the current state; when its host has gone, starts over once. */
  private async withHost<T>(fn: (state: SessionState) => Promise<T> | T): Promise<T> {
    const state = await this.current();
    try {
      return await fn(state);
    } catch (err) {
      if (state.kind !== "client" || !hostGone(err)) throw err;
      this.log("the host this surface used is gone; starting over");
      this.state = null;
      return fn(await this.current());
    }
  }
}
