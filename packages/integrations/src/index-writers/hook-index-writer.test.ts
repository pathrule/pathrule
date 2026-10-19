// SPDX-License-Identifier: Apache-2.0
// Regression guard for a silent capability gap: buildWarehousePayload is OPTIONAL in
// the backend contract, CloudBackend never implemented it, and the writer skipped it
// with a `typeof === "function"` check. So every cloud workspace got a hook-index with
// no warehouse beside it, loadWarehouse returned {}, and full-body delta delivery quietly
// degraded from full bodies to previews — with nothing reporting a problem.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hookDeliveredProfileIds, hookIndexProfiles, syncHookIndex } from "./hook-index-writer.js";
import { forgetPersonalFieldsOf } from "./personal-index-refresh.js";
import { LocalBackend } from "@pathrule/core";
import type { RemedyInput } from "@pathrule/agent-ir/atoms/remedy.js";
import { stampProposedRemedy } from "@pathrule/agent-ir/atoms/remedy-fingerprint.js";

const WS = "11111111-2222-3333-4444-555555555555";

let home: string;
let prevHome: string | undefined;

function hookIndex(): unknown {
  return {
    schema_version: 2,
    workspace_id: WS,
    generated_at: "2026-08-22T00:00:00.000Z",
    workspace_root: null,
    path_memories: {},
    path_rules: {},
    project_rules: [],
    filename_index: {},
    skill_invocation_index: {},
    pending_refresh_count: 0,
  };
}

function hookInput(): unknown {
  return {
    workspaceId: WS,
    generatedAt: "2026-08-22T00:00:00.000Z",
    memories: [
      { id: "mem-1", title: "Queue retries", content: "retry twice, then dead-letter", node_path: "/api", semantic_tags: null },
    ],
    rules: [
      { id: "rule-1", name: "No plaintext", content: "never store plaintext", scope_type: "project", priority: "high", node_paths: [], semantic_tags: null },
    ],
    skills: [
      { id: "skill-1", name: "deploy", description: null, content: "step one", source: "local", github_url: null, node_paths: [], semantic_tags: null },
    ],
    recentActivitySubjects: [],
    recentActivityDigest: [],
    workEpisodes: [],
    pendingRefreshCount: 0,
    inProgressRefreshCount: 0,
  };
}

/** A backend shaped like CloudBackend: raw input only, no assembler of its own. */
function cloudLikeBackend() {
  return {
    refreshWorkEpisodes: async () => ({ ok: true }),
    buildHookIndexPayload: async () => hookIndex(),
    buildHookInputPayload: async () => hookInput(),
  } as never;
}

/** A backend shaped like LocalBackend: assembles the warehouse itself. */
function localLikeBackend() {
  return {
    refreshWorkEpisodes: async () => ({ ok: true }),
    buildHookIndexPayload: async () => hookIndex(),
    buildWarehousePayload: async () => ({
      "mem-9": { type: "memory", title: "from the backend", body: "body", content_hash: "abc123" },
    }),
  } as never;
}

function warehousePath(): string {
  return join(home, "cache", WS, "warehouse.json");
}

beforeEach(() => {
  prevHome = process.env.PATHRULE_HOME;
  home = mkdtempSync(join(tmpdir(), "pathrule-whwriter-"));
  process.env.PATHRULE_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.PATHRULE_HOME;
  else process.env.PATHRULE_HOME = prevHome;
});

