// SPDX-License-Identifier: Apache-2.0
// Which targets a sync enables for the agents it serves. The default set (a caller that names no
// agents) must keep enabling exactly what it did while it was Studio's engine list: Claude Code and
// the AGENTS.md readers through the codex target.
import { describe, expect, it } from "vitest";

import {
  STUDIO_ENGINE_IDS,
  requiredTargetsForEngines,
  resolveEnabledClients,
} from "./disk-detection.js";

describe("agent targets", () => {
  it("the default agents enable Claude Code and the codex target, as before", () => {
    expect(requiredTargetsForEngines(STUDIO_ENGINE_IDS).sort()).toEqual(["claude-code", "codex"]);
    expect(
      resolveEnabledClients({
        selected: null,
        detected: [],
        fallback: ["claude-code"],
        activeEngines: STUDIO_ENGINE_IDS,
      }).sort(),
    ).toEqual(["claude-code", "codex"]);
  });

  it("an integration that names one agent enables that agent's target only", () => {
    expect(
      resolveEnabledClients({
        selected: null,
        detected: [],
        fallback: [],
        activeEngines: ["codex"],
      }),
    ).toEqual(["codex"]);
    expect(
      resolveEnabledClients({
        selected: null,
        detected: [],
        fallback: [],
        activeEngines: ["claude-code"],
      }),
    ).toEqual(["claude-code"]);
  });

  it("OpenCode reads AGENTS.md through the codex target; an unknown id adds nothing", () => {
    expect(requiredTargetsForEngines(["opencode"])).toEqual(["codex"]);
    expect(requiredTargetsForEngines(["grok", "orchestrator"])).toEqual([]);
  });
});
