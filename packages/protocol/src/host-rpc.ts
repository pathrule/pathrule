// SPDX-License-Identifier: Apache-2.0
/**
 * The Pathrule host's RPC: what a client (the CLI, the MCP server, an editor extension) speaks
 * to the one host process of a Pathrule home. Types and constants only.
 *
 * - **Transport:** HTTP on 127.0.0.1, `POST /rpc`, one JSON envelope per request.
 * - **Discovery:** a running host publishes its port and bearer token in its discovery record,
 *   `<Pathrule home>/host/host.json`, readable only by the user who runs it (0600).
 * - **Access:** the host refuses a request that comes from a browser (an `Origin` header, or a
 *   `Host` that is not the loopback address and the host's own port) and one that does not carry
 *   the record's bearer token. It refuses before any method runs.
 * - **Versions:** bump `HOST_RPC_VERSION` when a change breaks a client built for the previous
 *   one. A client and a host of different versions refuse each other with `rpc_version_mismatch`;
 *   neither guesses.
 */

import type { TurnContext, TurnContextRequest } from "./turn-context.js";
import type { RuntimeIngestResult } from "./runtime-events.js";

export const HOST_RPC_VERSION = 1;

/** The one path the host serves. */
export const HOST_RPC_PATH = "/rpc";

export type HostRpcId = string | number;

export interface HostRpcRequest {
  /** The `HOST_RPC_VERSION` the client was built for. */
  v: number;
  id: HostRpcId;
  method: string;
  params?: unknown;
}

export type HostRpcErrorCode =
  /** The envelope's `v` is not the host's `HOST_RPC_VERSION`. */
  | "rpc_version_mismatch"
  /** Not a JSON envelope with a version, an id and a method. */
  | "invalid_request"
  | "invalid_params"
  | "method_not_found"
  /** No bearer token, or not this host's. */
  | "unauthorized"
  /** The request carries an `Origin` header: it comes from a browser. */
  | "forbidden_origin"
  /** The `Host` header is not the loopback address and the host's port. */
  | "forbidden_host"
  | "unsupported_media_type"
  | "payload_too_large"
  | "not_found"
  | "method_not_allowed"
  /** The host is stopping and takes no new requests. */
  | "shutting_down"
  /** The method did not answer within the host's request deadline. */
  | "timeout"
  /** A store method threw; `data` is a `HostStoreErrorData`, so the client can throw it again. */
  | "store_error"
  | "internal_error";

export interface HostRpcError {
  code: HostRpcErrorCode;
  message: string;
  data?: unknown;
}

/** What a `store_error` carries: the thrown error's name and its own JSON fields (`code`, `detail`). */
export interface HostStoreErrorData {
  name: string;
  fields: Record<string, unknown>;
}

/** `id` is null only when the request was refused before its envelope could be read. */
export type HostRpcResponse =
  | { v: number; id: HostRpcId | null; ok: true; result: unknown }
  | { v: number; id: HostRpcId | null; ok: false; error: HostRpcError };

/**
 * What a running host publishes at `<Pathrule home>/host/host.json` (0600, in a 0700 directory).
 * One record per Pathrule home, so one host per home.
 */
export interface HostDiscoveryRecord {
  schema_version: 1;
  /** The host's `HOST_RPC_VERSION`. */
  rpc: number;
  pid: number;
  /** The loopback port; the host listens on 127.0.0.1 only. */
  port: number;
  /** The bearer token every request must carry. Never printed or logged. */
  token: string;
  /** The host package's version, for diagnostics. */
  version: string;
  /** Unique per start: tells a restarted host's record from the one before it. */
  instance_id: string;
  started_at: string;
  /**
   * The host is its process's whole job (`runHostProcess`), so stopping the process stops only
   * the host. Absent for a host a surface runs inside itself: a signal to that pid would
   * stop the surface too.
   */
  standalone?: true;
}

/**
 * - `active`: activated, and serving its methods.
 * - `refused`: never activated: built for another contract, a second copy of a package the host
 *   shares, or a name the host cannot give it.
 * - `failed`: its activation threw or timed out; its methods are not served.
 */
export type HostPluginState = "active" | "refused" | "failed";

export interface HostPluginStatus {
  name: string;
  /** The contract the plugin was built for. */
  contract: number;
  state: HostPluginState;
  /** Why it is refused or failed. */
  reason?: string;
}