describe("warehouse production", () => {
  it("assembles from raw input when the backend cannot (the cloud case)", async () => {
    const result = await syncHookIndex({
      backend: cloudLikeBackend(),
      workspaceId: WS,
      workspaceRoot: "/repo",
      env: process.env,
      refreshEpisodes: false,
    });
    expect(result.ok).toBe(true);
    expect(existsSync(warehousePath())).toBe(true);

    const warehouse = JSON.parse(readFileSync(warehousePath(), "utf8")) as Record<
      string,
      { type: string; title: string; body: string; content_hash: string }
    >;
    // Full bodies, keyed by id, one entry per kind.
    expect(warehouse["mem-1"]).toMatchObject({ type: "memory", title: "Queue retries", body: "retry twice, then dead-letter" });
    expect(warehouse["rule-1"]).toMatchObject({ type: "rule", title: "No plaintext" });
    expect(warehouse["skill-1"]).toMatchObject({ type: "skill", title: "deploy" });
    // content_hash must be present — the delta gate compares it against the index stub.
    expect(warehouse["mem-1"]!.content_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("prefers the backend's own warehouse when it has one", async () => {
    await syncHookIndex({
      backend: localLikeBackend(),
      workspaceId: WS,
      workspaceRoot: "/repo",
      env: process.env,
      refreshEpisodes: false,
    });
    const warehouse = JSON.parse(readFileSync(warehousePath(), "utf8")) as Record<string, unknown>;
    expect(Object.keys(warehouse)).toEqual(["mem-9"]);
  });

  it("still writes the index when a backend offers neither producer", async () => {
    const result = await syncHookIndex({
      backend: {
        refreshWorkEpisodes: async () => ({ ok: true }),
        buildHookIndexPayload: async () => hookIndex(),
      } as never,
      workspaceId: WS,
      workspaceRoot: "/repo",
      env: process.env,
      refreshEpisodes: false,
    });
    // The warehouse is an optimization; its absence must never fail the sync.
    expect(result.ok).toBe(true);
    expect(existsSync(warehousePath())).toBe(false);
  });
});

// Knowledge moved under an `_archive` node describes code that is gone. Measured 2026-10-09: the
// live index carried 117 archived memories and 11 archived rules, and Claude's global body pool
// delivered them as "most relevant" on ordinary prompts. The writer is where every backend's hook
// payload passes, so it is where they leave, with their bodies and vectors.
describe("archived knowledge", () => {
  const stub = (id: string, node_path: string) => ({ id, title: id, preview: "", node_path });
  function archiveBackend() {
    return {
      refreshWorkEpisodes: async () => ({ ok: true }),
      buildHookIndexPayload: async () => ({
        ...(hookIndex() as object),
        path_memories: {
          "/api": [stub("live", "/api")],
          "/_archive/studio": [stub("old", "/_archive/studio")],
          "/packages/_archive": [stub("nested", "/packages/_archive")],
        },
        path_rules: {
          "/_archive/studio": [{ ...stub("old-rule", "/_archive/studio"), name: "old" }],
        },
        project_rules: [
          { ...stub("p-live", "/"), name: "live" },
          { ...stub("p-old", "/_archive/reels"), name: "old" },
        ],
        filename_index: { "app.tsx": ["old"], "queue.ts": ["live", "old"] },
      }),
      buildWarehousePayload: async () => ({
        live: { type: "memory", title: "live", body: "b", content_hash: "1" },
        old: { type: "memory", title: "old", body: "b", content_hash: "2" },
      }),
      buildEmbeddingsPayload: async () => ({ live: [1, 0], old: [0, 1] }),
    } as never;
  }

  it("leaves archive nodes, their rules, filename tokens, bodies and vectors out of the hook's files", async () => {
    await syncHookIndex({
      backend: archiveBackend(),
      workspaceId: WS,
      workspaceRoot: "/repo",
      env: process.env,
      refreshEpisodes: false,
    });
    const dir = join(home, "cache", WS);
    const index = JSON.parse(readFileSync(join(dir, "hook-index.json"), "utf8"));
    expect(Object.keys(index.path_memories)).toEqual(["/api"]);
    expect(index.path_rules).toEqual({});
    expect(index.project_rules.map((r: { id: string }) => r.id)).toEqual(["p-live"]);
    expect(index.filename_index).toEqual({ "queue.ts": ["live"] });
    expect(Object.keys(JSON.parse(readFileSync(join(dir, "warehouse.json"), "utf8")))).toEqual(["live"]);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, "embeddings.json"), "utf8")))).toEqual(["live"]);
  });
});

