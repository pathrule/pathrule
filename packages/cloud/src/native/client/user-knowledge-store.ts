// SPDX-License-Identifier: Apache-2.0
// The person's belief store on the native Cloud (`/v1/me/knowledge-store`).
import {
  requireStampedUserKnowledge,
  type UserKnowledgeStore,
} from "@pathrule/core/user-knowledge/user-knowledge-persistence.js";

import { cloudHttp, type CloudTransport } from "./http.js";

export function createCloudUserKnowledgeStore(config: CloudTransport): UserKnowledgeStore {
  const request = cloudHttp(config),
    root = "/v1/me/knowledge-store";
  const page = (o?: { cursor?: string | null; limit?: number }) =>
    "?" +
    new URLSearchParams({
      ...(o?.cursor ? { cursor: o.cursor } : {}),
      ...(o?.limit !== undefined ? { limit: String(o.limit) } : {}),
    });
  return {
    list: (o) => request(root + page(o)),
    get: (id) => request(root + "/" + encodeURIComponent(id)),
    put: async (atom, options) => {
      requireStampedUserKnowledge(atom);
      return request(root, { atom, options });
    },
    retire: (id, options) => request(root + "/" + encodeURIComponent(id) + "/retire", { options }),
    history: (id, o) => request(root + "/" + encodeURIComponent(id) + "/history" + page(o)),
  };
}
