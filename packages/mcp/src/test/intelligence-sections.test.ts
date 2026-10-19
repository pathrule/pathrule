// SPDX-License-Identifier: Apache-2.0
// get_context's Intelligence section: the bound person's team and personal profiles (the account's
// ranking). One channel: what the hook delivers to this client is not delivered again here; what the
// caller already holds is not sent again; another person's hook entries are never subtracted.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentTargetId } from "@pathrule/core/skills/agent-targets.js";
import type { UserKnowledgeStore } from "@pathrule/core/user-knowledge/user-knowledge-persistence.js";
import {
  intelligenceItemVersion,
  type IntelligenceProfileDelivery,
} from "@pathrule/protocol/intelligence-delivery.js";

import {
  clearIntelligenceSectionMemory,
  hookIndexPersonEntries,
  intelligenceSections,
  type IntelligenceSectionsInput,
} from "../tools/intelligence-sections.js";

const WS = "ws-intel";

let home: string;

function profiles(exclude: readonly string[] = []): IntelligenceProfileDelivery {
  const entries = ["t-1", "t-2", "p-1"].filter((id) => !exclude.includes(id));
  const block = entries.length ? `## Team and personal profiles\n${entries.join("\n")}` : "";
  return {
    owner: "person-a",
    surface: "chat",
    block,
    version: block ? intelligenceItemVersion("chat", block) : "",
    ids: entries,
  };
}

/** An account that binds person-a (the call's own user) and ranks their profiles for the request. */
function account(userId = "person-a") {
  const intelligenceProfiles = vi.fn(async (options: { exclude?: readonly string[] }) =>
    profiles(options.exclude),
  );
  const person = {
    bind: vi.fn(async () => ({
      userId,
      userKnowledge: {} as UserKnowledgeStore,
      intelligenceProfiles,
    })),
  };
  return { person, intelligenceProfiles };
}

function input(over: Partial<IntelligenceSectionsInput> = {}): IntelligenceSectionsInput {
  return {
    ctx: { backend: null, userId: "person-a", workspaceId: WS, clientId: "cursor" } as never,
    workspaceId: WS,
    localRootPath: "/repo",
    cwd: "/repo/packages/app",
    path: "/packages/app",
    userIntent: "fix the login bug",
    env: { PATHRULE_HOME: home },
    installedHooks: async () => [],
    ...over,
  };
}

/** The hook index the account stamped for `owner`. */
function hookIndex(owner: string, ids: string[]): void {
  mkdirSync(join(home, "cache", WS), { recursive: true });
  writeFileSync(
    join(home, "cache", WS, "hook-index.json"),
    JSON.stringify({
      workspace_id: WS,
      intelligence_profiles: { owner, version: "intelligence:x", block: "B", ids },
    }),
  );
}

const hooks =
  (...ids: AgentTargetId[]) =>
  async () =>
    ids;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pathrule-intel-sections-"));
});

afterEach(() => {
  clearIntelligenceSectionMemory();
  rmSync(home, { recursive: true, force: true });
});

