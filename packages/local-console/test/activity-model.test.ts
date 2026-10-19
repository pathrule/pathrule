// SPDX-License-Identifier: Apache-2.0
import type { KnowledgeListItem, LocalActivityEntry } from "@pathrule/protocol/local-ui-api.js";
import { describe, expect, it } from "vitest";
import {
  agentsOf,
  entryFolder,
  foldersTouched,
  knowledgeIn,
  matchesEntry,
  perDay,
  sessionsByDay,
  workSessions,
} from "../src/activity/model.js";

function entry(
  id: string,
  at: string,
  extra: Partial<LocalActivityEntry> = {},
): LocalActivityEntry {
  return {
    id,
    nodePath: "/packages/ui",
    domain: "ui",
    action: "update",
    summary: `Entry ${id}`,
    createdAt: at,
    client: "claude-code",
    person: null,
    files: [],
    subjects: [],
    ...extra,
  };
}

function item(id: string, path: string, updatedAt = "2026-10-01T00:00:00.000Z"): KnowledgeListItem {
  return { id, kind: "memory", title: id, preview: "", path, updatedAt, versionNumber: 1 };
}

const NOW = Date.parse("2026-10-14T16:00:00.000Z");

describe("work sessions", () => {
  it("joins one person's and one agent's entries until a gap over 30 minutes", () => {
    const sessions = workSessions([
      entry("a", "2026-10-14T14:00:00.000Z", { files: ["packages/ui/a.ts"] }),
      entry("b", "2026-10-14T14:25:00.000Z", {
        files: ["packages/ui/a.ts", "packages/ui/b.ts"],
        subjects: ["tokens"],
      }),
      entry("c", "2026-10-14T15:20:00.000Z"),
      // Another agent at the same time is another session.
      entry("d", "2026-10-14T14:10:00.000Z", { client: "codex", domain: "test" }),
    ]);
    expect(sessions.map((s) => s.entries.map((e) => e.id))).toEqual([["c"], ["b", "a"], ["d"]]);
    const first = sessions[1]!;
    // The entry with the most files speaks for the session.
    expect(first.title).toBe("Entry b");
    expect(first.files).toEqual(["packages/ui/a.ts", "packages/ui/b.ts"]);
    expect(first.subjects).toEqual(["tokens"]);
    expect(first.domains).toEqual([{ domain: "ui", count: 2 }]);
    expect(sessionsByDay(sessions).map((d) => [d.day, d.sessions.length])).toEqual([
      ["2026-10-14", 3],
    ]);
  });

  it("splits by person on Cloud", () => {
    const ayse = { id: "u1", name: "Ayşe" };
    const sessions = workSessions([
      entry("a", "2026-10-14T14:00:00.000Z", { person: ayse }),
      entry("b", "2026-10-14T14:05:00.000Z", { person: { id: "u2", name: "Mert" } }),
    ]);
    expect(sessions.map((s) => s.personName)).toEqual(["Mert", "Ayşe"]);
  });
});

describe("where work landed", () => {
  it("is the node the agent named, else the folder its files share", () => {
    expect(entryFolder(entry("a", NOW.toString(), { nodePath: "/apps/api/src/" }))).toBe(
      "/apps/api/src",
    );
    expect(
      entryFolder(
        entry("b", "x", {
          nodePath: "/",
          files: ["packages/ui/src/a.ts", "packages/ui/src/b/c.ts"],
        }),
      ),
    ).toBe("/packages/ui/src");
    expect(entryFolder(entry("c", "x", { nodePath: null, files: ["a.ts"] }))).toBe("/");
  });

  it("says what agents knew there: none, older or current, from the folder and those above it", () => {
    const knowledge = [
      item("m1", "/packages"),
      item("m2", "/packages/ui", "2026-05-01T00:00:00.000Z"),
      item("root", "/"),
    ];
    expect(knowledgeIn("/packages/ui/src", knowledge, NOW)).toEqual({
      state: "older",
      items: 2,
      older: 1,
    });
    expect(knowledgeIn("/apps/api", knowledge, NOW)).toEqual({
      state: "none",
      items: 0,
      older: 0,
    });
    const rows = foldersTouched(
      workSessions([
        entry("a", "2026-10-14T10:00:00.000Z", { nodePath: "/apps/api" }),
        entry("b", "2026-10-14T12:00:00.000Z", { nodePath: "/apps/api" }),
        entry("c", "2026-10-14T12:00:00.000Z", { nodePath: "/packages", client: "codex" }),
      ]),
      knowledge,
      NOW,
    );
    expect(rows.map((r) => [r.folder, r.sessions, r.knowledge.state])).toEqual([
      ["/apps/api", 2, "none"],
      ["/packages", 1, "current"],
    ]);
  });
});

describe("agents and filters", () => {
  it("rates each agent by how often it names the files it touched", () => {
    expect(
      agentsOf([
        entry("a", "x", { files: ["a.ts"] }),
        entry("b", "x"),
        entry("c", "x", { client: "cursor" }),
      ]),
    ).toEqual([
      { client: "claude-code", entries: 2, withFiles: 0.5 },
      { client: "cursor", entries: 1, withFiles: 0 },
    ]);
  });

  it("finds by any word of the summary, folder, files or subjects, and narrows by kind, person and agent", () => {
    const e = entry("a", "x", {
      summary: "Delivery statistics",
      files: ["apps/api/src/deliveries.ts"],
      subjects: ["d1"],
    });
    const none = { query: "", domain: null, person: null, client: null };
    expect(matchesEntry(e, { ...none, query: "delivery d1" })).toBe(true);
    expect(matchesEntry(e, { ...none, query: "deliveries.ts" })).toBe(true);
    expect(matchesEntry(e, { ...none, query: "billing" })).toBe(false);
    expect(matchesEntry(e, { ...none, domain: "backend" })).toBe(false);
    expect(matchesEntry(e, { ...none, client: "claude-code", person: "local" })).toBe(true);
  });

  it("lays a window out day by day, oldest first", () => {
    expect(perDay(3, NOW, (day) => day).map((d) => d.value)).toEqual([
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
    ]);
  });
});

describe("the kind-of-work mix", () => {
  it("names the five largest kinds and sums the rest into Other", async () => {
    const { foldMix } = await import("../src/activity/ActivityParts.js");
    const parts = ["backend", "ui", "database", "test", "docs", "infra", "config", "other"].map(
      (domain, i) => ({
        domain,
        count: 80 - i * 10,
      }),
    );
    expect(foldMix(parts)).toEqual([
      { domain: "backend", count: 80 },
      { domain: "ui", count: 70 },
      { domain: "database", count: 60 },
      { domain: "test", count: 50 },
      { domain: "docs", count: 40 },
      { domain: "other", count: 30 + 20 + 10 },
    ]);
    // Six or fewer stay as they are.
    expect(foldMix(parts.slice(0, 6))).toHaveLength(6);
  });
});