// The hook compares a prompt vector with embeddings.json only in the space the index names.
describe("embedding space stamping", () => {
  const read = () => JSON.parse(readFileSync(join(home, "cache", WS, "hook-index.json"), "utf8"));
  const backend = (extra: object) =>
    ({
      refreshWorkEpisodes: async () => ({ ok: true }),
      buildHookIndexPayload: async () => hookIndex(),
      buildEmbeddingsPayload: async () => ({ m1: [1, 0] }),
      ...extra,
    }) as never;

  it("names the space the backend's vectors are in", async () => {
    const space = "local/qwen3-embedding:0.6b@2#v1";
    await syncHookIndex({
      backend: backend({ embeddingSpace: async () => space }),
      workspaceId: WS,
      workspaceRoot: "/repo",
      env: process.env,
      refreshEpisodes: false,
    });
    expect(read().embedding_space).toBe(space);
  });

  it("never leaves another space's vectors beside the index", async () => {
    const sync = (extra: object) =>
      syncHookIndex({ backend: backend(extra), workspaceId: WS, workspaceRoot: "/repo", env: process.env, refreshEpisodes: false });
    const vectors = join(home, "cache", WS, "embeddings.json");
    await sync({ embeddingSpace: async () => "voyage/voyage-3-large@2#v1" });
    expect(JSON.parse(readFileSync(vectors, "utf8"))).toEqual({ m1: [1, 0] });

    // The space changes and the new space has no vectors yet: the old file goes.
    await sync({ embeddingSpace: async () => null, buildEmbeddingsPayload: async () => null });
    expect(() => readFileSync(vectors, "utf8")).toThrow();

    // The space moves while the payload is built: that payload is not written.
    let calls = 0;
    await sync({ embeddingSpace: async () => (++calls === 1 ? "local/a@2#v1" : "local/b@2#v1") });
    expect(read().embedding_space).toBe("local/a@2#v1");
    expect(() => readFileSync(vectors, "utf8")).toThrow();
  });

  it("names none for a backend that states none, or fails to", async () => {
    for (const extra of [{}, { embeddingSpace: async () => null }, { embeddingSpace: async () => { throw new Error("x"); } }]) {
      await syncHookIndex({ backend: backend(extra), workspaceId: WS, workspaceRoot: "/repo", env: process.env, refreshEpisodes: false });
      expect(read()).not.toHaveProperty("embedding_space");
    }
  });
});

// The index half of the protocol-channel decision. The file half lives in
// renderForClients; `resolveProtocolChannel` is what keeps them in step, and its
// own invariant test lives next to it.
describe("protocol stamping", () => {
  function indexPath(): string {
    return join(home, "cache", WS, "hook-index.json");
  }
  function readIndex(): Record<string, unknown> {
    return JSON.parse(readFileSync(indexPath(), "utf8")) as Record<string, unknown>;
  }

  it("leaves the field off when the caller passes no protocol", async () => {
    const r = await syncHookIndex({
      backend: cloudLikeBackend(),
      workspaceId: WS,
      workspaceRoot: "/repo",
      env: process.env,
      refreshEpisodes: false,
    });
    expect(r.ok).toBe(true);
    expect(readIndex().protocol).toBeUndefined();
  });

  it("stamps the rendered protocol when the caller supplies one", async () => {
    await syncHookIndex({
      backend: cloudLikeBackend(),
      workspaceId: WS,
      workspaceRoot: "/repo",
      env: process.env,
      refreshEpisodes: false,
      protocol: "# Pathrule protocol\n\n1. obey surfaced rules",
    });
    expect(readIndex().protocol).toBe("# Pathrule protocol\n\n1. obey surfaced rules");
  });

  it("treats a blank protocol as absent", async () => {
    await syncHookIndex({
      backend: cloudLikeBackend(),
      workspaceId: WS,
      workspaceRoot: "/repo",
      env: process.env,
      refreshEpisodes: false,
      protocol: "  \n ",
    });
    expect(readIndex().protocol).toBeUndefined();
  });
});

// The semantic ranking endpoint a Cloud workspace's index carries: Pathrule Cloud's own, with no key.
describe("the semantic endpoint", () => {
  const readIndex = () =>
    JSON.parse(readFileSync(join(home, "cache", WS, "hook-index.json"), "utf8")) as Record<string, unknown>;
  const sync = (cloud?: Parameters<typeof syncHookIndex>[0]["cloud"]) =>
    syncHookIndex({ backend: cloudLikeBackend(), workspaceId: WS, workspaceRoot: "/repo", env: process.env, refreshEpisodes: false, ...(cloud ? { cloud } : {}) });

  it("stamps Pathrule Cloud's endpoint without a key", async () => {
    await sync({ url: "https://cloud.pathrule.io", native: true });
    expect(readIndex().cloud_semantic).toEqual({ url: "https://cloud.pathrule.io", kind: "native" });
  });

  it("stamps nothing for a local caller or half an endpoint", async () => {
    for (const cloud of [undefined, { url: "", native: true as const }]) {
      await sync(cloud);
      expect(readIndex()).not.toHaveProperty("cloud_semantic");
    }
  });
});