export interface HostHello {
  rpc: number;
  version: string;
  pid: number;
  instanceId: string;
  startedAt: string;
  plugins: HostPluginStatus[];
  /**
   * For a host that stops by itself when idle: after how long without a request, and the plugins
   * that keep it running meanwhile (`<plugin>: <reason>`). Absent for a host that never does.
   */
  idle?: { timeoutMs: number; heldBy: string[] };
  /**
   * The store methods `store.invoke` serves. A surface uses a host only when every method it calls
   * is here, so a host of an older release that lacks one is not used.
   */
  storeMethods?: string[];
}

/** Which local store serves a folder. */
export interface HostWorkspaceIdentity {
  workspaceId: string;
  /** The root that matched: the workspace's folder, or one of its worktrees. */
  root: string;
  /** The folder relative to `root`; empty at the root itself. */
  relativePath: string;
  /** The store is a local copy of a hosted workspace, not a workspace of its own. */
  mirror: boolean;
}

/** One local workspace of the home, as `workspace.list` reports it. Mirrors are never listed. */
export interface HostLocalWorkspaceSummary {
  id: string;
  name: string;
  /** The absolute folder the workspace is bound to. */
  rootPath: string;
}

/** A local workspace `workspace.init` created, or found already covering the folder. */
export interface HostLocalWorkspace {
  workspaceId: string;
  name: string;
  localRootPath: string;
  action: "created" | "exists";
}

/** The host's own methods. A plugin's methods are named `<plugin name>.<method>`. */
export interface HostMethods {
  /** The version handshake: who is answering, and which plugins it runs. */
  "host.hello": { params: Record<string, never>; result: HostHello };
  /** Stop the host. It answers first, then stops taking requests and drains. */
  "host.shutdown": { params: Record<string, never>; result: { stopping: true } };
  /**
   * The store that serves `cwd`, an absolute path: the longest matching root wins. Mirrors of
   * hosted workspaces count only with `includeMirrors`. Null when no local store covers it.
   */
  "workspace.resolve": {
    params: { cwd: string; includeMirrors?: boolean };
    result: HostWorkspaceIdentity | null;
  };
  /**
   * The local workspace for `folder`, an absolute path: one that already covers it, or a new one
   * with its own store, the folder as its root, and a first hook index.
   */
  "workspace.init": { params: { folder: string; name?: string }; result: HostLocalWorkspace };
  /**
   * Every local workspace of the home, read without opening a store for writing (each store's
   * registration, read-only). Mirrors of hosted workspaces are never listed, so `includeMirrors`
   * accepts only `false`. Sorted by name.
   */
  "workspace.list": { params: { includeMirrors?: false }; result: HostLocalWorkspaceSummary[] };
  /**
   * One method of the local store of `workspaceId`, which the host opens on first use. The store's
   * asynchronous public methods are reachable, and a few synchronous ones (`hello.storeMethods`).
   *
   * JSON has no `undefined`, so both directions say where it was: `undefinedArgs` lists the
   * positions of arguments that were `undefined`, and a result without `value` was `undefined`.
   */
  "store.invoke": {
    params: { workspaceId: string; method: string; args?: unknown[]; undefinedArgs?: number[] };
    result: { value?: unknown };
  };
  /** The store's capabilities (the one synchronous method a remote store answers from a cache). */
  "store.capabilities": { params: { workspaceId: string }; result: Record<string, unknown> };
  /** Marks the store of `workspaceId` as a mirror of a hosted workspace, which local discovery skips. */
  "store.markMirror": { params: { workspaceId: string }; result: { marked: true } };
  /**
   * An application's runtime events (the Signals SDK's local destination): the envelope goes to the
   * workspace covering `cwd`, an absolute path, never a mirror. `not_found` when none covers it.
   */
  "signals.ingest": { params: { cwd: string; envelope: unknown }; result: RuntimeIngestResult };
  /**
   * The Pathrule context of one turn in `workspaceRoot`, an absolute path: the block to prepend to
   * the agent's instructions, its versions and its attributions. Only a folder a local store serves
   * has one; any other folder gets the empty context. It never fails a turn: a miss is empty too.
   */
  "context.compile": { params: TurnContextRequest; result: TurnContext };
}

export type HostMethodName = keyof HostMethods;
