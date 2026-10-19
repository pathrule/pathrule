// SPDX-License-Identifier: Apache-2.0
// Per-session ETag cache for get_context protocol + workspace_overview.
//
// The MCP server is stateless across connections but holds short-lived
// per-connection state. When a client doesn't explicitly pass
// `known_protocol_version` / `known_overview_version`, we can still treat
// the call as warm if we remember what we told this same connection last
// time. Memory-only — resets on server restart.

export interface SessionEtags {
  lastProtocolVersion?: string;
  lastOverviewVersion?: string;
}

const store = new WeakMap<object, SessionEtags>();
const keyedStore = new Map<string, SessionEtags>();

export function readSessionEtags(session: object): SessionEtags {
  return store.get(session) ?? {};
}

export function updateSessionEtags(session: object, patch: SessionEtags, stableKey?: string): void {
  const current = store.get(session) ?? {};
  store.set(session, { ...current, ...patch });
  if (stableKey) {
    const keyed = keyedStore.get(stableKey) ?? {};
    keyedStore.set(stableKey, { ...keyed, ...patch });
  }
}

export function resolveKnownVersion(
  explicit: string | undefined,
  session: object,
  field: keyof SessionEtags,
  stableKey?: string,
): string | undefined {
  if (explicit !== undefined) return explicit;
  if (stableKey) return keyedStore.get(stableKey)?.[field];
  return store.get(session)?.[field];
}
