// SPDX-License-Identifier: Apache-2.0
// The native account binds the person of a mapped local workspace, under the one owner its provider
// authenticated, and nobody else: unmapped workspaces, a signed-out provider and a failing provider
// leave the local defaults; an account switch replaces the recorded owner and drops the previous
// owner's bindings; the project backend serves nothing unless the composition opts in.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryKnowledgeBackend } from "@pathrule/core";
import { readAccountOwners, recordAccountOwner } from "@pathrule/core/storage/account-owners.js";
import type { UserKnowledgeStore } from "@pathrule/core/user-knowledge/user-knowledge-persistence.js";

import type { IntelligenceProfileSource } from "../intelligence/profile-context.js";
import {
  createNativeAccount,
  NATIVE_BINDING_RETRY_MS,
  NATIVE_BINDING_TTL_MS,
  type NativeAccountBinding,
  type NativeAccountProvider,
  type NativeWorkspaceMapping,
} from "./account.js";

const LOCAL = "ws-local";
const CLOUD = "ws-cloud";
const MAPPING: NativeWorkspaceMapping = {
  localWorkspaceId: LOCAL,
  cloudWorkspaceId: CLOUD,
  localRootPath: "/repo",
};

let home: string;
let env: NodeJS.ProcessEnv;
let clock: number;

function source(owner: string): IntelligenceProfileSource & { workspaces: string[] } {
  const workspaces: string[] = [];
  return {
    workspaces,
    async profileContext(input) {
      workspaces.push(input.workspaceId);
      return {
        enabled: true,
        team_profile: [
          {
            id: `t-${owner}`,
            category: "team",
            statement: `Team rule of ${owner}`,
            priority: "high",
          },
        ],
        personal_profile: [],
      };
    },
  };
}

function bindingFor(
  owner: string,
  mapping: NativeWorkspaceMapping = MAPPING,
  extra: Partial<NativeAccountBinding> = {},
): NativeAccountBinding {
  return {
    userId: owner,
    workspaceId: mapping.cloudWorkspaceId,
    mapping,
    userKnowledgeStore: { owner } as unknown as UserKnowledgeStore,
    profileSource: source(owner),
    ...extra,
  };
}

function provider(
  answer: (mapping: NativeWorkspaceMapping) => Promise<NativeAccountBinding | null>,
): NativeAccountProvider & { resolveBinding: ReturnType<typeof vi.fn> } {
  return { resolveBinding: vi.fn(answer) };
}

