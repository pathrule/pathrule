// SPDX-License-Identifier: Apache-2.0
// What a Pathrule Cloud workspace's plan allows and what it uses (`GET /v1/workspaces/:ws/usage`,
// read access), so a client can say before it writes whether something fits. The Cloud still checks
// every write; this only tells a person in advance.

/** One measured resource: what is used, and the plan's limit (null when the plan has none). */
export interface CloudUsageMeter {
  used: number;
  limit: number | null;
}

export interface CloudWorkspaceUsage {
  workspaceId: string;
  organizationId: string;
  storage: { usedBytes: number; limitBytes: number | null };
  vectors: CloudUsageMeter;
  nodes: CloudUsageMeter;
  /** The largest item a write may carry, in bytes of its JSON. */
  itemMaxBytes: number;
  /** The longest title a write may carry, in characters. */
  titleMaxChars: number;
  /** The most index vectors one item may take: one per path it is placed at and per folder above. */
  maxVectorsPerItem: number;
}

type Request = <T>(path: string) => Promise<T>;

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

function meter(raw: unknown, used: string, limit: string): { used: number; limit: number | null } {
  const value = (raw ?? {}) as Record<string, unknown>;
  const u = count(value[used]);
  if (u === null || (value[limit] !== null && count(value[limit]) === null))
    throw new Error("Pathrule Cloud answered an unreadable usage report");
  return { used: u, limit: value[limit] === null ? null : count(value[limit]) };
}

/** The usage report of `workspaceId`; throws on a report it cannot read rather than guess. */
export async function readWorkspaceUsage(
  request: Request,
  workspaceId: string,
): Promise<CloudWorkspaceUsage> {
  const raw = await request<Record<string, unknown>>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/usage`,
  );
  const storage = meter(raw.storage, "used_bytes", "limit_bytes");
  const itemMaxBytes = count(raw.item_max_bytes);
  const titleMaxChars = count(raw.title_max_chars);
  const maxVectorsPerItem = count(raw.max_vectors_per_item);
  if (itemMaxBytes === null || titleMaxChars === null || maxVectorsPerItem === null)
    throw new Error("Pathrule Cloud answered an unreadable usage report");
  return {
    workspaceId: typeof raw.workspace_id === "string" ? raw.workspace_id : workspaceId,
    organizationId: typeof raw.organization_id === "string" ? raw.organization_id : "",
    storage: { usedBytes: storage.used, limitBytes: storage.limit },
    vectors: meter(raw.vectors, "used", "limit"),
    nodes: meter(raw.nodes, "used", "limit"),
    itemMaxBytes,
    titleMaxChars,
    maxVectorsPerItem,
  };
}

/** What is left under a meter's limit; null when the plan sets none. */
export function freeOf(used: number, limit: number | null): number | null {
  return limit === null ? null : Math.max(0, limit - used);
}