describe("knowledge gaps on the index", () => {
  const indexPath = () => join(process.env.PATHRULE_HOME!, "cache", WS, "hook-index.json");

  it("stamps explicit gap stubs and leaves the field off when there are none", async () => {
    const stub = { ref: "gap_00000001", scope: "packages/cli/src", line: "nothing recorded references packages/cli/src" };
    await syncHookIndex({ backend: cloudLikeBackend(), workspaceId: WS, workspaceRoot: "/repo", env: process.env, refreshEpisodes: false, knowledgeGaps: [stub] });
    expect(JSON.parse(readFileSync(indexPath(), "utf8")).knowledge_gaps).toEqual([stub]);
    await syncHookIndex({ backend: cloudLikeBackend(), workspaceId: WS, workspaceRoot: "/repo", env: process.env, refreshEpisodes: false, knowledgeGaps: [] });
    expect(JSON.parse(readFileSync(indexPath(), "utf8"))).not.toHaveProperty("knowledge_gaps");
  });

  it("writes the Foundation index without gaps when no caller names any", async () => {
    await syncHookIndex({ backend: cloudLikeBackend(), workspaceId: WS, workspaceRoot: "/repo", env: process.env, refreshEpisodes: false });
    const written = JSON.parse(readFileSync(indexPath(), "utf8"));
    expect(written.project_rules).toEqual([]);
    expect(written.workspace_root).toBe("/repo");
    expect(written).not.toHaveProperty("knowledge_gaps");
    expect(existsSync(warehousePath())).toBe(true);
  });

  it("computes nothing while delivery is off, whatever the backend offers", async () => {
    let asked = 0;
    const backend = {
      ...(cloudLikeBackend() as object),
      buildKnowledgeMapInput: async () => {
        asked++;
        return null;
      },
      knowledgeMapFingerprint: async () => {
        asked++;
        return "fp";
      },
    };
    const env = { PATHRULE_HOME: process.env.PATHRULE_HOME, PATHRULE_MAINTENANCE_KNOWLEDGE_GAP_DELIVERY_ENABLED: "false" };
    await syncHookIndex({ backend: backend as never, workspaceId: WS, workspaceRoot: "/repo", env, refreshEpisodes: false });
    expect(asked).toBe(0);
    expect(JSON.parse(readFileSync(indexPath(), "utf8"))).not.toHaveProperty("knowledge_gaps");
  });
});

