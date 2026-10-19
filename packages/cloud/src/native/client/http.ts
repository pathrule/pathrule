// SPDX-License-Identifier: Apache-2.0
// The native Pathrule Cloud's HTTP client: one authenticated session the caller supplies, no
// identity argument, no local storage and no routing change.

/**
 * The stable reasons Pathrule Cloud gives with a refusal (`{ error, code }`). A caller decides on the
 * code, never on the message, which is for a person and may change.
 */
export type CloudErrorCode =
  | "storage_quota_reached"
  | "index_budget_reached"
  | "node_limit_reached"
  | "workspace_limit_reached"
  | "seat_limit_reached"
  | "free_organization_limit_reached"
  | "payload_too_large"
  | "item_too_large"
  | "id_conflict"
  | "invalid_origin";

export class CloudHttpError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The refusal's code when the Cloud gave one; an older Cloud gives none. */
    public code?: string,
  ) {
    super(message);
  }
}

export interface CloudTransport {
  baseUrl: string;
  headers: () => Promise<Record<string, string>>;
  fetch?: typeof fetch;
}

/** The error a non-2xx answer becomes: its message and code when the body carries them. */
export function cloudHttpError(status: number, body: unknown): CloudHttpError {
  const value = (body ?? {}) as { error?: unknown; code?: unknown };
  return new CloudHttpError(
    status,
    typeof value.error === "string" ? value.error : "Cloud request failed",
    typeof value.code === "string" ? value.code : undefined,
  );
}

export function cloudHttp(config: CloudTransport) {
  return async <T>(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    operationId?: string,
  ): Promise<T> => {
    const response = await (config.fetch ?? fetch)(new URL(path, config.baseUrl), {
      method,
      headers: {
        ...(await config.headers()),
        "content-type": "application/json",
        ...(operationId ? { "idempotency-key": operationId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // A refusal from something in front of the Worker (a proxy's 413 page) is not JSON; it is still
    // the refusal, never a parse error.
    if (!response.ok)
      throw cloudHttpError(response.status, await response.json().catch(() => null));
    return (await response.json()) as T;
  };
}
