// SPDX-License-Identifier: Apache-2.0
// The backend contract's recent-activity cases: what a logged activity reads back as, and the
// window a reader may ask for. Registered inside the contract's "activity + refresh queue" block.
import { expect, it } from "vitest";
import type { LocalKnowledgeBackend } from "./knowledge-backend.js";

export function recentActivityContract(makeBackend: () => LocalKnowledgeBackend, WS: string): void {
  it("logs and reads recent activity", async () => {
    const b = makeBackend();
    await b.logActivity({
      workspaceId: WS,
      domain: "docs",
      action: "create",
      scope: "project",
      taskSummary: "did x",
    });
    const recent = await b.recentActivities({ workspaceId: WS, relativePath: "/" }, 5);
    expect(recent[0]?.taskSummary).toBe("did x");
  });

  it("logs and reads recent activity with its scope, subjects, files and client, from `since` on", async () => {
    const b = makeBackend();
    await b.logActivity({
      workspaceId: WS,
      nodePath: "/api",
      domain: "backend",
      action: "update",
      scope: "service",
      subjects: ["Auth", "auth", "Tokens"],
      taskSummary: "rich activity",
      filesTouched: { total: 2, by_area: { api: ["src/a.ts", "src/b.ts"] } },
      aiClient: "codex",
    });
    const scope = { workspaceId: WS, relativePath: "/" };
    const [row] = await b.recentActivities(scope, 5);
    expect(row).toMatchObject({
      taskSummary: "rich activity",
      scope: "service",
      subjects: ["auth", "tokens"],
      filesTouched: { by_area: { api: ["src/a.ts", "src/b.ts"] } },
      aiClient: "codex",
    });
    const since = (at: string) => b.recentActivities(scope, 5, { since: at });
    expect((await since("2000-01-01T00:00:00.000Z")).map((a) => a.id)).toEqual([row!.id]);
    // Inclusive: an entry logged at `since` is in.
    expect((await since(row!.createdAt)).map((a) => a.id)).toEqual([row!.id]);
    expect(await since("2999-01-01T00:00:00.000Z")).toEqual([]);
  });
}
