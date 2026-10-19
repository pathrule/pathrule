// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { hrefFor, parseRoute, setRouteBase, type Route } from "../src/router.js";

const knowledge: Route = {
  name: "knowledge",
  workspaceId: "ws 1",
  kind: "rule",
  archived: false,
  open: "r1",
};

describe("route base", () => {
  afterEach(() => setRouteBase(""));

  it("keeps the Local Console's paths when no base is set", () => {
    expect(hrefFor({ name: "overview" })).toBe("/");
    expect(hrefFor(knowledge)).toBe("/w/ws%201/knowledge?kind=rule&open=r1");
    expect(parseRoute("/w/ws%201/knowledge", "?kind=rule&open=r1")).toEqual(knowledge);
  });

  it("mounts every route under a base and reads it back", () => {
    setRouteBase("/console/");
    expect(hrefFor({ name: "overview" })).toBe("/console");
    expect(hrefFor(knowledge)).toBe("/console/w/ws%201/knowledge?kind=rule&open=r1");
    expect(hrefFor({ name: "activity", workspaceId: "w" })).toBe("/console/w/w/activity");
    expect(parseRoute("/console/w/ws%201/knowledge", "?kind=rule&open=r1")).toEqual(knowledge);
    // The Search page became ⌘K search: its old address opens the workspace's knowledge.
    expect(parseRoute("/console/w/w/search", "?q=cache")).toEqual({
      name: "knowledge",
      workspaceId: "w",
      kind: "memory",
      archived: false,
      open: null,
    });
  });

  it("does not strip a base that is only a prefix of a segment", () => {
    setRouteBase("/console");
    expect(parseRoute("/consoles/w/x/activity", "")).toEqual({ name: "not-found" });
  });
});