describe("path drift on the index", () => {
  const indexPath = () => join(process.env.PATHRULE_HOME!, "cache", WS, "hook-index.json");
  const RUNBOOK = "# On-call runbook\n\nOne row per error slug.\n\n| Slug | Status | Check first |\n| --- | --- | --- |\n";

  /** A git checkout where a teammate copied the runbook to docs/oncall/ and pointed the README there. */
  function movedRunbookCheckout(): string {
    const root = mkdtempSync(join(tmpdir(), "pathrule-drift-"));
    mkdirSync(join(root, "docs", "oncall"), { recursive: true });
    writeFileSync(join(root, "docs", "runbook.md"), RUNBOOK);
    writeFileSync(join(root, "docs", "oncall", "runbook.md"), RUNBOOK);
    writeFileSync(join(root, "README.md"), "- On-call runbook: `docs/oncall/runbook.md`\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    return root;
  }

  function driftBackend(requested: unknown[], alreadyPending = false) {
    return {
      ...(cloudLikeBackend() as object),
      buildHookIndexPayload: async () => ({
        ...(hookIndex() as object),
        path_memories: { "/docs": [{ id: "mem-rb", title: "On-call runbook", preview: "", node_path: "/docs", content_hash: "h" }] },
      }),
      listMemories: async () => [{ id: "mem-rb", title: "On-call runbook", content: "Every slug has a row in `docs/runbook.md`." }],
      requestRefresh: async (input: unknown) => {
        requested.push(input);
        return { refreshId: "r-1", alreadyPending };
      },
    } as never;
  }

  it("warns the edit of the old file and asks for a refresh of the memory", async () => {
    const requested: unknown[] = [];
    await syncHookIndex({ backend: driftBackend(requested), workspaceId: WS, workspaceRoot: movedRunbookCheckout(), env: process.env, refreshEpisodes: false });
    const written = JSON.parse(readFileSync(indexPath(), "utf8"));
    expect(written.knowledge_gaps).toHaveLength(1);
    expect(written.knowledge_gaps[0].scope).toBe("docs/runbook.md");
    expect(written.knowledge_gaps[0].line).toContain("README.md now names docs/oncall/runbook.md, a copy of it. Write to docs/oncall/runbook.md");
    expect(requested).toEqual([
      { subjectType: "memory", subjectId: "mem-rb", kind: "drift", reason: "docs/runbook.md looks moved: README.md now names docs/oncall/runbook.md, a copy of it. Point the memory at the current file." },
    ]);
    expect(written.pending_refresh_count).toBe(1);
    // The session digest carries it to the first prompt, for work an edit hook never sees.
    expect(written.session_digest).toContain("- docs/runbook.md → docs/oncall/runbook.md (README.md names the new one)");
  });

  it("follows a rename git recorded, from a checkout below the repository's top, and caches the history per HEAD", async () => {
    const top = mkdtempSync(join(tmpdir(), "pathrule-rename-"));
    const root = join(top, "service");
    mkdirSync(join(root, "docs", "adr"), { recursive: true });
    writeFileSync(join(root, "docs", "adr", "0003-outcome.md"), "# 0003\n\nOutcome observation.\n");
    const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: top, stdio: "ignore" });
    g("init", "-q");
    g("add", "-A");
    g("commit", "-qm", "adr");
    mkdirSync(join(root, "docs", "architecture"), { recursive: true });
    g("mv", "service/docs/adr/0003-outcome.md", "service/docs/architecture/0003-outcome.md");
    g("commit", "-qm", "move");
    const backend = {
      ...(driftBackend([]) as object),
      listMemories: async () => [{ id: "mem-rb", title: "ADR 0003", content: "Decided in `docs/adr/0003-outcome.md`." }],
    } as never;
    await syncHookIndex({ backend, workspaceId: WS, workspaceRoot: root, env: process.env, refreshEpisodes: false });
    const gaps = JSON.parse(readFileSync(indexPath(), "utf8")).knowledge_gaps;
    expect(gaps.map((s: { scope: string }) => s.scope)).toEqual(["docs/adr/0003-outcome.md"]);
    expect(gaps[0].line).toContain("git shows it was renamed to docs/architecture/0003-outcome.md");
    const cached = JSON.parse(readFileSync(join(process.env.PATHRULE_HOME!, "cache", WS, "rename-map.json"), "utf8"));
    expect(cached.prefix).toBe("service/");
    expect(cached.renames).toEqual({ "docs/adr/0003-outcome.md": "docs/architecture/0003-outcome.md" });
  });

  it("counts a refresh that was already open once, and adds nothing outside a git checkout", async () => {
    await syncHookIndex({ backend: driftBackend([], true), workspaceId: WS, workspaceRoot: movedRunbookCheckout(), env: process.env, refreshEpisodes: false });
    expect(JSON.parse(readFileSync(indexPath(), "utf8")).pending_refresh_count).toBe(0);
    const requested: unknown[] = [];
    const plain = mkdtempSync(join(tmpdir(), "pathrule-nogit-"));
    await syncHookIndex({ backend: driftBackend(requested), workspaceId: WS, workspaceRoot: plain, env: process.env, refreshEpisodes: false });
    expect(JSON.parse(readFileSync(indexPath(), "utf8"))).not.toHaveProperty("knowledge_gaps");
    expect(requested).toEqual([]);
  });
});

