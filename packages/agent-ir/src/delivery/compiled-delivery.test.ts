// SPDX-License-Identifier: Apache-2.0
/**
 * The completeness gate's production call site: per source memory, deliver the compiled form or the
 * memory as written. These pin the decision (both directions), what the gate reads, and that a cleared
 * memory's lines travel as one group through the advisory channel.
 */
import { describe, it, expect } from "vitest";
import { planCompiledDelivery, compiledMemoryText, type SourcedAdvisoryLine } from "./compiled-delivery.js";
import { entryKnowledgeText, renderSelectionLine, selectAdvisoriesForPath, type SelectionAdvisory } from "./agent-ir.js";

const TRAY = "The tray icon renders blank after a theme change; re-register the template image on nativeTheme.updated.";
const MONEY = "For currency, use formatMoney. It takes precedence over Intl.NumberFormat. Do not use Intl.NumberFormat.";

function line(ref: string, knowledge: string, sourceMemoryId: string | null): SourcedAdvisoryLine {
  return { ref, line: `- ${knowledge.replace(/\n/g, " / ")}. [observed to work]`, knowledge, sourceMemoryId };
}

describe("planCompiledDelivery", () => {
  it("clears a memory whose lines carry its knowledge, and replaces its body with them", () => {
    const l = line("r1", "the tray icon renders blank after a theme change\nre-register the template image on nativeTheme.updated", "m-tray");
    const plan = planCompiledDelivery([l], [{ id: "m-tray", content: TRAY }]);
    const c = plan.compiled.get("m-tray");
    expect(c).toBeDefined();
    expect(c!.refs).toEqual(["r1"]);
    expect(c!.text).toBe(compiledMemoryText("m-tray", [l.line]));
    expect(c!.text).toContain('pathrule_read_memory("m-tray")');
    expect(plan.withheldRefs.size).toBe(0);
    expect(plan.decisions).toEqual([{ memoryId: "m-tray", mode: "ir", reason: "sufficient", refs: ["r1"] }]);
  });

  it("sends a memory back to its source text and withholds its lines when the projection lost the loser", () => {
    const plan = planCompiledDelivery([line("s1", "currency\nformatMoney", "m-money")], [{ id: "m-money", content: MONEY }]);
    expect(plan.compiled.size).toBe(0);
    expect([...plan.withheldRefs]).toEqual(["s1"]);
    expect(plan.decisions[0]).toMatchObject({ memoryId: "m-money", mode: "prose" });
    expect(plan.decisions[0]!.reason).toMatch(/^gate:relationship_loser_missing:intl/);
  });

  it("judges a memory's lines TOGETHER: two atoms can clear what neither clears alone", () => {
    const src = "The tray icon renders blank after a theme change. Re-register the template image on nativeTheme.updated, never on app ready.";
    const one = planCompiledDelivery([line("a", "the tray icon renders blank after a theme change", "m")], [{ id: "m", content: src }]);
    expect(one.compiled.size).toBe(0);
    const both = planCompiledDelivery(
      [
        line("a", "the tray icon renders blank after a theme change", "m"),
        line("b", "re-register the template image on nativeTheme.updated, never on app ready", "m"),
      ],
      [{ id: "m", content: src }],
    );
    expect(both.compiled.get("m")?.refs).toEqual(["a", "b"]);
  });

  it("leaves a line with no source memory alone: nothing to replace, nothing to fall back to", () => {
    const plan = planCompiledDelivery(
      [line("rule-atom", "anything", null), line("orphan", "anything", "m-archived")],
      [{ id: "m-other", content: TRAY }],
    );
    expect(plan.compiled.size).toBe(0);
    expect(plan.withheldRefs.size).toBe(0);
    expect(plan.decisions).toEqual([]);
  });

  it("counts a repeated ref once", () => {
    const l = line("r1", "the tray icon renders blank after a theme change\nre-register the template image on nativeTheme.updated", "m-tray");
    const plan = planCompiledDelivery([l, l], [{ id: "m-tray", content: TRAY }]);
    expect(plan.compiled.get("m-tray")?.refs).toEqual(["r1"]);
  });
});

describe("entryKnowledgeText", () => {
  it("is the knowledge a line carries, never the fixed wording around it", () => {
    const sel: SelectionAdvisory = {
      type: "selection", authority: "advisory", context: "server-side API calls", context_grounded: true,
      preferred: "ServerClient", alternatives: ["GenericClient"], scope: null, ref: "x",
    };
    const knowledge = entryKnowledgeText(sel);
    expect(knowledge).toBe("server-side API calls\nServerClient\nGenericClient");
    expect(renderSelectionLine(sel)).toContain("the preferred choice is");
    expect(knowledge).not.toContain("preferred");
  });
});

describe("selectAdvisoriesForPath with compiled groups", () => {
  const index = {
    path_advisories: {
      "/apps/web": [
        { ref: "g1", line: "- a", group: "m1" },
        { ref: "g2", line: "- b", group: "m1" },
        { ref: "g3", line: "- c", group: "m1" },
        { ref: "solo", line: "- d" },
      ],
    },
  };

  it("delivers a group whole when it fits", () => {
    expect(selectAdvisoriesForPath(index, "/apps/web/x.ts").map((s) => s.ref)).toEqual(["g1", "g2", "g3", "solo"]);
  });

  it("skips a group that does not fit instead of cutting it, and spends the budget on the next stub", () => {
    expect(selectAdvisoriesForPath(index, "/apps/web/x.ts", 2).map((s) => s.ref)).toEqual(["solo"]);
  });

  it("drops what the session already got BEFORE budgeting, so delivered stubs hold no slots", () => {
    const skip = new Set(["g1", "g2", "g3"]);
    expect(selectAdvisoriesForPath(index, "/apps/web/x.ts", 1, skip).map((s) => s.ref)).toEqual(["solo"]);
  });
});
