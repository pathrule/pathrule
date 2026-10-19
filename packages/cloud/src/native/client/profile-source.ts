// SPDX-License-Identifier: Apache-2.0
// The person's team and personal profiles from the native Cloud (`/intelligence-context`).
// Provider selection only: the existing host, MCP and hook renderer owns delivery and versions.
import type {
  IntelligenceProfileEntry,
  IntelligenceProfilePayload,
  IntelligenceProfileSource,
} from "../../intelligence/profile-context.js";
import { cloudHttp, type CloudTransport } from "./http.js";

export function createCloudIntelligenceProfileSource(
  config: CloudTransport,
): IntelligenceProfileSource {
  const request = cloudHttp(config);
  return {
    async profileContext(input) {
      try {
        const payload = await request<IntelligenceProfilePayload>(
          "/v1/workspaces/" +
            encodeURIComponent(input.workspaceId) +
            "/intelligence-context?" +
            new URLSearchParams({ surface: input.surface, intent: input.userIntent }),
        );
        const entry = (e: IntelligenceProfileEntry): IntelligenceProfileEntry => ({
          id: e.id,
          category: e.category,
          statement: e.statement,
          priority: e.priority,
          relevance_score: e.relevance_score,
        });
        return {
          enabled: payload.enabled,
          team_profile: payload.team_profile?.map(entry) ?? [],
          personal_profile: payload.personal_profile?.map(entry) ?? [],
        };
      } catch {
        return null;
      }
    },
  };
}