// Several writers rewrite the index, and only some of them own the user-intelligence decision
// (Studio, MCP get_context, `pathrule me`). `pathrule sync` and the local edition's init and sync
// pass no preferences; before the carry-over, each of them erased what the first group had written.
describe("personal entries across writers", () => {
  const indexPath = () => join(process.env.PATHRULE_HOME!, "cache", WS, "hook-index.json");
  const readIndex = () => JSON.parse(readFileSync(indexPath(), "utf8")) as Record<string, unknown>;
  const preference = { id: "pref-1", line: "Prefers small reviewed commits", terms: ["commit"], always: false };
  const guidance = { id: "lease-1", heading: "Expertise", line: "Knows the billing code well", terms: ["billing"] };
  const sync = (extra: Record<string, unknown> = {}) =>
    syncHookIndex({
      backend: cloudLikeBackend(),
      workspaceId: WS,
      workspaceRoot: "/repo",
      env: process.env,
      refreshEpisodes: false,
      ...extra,
    });

  it("keeps the entries when a later writer passes none", async () => {
    await sync({ userPreferences: [preference], guidance: [guidance] });
    await sync();
    expect(readIndex().user_preferences).toEqual([preference]);
    expect(readIndex().guidance).toEqual([guidance]);
  });

  it("clears them when a writer that owns the decision passes empty arrays", async () => {
    await sync({ userPreferences: [preference], guidance: [guidance] });
    await sync({ userPreferences: [], guidance: [] });
    expect(readIndex()).not.toHaveProperty("user_preferences");
    expect(readIndex()).not.toHaveProperty("guidance");
  });

  it("replaces one field and carries the other", async () => {
    const next = { ...preference, id: "pref-2", line: "Wants tests before refactors" };
    await sync({ userPreferences: [preference], guidance: [guidance] });
    await sync({ userPreferences: [next] });
    expect(readIndex().user_preferences).toEqual([next]);
    expect(readIndex().guidance).toEqual([guidance]);
  });

  it("drops malformed entries instead of handing them to the hook", async () => {
    await sync({ userPreferences: [preference] });
    const raw = readIndex();
    raw.user_preferences = [preference, { id: 7, line: null }, "junk"];
    raw.guidance = [{ id: "g", heading: "h", line: "l" }];
    writeFileSync(indexPath(), JSON.stringify(raw));
    await sync();
    expect(readIndex().user_preferences).toEqual([preference]);
    expect(readIndex()).not.toHaveProperty("guidance");
  });

  it("stamps an account's entries with their owner and never carries one person's half under another's", async () => {
    const next = { ...preference, id: "pref-2", line: "Wants tests before refactors" };
    await sync({ userPreferences: [preference], guidance: [guidance], personalOwner: "native-a" });
    expect(readIndex().personal_owner).toBe("native-a");
    // A writer that passes no entries carries them with their owner.
    await sync();
    expect(readIndex()).toMatchObject({ user_preferences: [preference], guidance: [guidance], personal_owner: "native-a" });
    // The local person writes one half: native-a's other half is not relabelled as theirs.
    await sync({ userPreferences: [next], personalOwner: null });
    expect(readIndex().user_preferences).toEqual([next]);
    expect(readIndex()).not.toHaveProperty("guidance");
    expect(readIndex()).not.toHaveProperty("personal_owner");
  });

  it("carries nothing from an unreadable file or another workspace's index", async () => {
    mkdirSync(join(process.env.PATHRULE_HOME!, "cache", WS), { recursive: true });
    writeFileSync(indexPath(), "{ not json");
    await sync();
    expect(readIndex()).not.toHaveProperty("user_preferences");

    writeFileSync(indexPath(), JSON.stringify({ workspace_id: "someone-else", user_preferences: [preference] }));
    await sync();
    expect(readIndex()).not.toHaveProperty("user_preferences");
  });
});

// The account's team and personal profiles: only an account writer knows them, so the discipline is
// the personal entries' (omitted keeps, null clears), and only the owner's sessions read the ids.
describe("team and personal profiles across writers", () => {
  const indexPath = () => join(process.env.PATHRULE_HOME!, "cache", WS, "hook-index.json");
  const readIndex = () => JSON.parse(readFileSync(indexPath(), "utf8")) as Record<string, unknown>;
  const profiles = {
    owner: "person-a",
    version: "intelligence:abc",
    block: "## Team and personal profiles (human-managed)\n- [high · testing] Write tests first.",
    ids: ["t-1"],
  };
  const sync = (extra: Record<string, unknown> = {}) =>
    syncHookIndex({
      backend: cloudLikeBackend(),
      workspaceId: WS,
      workspaceRoot: "/repo",
      env: process.env,
      refreshEpisodes: false,
      ...extra,
    });

  it("keeps the block when a later writer passes none, clears it on null, replaces it on an entry", async () => {
    await sync({ intelligenceProfiles: profiles });
    expect(readIndex().intelligence_profiles).toEqual(profiles);
    // `pathrule sync` without an account answer, the local edition, Studio's writer: kept.
    await sync({ userPreferences: [] });
    expect(readIndex().intelligence_profiles).toEqual(profiles);
    const next = { ...profiles, version: "intelligence:def", ids: ["t-2"] };
    await sync({ intelligenceProfiles: next });
    expect(readIndex().intelligence_profiles).toEqual(next);
    await sync({ intelligenceProfiles: null });
    expect(readIndex()).not.toHaveProperty("intelligence_profiles");
  });

  it("drops a malformed block and carries nothing from another workspace's index", async () => {
    await sync({ intelligenceProfiles: { ...profiles, owner: "" } });
    expect(readIndex()).not.toHaveProperty("intelligence_profiles");
    writeFileSync(
      indexPath(),
      JSON.stringify({ workspace_id: "someone-else", intelligence_profiles: profiles }),
    );
    await sync();
    expect(readIndex()).not.toHaveProperty("intelligence_profiles");
  });

  it("maps a provider's answer: unavailable keeps, nothing clears, a block replaces", () => {
    expect(hookIndexProfiles(null)).toBeUndefined();
    expect(
      hookIndexProfiles({ owner: "a", surface: "chat", block: "", version: "", ids: [] }),
    ).toBeNull();
    expect(
      hookIndexProfiles({ owner: "a", surface: "chat", block: "B", version: "v", ids: ["x"] }),
    ).toEqual({ owner: "a", version: "v", block: "B", ids: ["x"] });
  });

  it("names the hook's entries only to the person they were selected for", async () => {
    expect(await hookDeliveredProfileIds(process.env, WS, "person-a")).toEqual([]);
    await sync({ intelligenceProfiles: profiles });
    expect(await hookDeliveredProfileIds(process.env, WS, "person-a")).toEqual(["t-1"]);
    expect(await hookDeliveredProfileIds(process.env, WS, "person-b")).toEqual([]);
    expect(await hookDeliveredProfileIds(process.env, "another-ws", "person-a")).toEqual([]);
  });
});

