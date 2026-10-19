// SPDX-License-Identifier: Apache-2.0
// The deterministic intent router lives in @pathrule/core so the host
// pre-fetch and this MCP server share one implementation. Re-exported here so
// existing imports from this module keep working.
export {
  classifyDeterministicRoute,
  deterministicDecision,
  type DeterministicRouteInput,
  type RecentActivityForRouting,
} from "@pathrule/core/retrieval/deterministic-routing.js";
