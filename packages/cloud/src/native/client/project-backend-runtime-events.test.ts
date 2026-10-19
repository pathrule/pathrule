// SPDX-License-Identifier: Apache-2.0
// Runtime events on a Cloud workspace's Project backend: `pathrule_runtime_events`, its resolve
// tool and `pathrule instrument events` read the workspace's Signals routes, so an agent sees the
// Cloud's groups. Until 2026-10-18 the backend had no runtime event reads and every Cloud read
// answered that this edition reads none.
import { describe, expect, it } from "vitest";

import { createCloudProjectHttpBackend } from "./project-backend.js";

const WS = "ws-cloud-1";

const GROUP = {
  id: "grp_1",
  workspace_id: WS,
  environment: "production",
  kind: "error",
  dedup_fingerprint: "fp-1",
  status: "active",
  node_id: null,
  declared_node_path: "/apps/web/checkout",
  mapping_status: "declared",
  mapped_path: null,
  label: "TypeError",
  flow_key: "checkout",
  release: "2.4.0",
  message: "Cannot read properties of undefined",
  metadata: null,
  occurrence_count: 3,
  release_occurrence_count: 3,
  first_seen: "2026-10-18T10:00:00.000Z",
  last_seen: "2026-10-18T11:00:00.000Z",
  compacted_at: null,
  revision: 2,
  verification: { state: "unobserved" },
  correction: null,
};

type Reply = { status: number; body: unknown };

/** A Cloud that answers `capabilities` and then whatever `route` says for each request. */
function cloud(route: (url: URL, init: RequestInit) => Reply) {
  const seen: URL[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push(url);
    const reply = url.pathname.endsWith("/foundation/project/capabilities")
      ? { status: 200, body: { semantic: true } }
      : route(url, init ?? {});
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return {
    seen,
    backend: createCloudProjectHttpBackend(
      { baseUrl: "https://cloud.example", headers: async () => ({}), fetch },
      WS,
    ),
  };
}

describe("Cloud Project backend: runtime events", () => {
  it("reads the workspace's groups from its Signals route, filters and cursor included", async () => {
    const { seen, backend } = cloud(() => ({
      status: 200,
      body: { items: [GROUP], nextCursor: "next-1" },
    }));
    const page = await (
      await backend
    ).listRuntimeEventGroups!(WS, {
      path: "/apps/web",
      kind: "error",
      verification: "unobserved",
      limit: 10,
      cursor: "cur-0",
    });
    const read = seen.find((u) => u.pathname.endsWith("/signals/groups"))!;
    expect(read.pathname).toBe(`/v1/workspaces/${WS}/signals/groups`);
    expect(Object.fromEntries(read.searchParams)).toEqual({
      path: "/apps/web",
      kind: "error",
      verification: "unobserved",
      limit: "10",
      before: "cur-0",
    });
    expect(page).toMatchObject({ source: "cloud", nextCursor: "next-1" });
    if ("error" in page) throw new Error(page.error);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: "grp_1",
      kind: "error",
      nodePath: "/apps/web/checkout",
      flow: "checkout",
      release: "2.4.0",
    });
  });

  it("answers a refused query as the caller's error and an unknown group as none", async () => {
    const refused = cloud(() => ({ status: 400, body: { error: "Invalid Signals cursor" } }));
    expect(await (await refused.backend).listRuntimeEventGroups!(WS, { cursor: "x" })).toEqual({
      error: "Invalid Signals cursor",
    });
    const unknown = cloud(() => ({ status: 404, body: { error: "Signal group not found" } }));
    expect(
      await (
        await unknown.backend
      ).listRuntimeEventGroups!(WS, { groupId: "grp_missing" }),
    ).toEqual({ source: "cloud", items: [], nextCursor: null, history: [] });
    const denied = cloud(() => ({ status: 403, body: { error: "Workspace not authorized" } }));
    await expect((await denied.backend).listRuntimeEventGroups!(WS, {})).rejects.toThrow(
      "Workspace not authorized",
    );
  });

  it("reports release coverage from the status route, and none when it cannot be read", async () => {
    const { backend } = cloud(() => ({
      status: 200,
      body: {
        connected: true,
        lastSeen: "2026-10-18T11:00:00.000Z",
        activeCount: 1,
        declaredCount: 0,
        groupCount: 1,
        releases: [
          {
            environment: "production",
            release: "2.4.0",
            envelopes: 7,
            firstSeen: "2026-10-18T10:00:00.000Z",
            lastSeen: "2026-10-18T11:00:00.000Z",
          },
        ],
      },
    }));
    expect(await (await backend).runtimeEventStatus!(WS)).toEqual({
      source: "cloud",
      connected: true,
      lastSeen: "2026-10-18T11:00:00.000Z",
      activeCount: 1,
      declaredCount: 0,
      groupCount: 1,
      releases: [
        {
          environment: "production",
          release: "2.4.0",
          envelopes: 7,
          firstSeen: "2026-10-18T10:00:00.000Z",
          lastSeen: "2026-10-18T11:00:00.000Z",
        },
      ],
    });
    const down = cloud(() => ({ status: 503, body: { error: "unavailable" } }));
    expect((await (await down.backend).runtimeEventStatus!(WS)).releases).toEqual([]);
  });

  it("records a correction against the group's revision on the Cloud", async () => {
    const { seen, backend } = cloud(() => ({
      status: 201,
      body: { status: "recorded", group: { ...GROUP, revision: 3 } },
    }));
    const result = await (
      await backend
    ).recordRuntimeCorrection!(WS, {
      groupId: "grp_1",
      expectedRevision: 2,
      idempotencyKey: "attempt-1",
    });
    expect(seen.at(-1)!.pathname).toBe(`/v1/workspaces/${WS}/signals/groups/grp_1/corrections`);
    expect(result).toMatchObject({ status: "recorded", group: { id: "grp_1", revision: 3 } });
  });
});