const resolvedLocal = { backend: new InMemoryKnowledgeBackend(), kind: "local" as const };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pathrule-native-account-"));
  env = { PATHRULE_HOME: home } as NodeJS.ProcessEnv;
  clock = 1_000_000;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("createNativeAccount", () => {
  it("binds nobody for a workspace no mapping names, without asking the provider", async () => {
    const p = provider(async () => bindingFor("native-a"));
    const account = createNativeAccount({ provider: p, mappings: [MAPPING], env });
    await expect(account.binding("ws-other")).resolves.toBeNull();
    await expect(account.personalAccount().bind("ws-other")).resolves.toBeNull();
    const edition = account.edition();
    await expect(
      edition.personal!({ resolved: resolvedLocal, workspaceId: "ws-other" }),
    ).resolves.toBeNull();
    expect(p.resolveBinding).not.toHaveBeenCalled();
    await expect(readAccountOwners(env)).resolves.toEqual({});
  });

  it("binds the provider's owner: the store, the profiles of the mapped cloud workspace, the recorded owner", async () => {
    const bound = bindingFor("native-a");
    const account = createNativeAccount({
      provider: provider(async () => bound),
      mappings: [MAPPING],
      env,
    });
    const edition = account.edition();

    await expect(
      edition.personal!({ resolved: resolvedLocal, workspaceId: LOCAL }),
    ).resolves.toEqual({
      userId: "native-a",
      userKnowledge: bound.userKnowledgeStore,
    });
    await expect(readAccountOwners(env)).resolves.toMatchObject({
      native: { user_id: "native-a" },
    });
    await expect(edition.identity()).resolves.toBe("native:native-a");

    const sections = await edition.turnContext.sections({
      resolved: resolvedLocal,
      route: {} as never,
      workspaceId: LOCAL,
      currentNodePath: "/",
      userIntent: "ship it",
      knownItemVersions: undefined,
      surface: "chat",
    });
    expect(sections.intelligenceBlock).toContain("Team rule of native-a");
    expect(sections.retrieval).toEqual({ delta: "", version: "" });
    // The provider is asked for the mapped CLOUD workspace, never the local id.
    expect((bound.profileSource as ReturnType<typeof source>).workspaces).toEqual([CLOUD]);

    const person = await account.personalAccount().bind(LOCAL);
    expect(person?.userId).toBe("native-a");
    const delivery = await person!.intelligenceProfiles({ userIntent: "", surface: "chat" });
    expect(delivery?.owner).toBe("native-a");
    expect(delivery?.block).toContain("Team rule of native-a");
  });

  it("reuses a binding until it expires", async () => {
    const p = provider(async () => bindingFor("native-a"));
    const account = createNativeAccount({
      provider: p,
      mappings: [MAPPING],
      env,
      now: () => clock,
    });
    await account.binding(LOCAL);
    await account.binding(LOCAL);
    expect(p.resolveBinding).toHaveBeenCalledTimes(1);
    clock += NATIVE_BINDING_TTL_MS + 1;
    await account.binding(LOCAL);
    expect(p.resolveBinding).toHaveBeenCalledTimes(2);
  });

  it("an account switch replaces the recorded owner and drops the previous owner's bindings", async () => {
    const second: NativeWorkspaceMapping = {
      localWorkspaceId: "ws-local-2",
      cloudWorkspaceId: "ws-cloud-2",
    };
    let who = "native-a";
    const p = provider(async (mapping) => bindingFor(who, mapping));
    const account = createNativeAccount({
      provider: p,
      mappings: [MAPPING, second],
      env,
      now: () => clock,
    });
    expect((await account.binding(LOCAL))?.userId).toBe("native-a");
    expect((await account.binding("ws-local-2"))?.userId).toBe("native-a");

    who = "native-b";
    clock += NATIVE_BINDING_TTL_MS + 1;
    expect((await account.binding(LOCAL))?.userId).toBe("native-b");
    await expect(readAccountOwners(env)).resolves.toMatchObject({
      native: { user_id: "native-b" },
    });
    // The second workspace's binding was native-a's: it is resolved again, as native-b.
    clock += 1;
    expect((await account.binding("ws-local-2"))?.userId).toBe("native-b");
  });

  it("a provider with nobody signed in clears the recorded owner and binds nobody", async () => {
    let signedIn = true;
    const p = provider(async () => (signedIn ? bindingFor("native-a") : null));
    const account = createNativeAccount({
      provider: p,
      mappings: [MAPPING],
      env,
      now: () => clock,
    });
    await account.binding(LOCAL);
    signedIn = false;
    clock += NATIVE_BINDING_TTL_MS + 1;
    await expect(account.binding(LOCAL)).resolves.toBeNull();
    await expect(readAccountOwners(env)).resolves.toEqual({});
    await expect(account.edition().identity()).resolves.toBe("signed-out");
  });

  it("a failing provider binds nobody, keeps the recorded owner and is not asked again at once", async () => {
    await recordAccountOwner("native", "native-a", env);
    const p = provider(async () => {
      throw new Error("unreachable");
    });
    const account = createNativeAccount({
      provider: p,
      mappings: [MAPPING],
      env,
      now: () => clock,
    });
    const edition = account.edition();
    await expect(
      edition.personal!({ resolved: resolvedLocal, workspaceId: LOCAL }),
    ).resolves.toBeNull();
    const sections = await edition.turnContext.sections({
      resolved: resolvedLocal,
      route: {} as never,
      workspaceId: LOCAL,
      currentNodePath: "/",
      userIntent: "x",
      knownItemVersions: undefined,
      surface: "chat",
    });
    expect(sections.intelligenceBlock).toBe("");
    await expect(readAccountOwners(env)).resolves.toMatchObject({
      native: { user_id: "native-a" },
    });
    expect(p.resolveBinding).toHaveBeenCalledTimes(1);
    clock += NATIVE_BINDING_RETRY_MS + 1;
    await account.binding(LOCAL);
    expect(p.resolveBinding).toHaveBeenCalledTimes(2);
  });

  it("refuses a binding of another workspace than the mapping", async () => {
    const account = createNativeAccount({
      provider: provider(async () =>
        bindingFor("native-a", { ...MAPPING, cloudWorkspaceId: "elsewhere" }),
      ),
      mappings: [MAPPING],
      env,
    });
    await expect(account.binding(LOCAL)).resolves.toBeNull();
    await expect(readAccountOwners(env)).resolves.toEqual({});
  });

  it("signing out forgets the bindings and the recorded owner", async () => {
    const p = provider(async () => bindingFor("native-a"));
    const account = createNativeAccount({ provider: p, mappings: [MAPPING], env });
    await account.binding(LOCAL);
    await account.signOut();
    await expect(readAccountOwners(env)).resolves.toEqual({});
    await account.binding(LOCAL);
    expect(p.resolveBinding).toHaveBeenCalledTimes(2);
  });

  it("serves no project backend unless the composition opts in, and then only a mapped folder", async () => {
    const knowledge = new InMemoryKnowledgeBackend();
    const p = provider(async () => bindingFor("native-a", MAPPING, { knowledge }));
    const off = createNativeAccount({ provider: p, mappings: [MAPPING], env }).edition();
    await expect(off.resolveBackend("/repo/src")).resolves.toBeNull();
    expect(p.resolveBinding).not.toHaveBeenCalled();

    const on = createNativeAccount({
      provider: p,
      mappings: [MAPPING],
      env,
      serveProjectBackend: true,
    }).edition();
    await expect(on.resolveBackend("/elsewhere")).resolves.toBeNull();
    await expect(on.resolveBackend("/repository")).resolves.toBeNull();
    await expect(on.resolveBackend("/repo/src")).resolves.toEqual({
      backend: knowledge,
      kind: "cloud",
      mapping: MAPPING,
    });
  });

  it("a mapping must name both workspaces, once", () => {
    const p = provider(async () => null);
    expect(() =>
      createNativeAccount({
        provider: p,
        mappings: [{ localWorkspaceId: LOCAL, cloudWorkspaceId: "" }],
      }),
    ).toThrow(/both workspaces/);
    expect(() => createNativeAccount({ provider: p, mappings: [MAPPING, MAPPING] })).toThrow(
      /mapped twice/,
    );
  });

  it("offers the MCP server a Project only when the composition serves it, by either side of the mapping or the checkout", async () => {
    const knowledge = new InMemoryKnowledgeBackend();
    const p = provider(async () => bindingFor("native-a", MAPPING, { knowledge }));
    expect(
      createNativeAccount({ provider: p, mappings: [MAPPING], env }).projectAccount(),
    ).toBeNull();
    const project = createNativeAccount({
      provider: p,
      mappings: [MAPPING],
      env,
      serveProjectBackend: true,
    }).projectAccount()!;
    await expect(
      project.resolveContext({ workspaceId: null, cwd: "/elsewhere" }),
    ).resolves.toBeNull();
    for (const call of [
      { workspaceId: LOCAL, cwd: "/x" },
      { workspaceId: CLOUD, cwd: "/x" },
      { workspaceId: null, cwd: "/repo/src" },
    ]) {
      await expect(project.resolveContext(call)).resolves.toEqual({
        backend: knowledge,
        userId: "native-a",
        workspaceId: CLOUD,
      });
    }
  });

  it("takes the person's private hook entries off this machine when they sign out or are switched away from", async () => {
    const mkIndex = (owner: string) => {
      mkdirSync(join(home, "cache", "ws-x"), { recursive: true });
      writeFileSync(
        join(home, "cache", "ws-x", "hook-index.json"),
        JSON.stringify({
          workspace_id: "ws-x",
          path_memories: { "/": ["m"] },
          guidance: [{ id: "g", heading: "h", line: "l", terms: [] }],
          personal_owner: owner,
        }),
      );
    };
    const read = () =>
      JSON.parse(readFileSync(join(home, "cache", "ws-x", "hook-index.json"), "utf8")) as Record<
        string,
        unknown
      >;
    let who = "native-a";
    const account = createNativeAccount({
      provider: provider(async () => bindingFor(who)),
      mappings: [MAPPING],
      env,
      now: () => clock,
    });
    await account.binding(LOCAL);
    mkIndex("native-a");
    who = "native-b";
    clock += NATIVE_BINDING_TTL_MS + 1;
    await account.binding(LOCAL);
    expect(read()).toEqual({ workspace_id: "ws-x", path_memories: { "/": ["m"] } });
    mkIndex("native-b");
    await account.signOut();
    expect(read()).not.toHaveProperty("guidance");
  });
});