/** `WS` attached to a Pathrule Cloud workspace on this machine, as the Cloud plugin records it. */
function attachWsToCloud(): void {
  const dir = join(home, "config", "users", "person-hash");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "native-workspaces.json"),
    JSON.stringify({ schema_version: 1, workspaces: [{ workspace_id: WS, organization_id: "org-1", name: "Cloud", root: "/repo" }] }),
  );
}

// The hook picks one edition per folder by this stamp (core workspace/folder-mode.ts).
describe("the edition stamp", () => {
  const readIndex = () => JSON.parse(readFileSync(join(home, "cache", WS, "hook-index.json"), "utf8")) as Record<string, unknown>;
  const sync = (mode?: "cloud" | "local") =>
    syncHookIndex({ backend: cloudLikeBackend(), workspaceId: WS, workspaceRoot: "/repo", env: process.env, refreshEpisodes: false, ...(mode ? { mode } : {}) });

  it("stamps the mode the caller names", async () => {
    await sync("cloud");
    expect(readIndex().mode).toBe("cloud");
    await sync("local");
    expect(readIndex().mode).toBe("local");
  });

  it("derives it when the caller names none: a Cloud workspace attached here is cloud, anything else local", async () => {
    await sync();
    expect(readIndex().mode).toBe("local");
    attachWsToCloud();
    await sync();
    expect(readIndex().mode).toBe("cloud");
  });
});

