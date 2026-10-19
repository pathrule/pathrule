// SPDX-License-Identifier: Apache-2.0
/**
 * The host's RPC methods by name. The host registers its own (`host.*`, `workspace.*`), and each
 * plugin registers its methods under its own name (`<plugin name>.<method>`), so two parties can
 * never answer the same name.
 */
import type { HostRpcErrorCode } from "@pathrule/protocol/host-rpc.js";

/** A method's refusal, sent to the client as the envelope's error. */
export class HostRpcFailure extends Error {
  readonly code: HostRpcErrorCode;
  /** Sent as the envelope error's `data`. */
  readonly data: unknown;

  constructor(code: HostRpcErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = "HostRpcFailure";
    this.code = code;
    this.data = data;
  }
}

export interface HostMethodContext {
  /** Aborted when the request's deadline passes or the client goes away. */
  readonly signal: AbortSignal;
}

export type HostMethodHandler = (
  params: unknown,
  context: HostMethodContext,
) => unknown | Promise<unknown>;

/** `namespace.method`: a lowercase namespace, then one or more camelCase segments. */
const METHOD_NAME = /^[a-z][a-z0-9-]*(?:\.[a-z][A-Za-z0-9]*)+$/;

export class HostMethodRegistry {
  private readonly handlers = new Map<string, HostMethodHandler>();

  register(name: string, handler: HostMethodHandler): void {
    if (!METHOD_NAME.test(name)) throw new Error(`invalid host method name "${name}"`);
    if (this.handlers.has(name)) throw new Error(`host method "${name}" is already registered`);
    this.handlers.set(name, handler);
  }

  unregister(name: string): void {
    this.handlers.delete(name);
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  /** The namespaces in use: the part of each name before its first dot. */
  namespaces(): Set<string> {
    return new Set([...this.handlers.keys()].map((name) => name.slice(0, name.indexOf("."))));
  }

  async dispatch(name: string, params: unknown, context: HostMethodContext): Promise<unknown> {
    const handler = this.handlers.get(name);
    if (!handler) throw new HostRpcFailure("method_not_found", `no host method "${name}"`);
    return handler(params, context);
  }
}
