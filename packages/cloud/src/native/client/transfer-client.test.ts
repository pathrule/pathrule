// SPDX-License-Identifier: Apache-2.0
// What the copy of Local knowledge reads from the open client: a refusal's code, whatever answered
// it; a workspace's usage report, a missing limit included; and whether the workspace takes copies.
import { describe, expect, it } from "vitest";

import { cloudHttp, CloudHttpError } from "./http.js";
import { createCloudProjectHttpBackend, knowledgeTransferVersion } from "./project-backend.js";
import { readWorkspaceUsage } from "./usage.js";

const WS = "ws-cloud-1";

type Reply = { status: number; body: unknown; raw?: string };

function cloud(route: (url: URL) => Reply, capabilities: Record<string, unknown> = {}) {
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const reply = url.pathname.endsWith("/foundation/project/capabilities")
      ? { status: 200, body: { semantic: false, ...capabilities } }
      : route(url);
    return new Response(reply.raw ?? JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { baseUrl: "https://cloud.example", headers: async () => ({}), fetch };
}

describe("the open client for a copy of Local knowledge", () => {
  it("keeps a refusal's code on the error, from the transport and from a Project write", async () => {
    const transport = cloud(() => ({
      status: 402,
      body: { error: "Your organization's storage is full", code: "storage_quota_reached" },
    }));
    const refused = await cloudHttp(transport)("/v1/anything").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(CloudHttpError);
    expect(refused).toMatchObject({
      status: 402,
      code: "storage_quota_reached",
      message: "Your organization's storage is full",
    });

    const conflict = cloud(() => ({
      status: 409,
      body: { error: "That id belongs to another workspace", code: "id_conflict" },
    }));
    const backend = await createCloudProjectHttpBackend(conflict, WS);
    await expect(
      backend.writeMemory({
        workspaceId: WS,
        id: "lt_x",
        title: "t",
        content: "c",
        ifAbsent: true,
      }),
    ).rejects.toMatchObject({ status: 409, code: "id_conflict" });
  });

  it("answers a refusal that is not JSON as the refusal, with no code", async () => {
    const proxy = cloud(() => ({
      status: 413,
      body: null,
      raw: "<html>Request Entity Too Large</html>",
    }));
    await expect(cloudHttp(proxy)("/v1/anything", { big: true })).rejects.toMatchObject({
      status: 413,
      code: undefined,
      message: "Cloud request failed",
    });
  });

  it("reads the usage report, a plan with no limit included", async () => {
    const transport = cloud((url) =>
      url.pathname === `/v1/workspaces/${WS}/usage`
        ? {
            status: 200,
            body: {
              workspace_id: WS,
              organization_id: "org-1",
              storage: { used_bytes: 1200, limit_bytes: null },
              vectors: { used: 40, limit: 1000 },
              nodes: { used: 3, limit: 100 },
              item_max_bytes: 1048576,
              title_max_chars: 500,
              max_vectors_per_item: 160,
            },
          }
        : { status: 404, body: { error: "not found" } },
    );
    expect(await readWorkspaceUsage(cloudHttp(transport), WS)).toEqual({
      workspaceId: WS,
      organizationId: "org-1",
      storage: { usedBytes: 1200, limitBytes: null },
      vectors: { used: 40, limit: 1000 },
      nodes: { used: 3, limit: 100 },
      itemMaxBytes: 1048576,
      titleMaxChars: 500,
      maxVectorsPerItem: 160,
    });
    const broken = cloud(() => ({ status: 200, body: { storage: {} } }));
    await expect(readWorkspaceUsage(cloudHttp(broken), WS)).rejects.toThrow(/unreadable usage/);
  });

  it("reads whether the workspace takes copies of Local knowledge from its capabilities", async () => {
    const offered = await createCloudProjectHttpBackend(
      cloud(() => ({ status: 404, body: {} }), { knowledgeTransfer: 1 }),
      WS,
    );
    expect(knowledgeTransferVersion(offered)).toBe(1);
    const older = await createCloudProjectHttpBackend(
      cloud(() => ({ status: 404, body: {} })),
      WS,
    );
    expect(knowledgeTransferVersion(older)).toBe(0);
    const odd = await createCloudProjectHttpBackend(
      cloud(() => ({ status: 404, body: {} }), { knowledgeTransfer: "yes" }),
      WS,
    );
    expect(knowledgeTransferVersion(odd)).toBe(0);
  });
});
