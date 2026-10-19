// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { parseNavigationLines, summarizeNavigationRoi } from "./navigation-roi.js";

const JSONL = [
  '{"ts":"t1","t":"emitted","session_id":"a","paths":["/lib/x.js"]}',
  '{"ts":"t2","t":"followed","session_id":"a","path":"/lib/x.js"}',
  '{"ts":"t3","t":"emitted","session_id":"b","paths":["/lib/y.js"]}',
  "not-json-garbage",
  '{"ts":"t4","t":"session","session_id":"a","file_tool_count":6,"routed":true,"followed":true,"prompts":2,"duration_s":60}',
  '{"ts":"t5","t":"session","session_id":"b","file_tool_count":8,"routed":true,"followed":false,"prompts":1,"duration_s":70}',
  '{"ts":"t6","t":"session","session_id":"c","file_tool_count":36,"routed":false,"followed":false,"prompts":2,"duration_s":160}',
].join("\n");

describe("navigation ROI aggregator", () => {
  it("parses jsonl defensively (skips garbage)", () => {
    const events = parseNavigationLines(JSONL);
    expect(events).toHaveLength(6);
  });

  it("computes accuracy and routed-vs-unrouted deltas from real session data", () => {
    const s = summarizeNavigationRoi(parseNavigationLines(JSONL));
    expect(s.routes_emitted).toBe(2);
    expect(s.routes_followed).toBe(1);
    expect(s.route_accuracy).toBe(0.5);
    expect(s.sessions_total).toBe(3);
    expect(s.sessions_routed).toBe(2);
    expect(s.sessions_unrouted).toBe(1);
    expect(s.avg_tools_routed).toBe(7); // (6+8)/2
    expect(s.avg_tools_unrouted).toBe(36);
    expect(s.tool_reduction).toBeCloseTo((36 - 7) / 36, 5); // ~0.806
    expect(s.duration_reduction).toBeCloseTo((160 - 65) / 160, 5); // ~0.594
  });

  it("yields nulls (not NaN) until both cohorts exist", () => {
    const s = summarizeNavigationRoi(
      parseNavigationLines('{"t":"session","session_id":"a","file_tool_count":5,"routed":true,"duration_s":30}'),
    );
    expect(s.avg_tools_unrouted).toBeNull();
    expect(s.tool_reduction).toBeNull();
    expect(s.duration_reduction).toBeNull();
  });
});