describe("get_context Intelligence sections", () => {
  it("delivers no guidance and nothing else with no account, on every client", async () => {
    expect(await intelligenceSections(input())).toEqual({});
    for (const clientId of ["claude-code", "codex", "cursor"] as const) {
      const out = await intelligenceSections(
        input({ ctx: { userId: "person-a", clientId } as never, installedHooks: hooks(clientId) }),
      );
      expect(out, clientId).toEqual({});
    }
  });

  it("adds the account's profiles, ranked for this request on the chat surface", async () => {
    const { person, intelligenceProfiles } = account();
    const out = await intelligenceSections(input({ person }));
    expect(out.intelligence_profiles).toBe(profiles().block);
    expect(out.item_versions).toEqual([profiles().version]);
    expect(intelligenceProfiles).toHaveBeenCalledWith({
      userIntent: "fix the login bug",
      surface: "chat",
      exclude: [],
    });
  });

  it("sends nothing the caller already holds, or sent earlier in the same session", async () => {
    const { person } = account();
    const versions = [profiles().version];
    expect(await intelligenceSections(input({ person, knownItemVersions: versions }))).toEqual({});

    const first = await intelligenceSections(input({ person, sessionId: "s1" }));
    expect(first.item_versions).toEqual(versions);
    expect(await intelligenceSections(input({ person, sessionId: "s1" }))).toEqual({});
    // Another session, or no session id, is told again.
    expect((await intelligenceSections(input({ person, sessionId: "s2" }))).item_versions).toEqual(
      versions,
    );
    expect((await intelligenceSections(input({ person }))).item_versions).toEqual(versions);
  });

  it("leaves out exactly the profile entries the hook carries for this person", async () => {
    hookIndex("person-a", ["t-1", "t-2"]);
    const { person, intelligenceProfiles } = account();
    const out = await intelligenceSections(input({ person, installedHooks: hooks("cursor") }));
    expect(intelligenceProfiles).toHaveBeenCalledWith(
      expect.objectContaining({ exclude: ["t-1", "t-2"] }),
    );
    expect(out.intelligence_profiles).toBe(profiles(["t-1", "t-2"]).block);

    // Everything ranked here is already in the session: no section at all.
    hookIndex("person-a", ["t-1", "t-2", "p-1"]);
    const none = await intelligenceSections(
      input({ person: account().person, installedHooks: hooks("cursor") }),
    );
    expect(none).not.toHaveProperty("intelligence_profiles");
  });

  it("never subtracts another person's hook entries, nor entries for a client the hook does not serve", async () => {
    hookIndex("person-b", ["t-1", "t-2", "p-1"]);
    const other = account();
    await intelligenceSections(input({ person: other.person, installedHooks: hooks("cursor") }));
    expect(other.intelligenceProfiles).toHaveBeenCalledWith(
      expect.objectContaining({ exclude: [] }),
    );

    hookIndex("person-a", ["t-1"]);
    const windsurf = account();
    await intelligenceSections(
      input({
        person: windsurf.person,
        ctx: { userId: "person-a", clientId: "windsurf" } as never,
        installedHooks: hooks("windsurf" as AgentTargetId),
      }),
    );
    expect(windsurf.intelligenceProfiles).toHaveBeenCalledWith(
      expect.objectContaining({ exclude: [] }),
    );
  });

  it("compiles the person's entries with the open compiler, stamped with nobody when unbound", async () => {
    const entries = await hookIndexPersonEntries({
      ctx: input().ctx,
      person: null,
      workspaceId: WS,
      localRootPath: "/repo",
    });
    expect(entries.personal).toMatchObject({ personalOwner: null });
  });

  it("goes without a section when the provider fails, never without the response", async () => {
    const failing = {
      bind: async () => ({
        userId: "person-a",
        userKnowledge: {} as UserKnowledgeStore,
        intelligenceProfiles: async () => {
          throw new Error("provider down");
        },
      }),
    };
    expect(await intelligenceSections(input({ person: failing }))).toEqual({});
  });

  it("reads the bound person: their profiles, their id for the hook's entries", async () => {
    const store = {} as UserKnowledgeStore;
    hookIndex("native-a", ["t-1"]);
    const bound = vi.fn(async (options: { exclude?: readonly string[] }) => ({
      ...profiles(options.exclude),
      owner: "native-a",
    }));
    const person = {
      bind: vi.fn(async () => ({
        userId: "native-a",
        userKnowledge: store,
        intelligenceProfiles: bound,
      })),
    };
    const out = await intelligenceSections(
      input({ person, installedHooks: hooks("cursor" as AgentTargetId) }),
    );
    expect(person.bind).toHaveBeenCalledWith(WS);
    expect(bound).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "chat", exclude: ["t-1"] }),
    );
    expect(out.intelligence_profiles).toContain("t-2");
    expect(out.intelligence_profiles).not.toContain("t-1");
    expect(out).not.toHaveProperty("user_guidance");
    const entries = await hookIndexPersonEntries({
      ctx: input().ctx,
      person,
      workspaceId: WS,
      localRootPath: "/repo",
    });
    expect(entries.personal).toMatchObject({ personalOwner: "native-a" });
  });

  it("serves local mode: a bound person needs no account", async () => {
    const person = {
      bind: async () => ({
        userId: "native-a",
        userKnowledge: {} as UserKnowledgeStore,
        intelligenceProfiles: async () => ({ ...profiles(), owner: "native-a" }),
      }),
    };
    const out = await intelligenceSections(input({ person }));
    expect(out.intelligence_profiles).toContain("t-1");
  });

  it("delivers no profiles when nobody is bound", async () => {
    hookIndex("person-a", ["t-2"]);
    for (const bind of [
      async () => null,
      async () => {
        throw new Error("provider down");
      },
    ]) {
      clearIntelligenceSectionMemory();
      const out = await intelligenceSections(
        input({ person: { bind }, installedHooks: hooks("cursor" as AgentTargetId) }),
      );
      expect(out).not.toHaveProperty("intelligence_profiles");
      expect(out).not.toHaveProperty("user_guidance");
    }
  });
});
