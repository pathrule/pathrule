// SPDX-License-Identifier: Apache-2.0
// A workspace's Signals reads and ingest keys on the native Cloud. Matches the CLI and MCP key DTOs;
// consent stays with the existing caller, and nothing here instruments an SDK.
import {
  runtimeEventGroupFromCloud,
  type CloudSignalGroupRow,
  type RuntimeCorrectionInput,
  type RuntimeCorrectionResult,
  type RuntimeVerificationState,
} from "@pathrule/protocol/runtime-events.js";
import { cloudHttp, CloudHttpError, cloudHttpError, type CloudTransport } from "./http.js";

export interface IngestKeySummary {
  id: string;
  /** The key's first 12 characters (`prs_` and 8 hex), the only part anyone sees again. */
  prefix: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export type MintIngestKeyResult =
  | { ok: true; key: string; prefix: string }
  | { ok: false; reason: "workspace_limit" | "unauthorized" | "error"; message: string };

export interface SignalsReadQuery {
  path?: string;
  environment?: string;
  status?: "active" | "declared" | "resolved" | "archived";
  kind?: "error" | "event";
  verification?: RuntimeVerificationState;
  /** One group, with its audit history (newest first, at most 50). */
  groupId?: string;
  limit?: number;
  before?: string;
}

const REFUSALS = new Set(["not_found", "revision_conflict", "declared", "invalid"]);
type Refusal = Extract<RuntimeCorrectionResult, { status: "refused" }>["reason"];

/** `Status` and `Groups` are the Worker's read shapes (the Cloud service's Signals reads). */
export function createCloudSignalsClient<Status = unknown, Groups = unknown>(
  config: CloudTransport,
) {
  const request = cloudHttp(config),
    root = (ws: string) => "/v1/workspaces/" + encodeURIComponent(ws) + "/signals/keys";
  const summary = (k: IngestKeySummary): IngestKeySummary => ({
    id: k.id,
    prefix: k.prefix,
    label: k.label,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
    revokedAt: k.revokedAt,
  });
  const readQuery = (q: SignalsReadQuery) => {
    const values = new URLSearchParams();
    for (const [key, value] of Object.entries(q))
      if (value !== undefined) values.set(key, String(value));
    return values.size ? "?" + values.toString() : "";
  };
  return {
    readRuntimeStatus: (
      ws: string,
      q: Pick<SignalsReadQuery, "path" | "environment" | "limit"> = {},
    ) =>
      request<Status>(
        "/v1/workspaces/" + encodeURIComponent(ws) + "/signals/status" + readQuery(q),
      ),
    readSignalGroups: (ws: string, q: SignalsReadQuery = {}) =>
      request<Groups>(
        "/v1/workspaces/" + encodeURIComponent(ws) + "/signals/groups" + readQuery(q),
      ),
    async mintIngestKey(workspaceId: string, label?: string | null): Promise<MintIngestKeyResult> {
      try {
        const r = await request<{ key: string; prefix: string }>(root(workspaceId), {
          label: label ?? null,
        });
        if (!/^prs_[a-f0-9]{48}$/.test(r.key))
          return { ok: false, reason: "error", message: "unexpected key format" };
        return { ok: true, key: r.key, prefix: r.prefix };
      } catch (e) {
        const message = e instanceof Error ? e.message : "Cloud request failed";
        return {
          ok: false,
          reason:
            e instanceof CloudHttpError && (e.status === 401 || e.status === 403)
              ? "unauthorized"
              : message.includes("signals_workspace_limit")
                ? "workspace_limit"
                : "error",
          message,
        };
      }
    },
    async listIngestKeys(ws: string): Promise<IngestKeySummary[]> {
      const all: IngestKeySummary[] = [];
      let next: string | null = null;
      do {
        const r: { items: IngestKeySummary[]; nextCursor: string | null } = await request(
          root(ws) + (next ? "?before=" + encodeURIComponent(next) : ""),
        );
        all.push(...r.items.map(summary));
        next = r.nextCursor;
      } while (next);
      return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    },
    /**
     * Records a correction attempt on a group (`POST .../signals/groups/:id/corrections`): the
     * Worker's answer as Local's `recordRuntimeCorrection` gives it, refusals included. Throws only
     * when the request itself failed (authentication, access, transport).
     */
    async recordRuntimeCorrection(
      ws: string,
      input: RuntimeCorrectionInput,
    ): Promise<RuntimeCorrectionResult> {
      const { groupId, ...body } = input;
      // Group ids are the Worker's own; anything else names no group the route could reach.
      if (typeof groupId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(groupId)) {
        const reason = /^[A-Za-z0-9_.:-]{1,128}$/.test(String(groupId)) ? "not_found" : "invalid";
        return { status: "refused", reason, group: null };
      }
      const response = await (config.fetch ?? fetch)(
        new URL(
          "/v1/workspaces/" +
            encodeURIComponent(ws) +
            "/signals/groups/" +
            encodeURIComponent(groupId) +
            "/corrections",
          config.baseUrl,
        ),
        {
          method: "POST",
          headers: {
            ...(await config.headers()),
            "content-type": "application/json",
            ...(typeof input.idempotencyKey === "string"
              ? { "idempotency-key": input.idempotencyKey }
              : {}),
          },
          body: JSON.stringify(body),
        },
      );
      const value = (await response.json().catch(() => null)) as {
        status?: string;
        reason?: string;
        group?: CloudSignalGroupRow | null;
        error?: string;
      } | null;
      const group = value?.group ? runtimeEventGroupFromCloud(value.group) : null;
      if ((value?.status === "recorded" || value?.status === "replayed") && group)
        return { status: value.status, group };
      if (value?.status === "refused" && REFUSALS.has(value.reason ?? ""))
        return { status: "refused", reason: value.reason as Refusal, group };
      throw cloudHttpError(response.status, value);
    },
    async revokeIngestKey(ws: string, id: string): Promise<IngestKeySummary> {
      const current = (await this.listIngestKeys(ws)).find((k) => k.id === id);
      if (!current || current.revokedAt)
        throw new Error(
          "The ingest key was not revoked: it is no longer active, or this account cannot change this workspace keys.",
        );
      const r = await request<IngestKeySummary>(
        root(ws) + "/" + encodeURIComponent(id),
        undefined,
        "DELETE",
      );
      return summary(r);
    },
  };
}