// Approved atoms a Local store holds, for a backend that does not compile its own (shaped like the
// Cloud's). A Cloud index never takes them: a Cloud folder is never served from a Local store, even
// one left under its id from before each folder had one edition.
describe("approved atoms in a local store", () => {
  const readIndex = () => JSON.parse(readFileSync(join(home, "cache", WS, "hook-index.json"), "utf8")) as Record<string, unknown>;
  const storePath = () => join(home, "cache", "..", WS, "pathrule.db");

  async function approvedAtomInLocalStore(): Promise<string> {
    const store = LocalBackend.openForWorkspace(WS, process.env);
    try {
      store.registerWorkspace({ workspaceId: WS, localRootPath: "/repo" });
      const node = await store.ensureNodeForPath(WS, "/apps/web", "folder");
      const memory = await store.writeMemory({ workspaceId: WS, nodeId: node.id, title: "t", content: "wrap with safeFoo() to fix it" });
      const input: RemedyInput = {
        variant: "trouble",
        condition_evidence: ["it broke"],
        condition_normalized: null,
        action_evidence: ["safeFoo()"],
        evidence_state: "OBSERVED_SUCCESS",
        source: { kind: "memory", id: memory.id, title: "t", node_path: null },
        observed_at: "2026-09-01T00:00:00.000Z",
      };
      const atom = await store.proposeRemedyAtom(WS, stampProposedRemedy(input, { now: "2026-09-01T00:00:00.000Z" }));
      await store.decideRemedyAtom(WS, atom.id, "approve", "user-1");
      return atom.id;
    } finally {
      store.close();
    }
  }

  // The composition root's opener: the writer itself never names a storage implementation.
  const openLocalAtomStore = (workspaceId: string, env: NodeJS.ProcessEnv) => LocalBackend.openForWorkspace(workspaceId, env);
  const syncWith = (backend: unknown) =>
    syncHookIndex({
      backend: backend as never,
      workspaceId: WS,
      workspaceRoot: "/repo",
      env: process.env,
      refreshEpisodes: false,
      openLocalAtomStore,
    });

  it("delivers them from the local store as plain additive lines", async () => {
    const ref = await approvedAtomInLocalStore();

    await syncWith(cloudLikeBackend());

    const advisories = readIndex().path_advisories as Record<string, Array<Record<string, unknown>>>;
    const delivered = Object.values(advisories).flat();
    expect(delivered.map((stub) => stub.ref)).toContain(ref);
    expect(JSON.stringify(delivered)).toContain("safeFoo()");
    // No compiled-body grouping: the cloud index's memory stubs are hashed from the text as written.
    for (const stub of delivered) expect(Object.keys(stub).sort()).toEqual(["line", "ref"]);
  });

  it("reads no local store when the caller supplies no opener", async () => {
    await approvedAtomInLocalStore();

    await syncHookIndex({ backend: cloudLikeBackend() as never, workspaceId: WS, workspaceRoot: "/repo", env: process.env, refreshEpisodes: false });

    expect(readIndex()).not.toHaveProperty("path_advisories");
    expect(readIndex()).not.toHaveProperty("project_advisories");
  });

  it("creates no store for a cloud workspace that has none", async () => {
    await syncWith(cloudLikeBackend());

    expect(existsSync(storePath())).toBe(false);
    expect(readIndex()).not.toHaveProperty("path_advisories");
    expect(readIndex()).not.toHaveProperty("project_advisories");
  });

  it("never opens the local store for a Cloud index, named or derived", async () => {
    await approvedAtomInLocalStore();
    let opened = 0;
    const counting = (workspaceId: string, env: NodeJS.ProcessEnv) => {
      opened += 1;
      return openLocalAtomStore(workspaceId, env);
    };
    const base = { backend: cloudLikeBackend() as never, workspaceId: WS, workspaceRoot: "/repo", env: process.env, refreshEpisodes: false, openLocalAtomStore: counting };

    await syncHookIndex({ ...base, mode: "cloud" });
    expect(readIndex()).toMatchObject({ mode: "cloud" });
    expect(readIndex()).not.toHaveProperty("path_advisories");
    attachWsToCloud();
    await syncHookIndex(base);
    expect(readIndex()).toMatchObject({ mode: "cloud" });
    expect(readIndex()).not.toHaveProperty("path_advisories");
    expect(opened).toBe(0);
  });

  it("leaves a backend that holds its own atoms to its own payload", async () => {
    await approvedAtomInLocalStore();
    const ownAtoms = { ...(cloudLikeBackend() as object), compiledMemoryDeliveries: async () => ({}) };

    await syncWith(ownAtoms);

    expect(readIndex()).not.toHaveProperty("path_advisories");
  });
});

// An account signing out, switched away from or revoked: its entries leave every index on disk,
// while the local person's entries and every project field stay.
describe("forgetPersonalFieldsOf", () => {
  const cache = (ws: string) => join(process.env.PATHRULE_HOME!, "cache", ws);
  const write = (ws: string, extra: Record<string, unknown>) => {
    mkdirSync(cache(ws), { recursive: true });
    writeFileSync(join(cache(ws), "hook-index.json"), JSON.stringify({ workspace_id: ws, path_memories: { "/": ["m-1"] }, ...extra }));
  };
  const read = (ws: string) => JSON.parse(readFileSync(join(cache(ws), "hook-index.json"), "utf8")) as Record<string, unknown>;
  const prefs = [{ id: "p", line: "l", terms: ["t"], always: false }];

  it("removes the owner's entries and profile block and keeps everything else", async () => {
    write("ws-a", { user_preferences: prefs, personal_owner: "native-a", intelligence_profiles: { owner: "native-a", version: "v", block: "B", ids: [] } });
    write("ws-b", { user_preferences: prefs, intelligence_profiles: { owner: "person-b", version: "v", block: "B", ids: [] } });
    expect(await forgetPersonalFieldsOf(["native-a"], process.env)).toBe(1);
    expect(read("ws-a")).toEqual({ workspace_id: "ws-a", path_memories: { "/": ["m-1"] } });
    expect(read("ws-b")).toMatchObject({ user_preferences: prefs, intelligence_profiles: { owner: "person-b" } });
  });
});
