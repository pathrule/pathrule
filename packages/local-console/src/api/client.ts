// SPDX-License-Identifier: Apache-2.0
// The Local Console's only data source: `pathrule ui` on the same origin. No other host,
// no account, no third party.
import type {
  LocalUiError,
  LocalUiRoute,
  LocalUiRouteMap,
} from "@pathrule/protocol/local-ui-api.js";

export type LocalErrorCode = LocalUiError["error"]["code"] | "network";

export class LocalApiError extends Error {
  constructor(
    readonly code: LocalErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "LocalApiError";
  }
}

const SESSION_KEY = "pr-local-session";

function readSession(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

function writeSession(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(SESSION_KEY, token);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // A blocked store only means the page has to be relaunched from the terminal.
  }
}

export interface LocalApi {
  call<R extends Exclude<LocalUiRoute, "session">>(
    route: R,
    body: LocalUiRouteMap[R]["request"],
    signal?: AbortSignal,
  ): Promise<LocalUiRouteMap[R]["response"]>;
}

let reachable = true;

/** Tells the shell when the loopback server stops or starts answering. */
function announceReachability(ok: boolean): void {
  if (ok === reachable) return;
  reachable = ok;
  window.dispatchEvent(new CustomEvent("pr-local-offline", { detail: !ok }));
}

async function post(
  route: LocalUiRoute,
  body: unknown,
  token: string | null,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`/api/${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
      signal,
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    announceReachability(false);
    throw new LocalApiError(
      "network",
      "Can't reach `pathrule ui`. Is it still running in your terminal?",
      0,
    );
  }
  announceReachability(true);
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const err = (parsed as LocalUiError | null)?.error;
    throw new LocalApiError(
      err?.code ?? "internal",
      err?.message ?? `Request failed (${response.status}).`,
      response.status,
    );
  }
  return parsed;
}

/**
 * Starts a session: exchanges the single-use launch token from the URL fragment, or
 * reuses this tab's session. Returns null when the page must be relaunched.
 */
export async function startSession(
  location: Location = window.location,
  history: History = window.history,
): Promise<string | null> {
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
  const launch = fragment.get("launch");
  if (launch) {
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    try {
      const result = (await post(
        "session",
        { launchToken: launch },
        null,
      )) as LocalUiRouteMap["session"]["response"];
      writeSession(result.sessionToken);
      return result.sessionToken;
    } catch {
      writeSession(null);
      return readSession();
    }
  }
  return readSession();
}

export function createLocalApi(token: string, onUnauthorized: () => void): LocalApi {
  return {
    async call(route, body, signal) {
      try {
        return (await post(route, body, token, signal)) as never;
      } catch (error) {
        if (error instanceof LocalApiError && error.code === "unauthorized") {
          writeSession(null);
          onUnauthorized();
        }
        throw error;
      }
    },
  };
}
