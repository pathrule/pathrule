// SPDX-License-Identifier: Apache-2.0
// Copying a folder's Local knowledge to its Pathrule Cloud workspace (`pathrule setup --cloud`): it
// previews before anything leaves, copies only on a separate yes, never twice and never over an edit
// made since, stops at a full plan and says so, never shortens an item, remembers a no, and leaves
// the Local store as it was. `setup` also writes the MCP entries; `init` does not.
//
// Real Local stores, written the way the CLI's tests write them. Pathrule Cloud is a fake fetch whose
// Project routes are served by an in-memory store, with the transfer contract added: a create-only
// write (`ifAbsent`) returns an existing item unchanged.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { parseCliArgs } from "@pathrule/cli/args.js";
import type { CliCommandContext, CliRuntime, CliSetupPlan } from "@pathrule/cli/plugin.js";
import { runCli as runOpenCli } from "@pathrule/cli/run.js";
import { LocalBackend } from "@pathrule/core/backend/local/local-backend.js";
import { recordFolderChoice } from "@pathrule/core/workspace/folder-mode.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cloudHttp } from "../../native/client/http.js";
import { createCloudProjectHttpBackend } from "../../native/client/project-backend.js";
import { attachNativeWorkspace } from "../../native/workspaces.js";
import { jsonNative, renderNative } from "../commands/native-commands.js";
import { cloudCliPlugin } from "../plugin.js";
import { transferItemId } from "./preview.js";
import { transferStatePath } from "./state.js";
import { TRANSFER_COMMAND, transferLocalKnowledge, type TransferInput } from "./step.js";

const BASE = "https://cloud.example.test";
const TOKEN = "native-session-token.signature";
const USER = "user-1";
const ORG = "org-1";
const CLOUD_WS = "c1c1c1c1-0000-4000-8000-000000000001";
const LOCAL_WS = "5af08c07-b6c4-4ab9-89fe-298e59220650";
const CONSTRAINT = {
  id: "c-cursor",
  mode: "forbid",
  match: { kind: "regex", pattern: "cursor:\\s*pointer", flags: "i" },
  message: "Use a real button.",
  authority: "human",
  status: "active",
  created_at: "2026-09-01T00:00:00.000Z",
  approved_by: "local-person",
};

class MemoryWriter {
  chunks: string[] = [];
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(String(chunk));
    return true;
  }
  toString() {
    return this.chunks.join("");
  }
}

interface Usage {
  storage: { used_bytes: number; limit_bytes: number | null };
  vectors: { used: number; limit: number | null };
  nodes: { used: number; limit: number | null };
  item_max_bytes: number;
  title_max_chars: number;
  max_vectors_per_item: number;
}

const roomyUsage = (): Usage => ({
  storage: { used_bytes: 1000, limit_bytes: 10_000_000 },
  vectors: { used: 10, limit: 1000 },
  nodes: { used: 2, limit: 100 },
  item_max_bytes: 1_048_576,
  title_max_chars: 500,
  max_vectors_per_item: 160,
});

let root: string;
let home: string;
let repo: string;
let env: NodeJS.ProcessEnv;
let cloudStore: LocalBackend;
let writes: { op: string; input: Record<string, any> }[];
let offersTransfer: boolean;
let usage: Usage;
/** Refuses a write: called with the op, the input and how many writes the Cloud took so far. */
let refuse: ((op: string, input: Record<string, any>, taken: number) => Reply | null) | null;
let cloudWorkspaces: { id: string; organization_id: string; name: string }[];
let local: Record<"m1" | "m2" | "rule" | "skill", string>;

type Reply = { status: number; body: unknown };

/** Pathrule Cloud as the CLI meets it: sign-in, tenancy, usage and the workspace's Project routes. */
const cloud = (async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  const json = (value: unknown, status = 200) => Response.json(value ?? null, { status });
  const path = url.pathname;
  if (path === "/api/auth/device/code")
    return json({
      device_code: "device-1",
      user_code: "WXYZ2345",
      verification_uri: `${BASE}/device`,
      verification_uri_complete: `${BASE}/device?user_code=WXYZ2345`,
      interval: 1,
      expires_in: 600,
    });
  if (path === "/api/auth/device/token") return json({ access_token: TOKEN, token_type: "Bearer" });
  if (path === "/api/auth/get-session")
    return json({
      session: { expiresAt: "2099-01-01T00:00:00.000Z" },
      user: { id: USER, email: "person@example.invalid" },
    });
  if (path === "/v1/me/identity") return json({ userId: USER });
  if (path === "/v1/organizations")
    return json({ items: [{ id: ORG, name: "Acme", role: "owner", plan: "team", revision: 1 }] });
  if (path === `/v1/organizations/${ORG}/workspaces`) {
    if (method === "POST") {
      const created = { id: CLOUD_WS, organization_id: ORG, name: body.name };
      cloudWorkspaces.push(created);
      return json(created, 201);
    }
    return json({ items: cloudWorkspaces });
  }
  if (path === "/v1/me/workspace-access")
    return json({
      items: (body.ids as string[]).map((id) => ({
        id,
        state: "active",
        revision: 1,
        organizationId: ORG,
      })),
    });
  if (path === `/v1/workspaces/${CLOUD_WS}`)
    return json({ id: CLOUD_WS, organization_id: ORG, name: "Acme App" });
  if (path === `/v1/workspaces/${CLOUD_WS}/usage`)
    return json({ workspace_id: CLOUD_WS, organization_id: ORG, ...usage });
  const op = path.match(new RegExp(`^/v1/workspaces/${CLOUD_WS}/foundation/project/(\\w+)$`))?.[1];
  if (op === "capabilities")
    return json({
      aiMerge: false,
      aiGenerate: false,
      staleness: false,
      realtime: false,
      semantic: false,
      routerLLM: false,
      ...(offersTransfer ? { knowledgeTransfer: 1 } : {}),
    });
  if (op) {
    const args = body.args as any[];
    if (op === "writeMemory" || op === "writeRule" || op === "writeSkill") {
      const write = { ...args[0] };
      const refused = refuse?.(op, write, writes.length);
      if (refused) return json(refused.body, refused.status);
      writes.push({ op, input: { ...write } });
      const read = op.replace("write", "read") as "readMemory" | "readRule" | "readSkill";
      const existing = write.id ? await cloudStore[read](write.id) : null;
      // The contract: create-only with a client id; what is there comes back unchanged.
      if (write.ifAbsent && existing) return json(existing);
      delete write.ifAbsent;
      delete write.origin;
      return json(await (cloudStore as any)[op](write));
    }
    return json(await (cloudStore as any)[op](...args));
  }
  return json({ error: "not a Pathrule Cloud route" }, 404);
}) as typeof fetch;

function runtime(stdout = new MemoryWriter(), answer?: string): CliRuntime {
  return {
    cwd: repo,
    env,
    stdout,
    stderr: new MemoryWriter(),
    fetch: cloud,
    sleep: async () => {},
    openUrl: async () => {},
    ...(answer === undefined ? {} : { promptLine: async () => answer }),
  };
}

/** The folder's Local workspace, as the person built it before choosing Cloud. */
async function localStore(extra?: (b: LocalBackend) => Promise<void>): Promise<void> {
  const b = LocalBackend.openForWorkspace(LOCAL_WS, { PATHRULE_HOME: home });
  try {
    b.registerWorkspace({ workspaceId: LOCAL_WS, name: "repo-local", localRootPath: repo });
    const web = await b.ensureNodeForPath(LOCAL_WS, "/apps/web");
    const top = await b.ensureNodeForPath(LOCAL_WS, "/");
    const m1 = await b.writeMemory({
      workspaceId: LOCAL_WS,
      nodeId: web.id,
      title: "Checkout flow",
      content: "The checkout posts to /api/pay and retries twice.",
      relatedPaths: ["/packages/payments"],
    });
    const m2 = await b.writeMemory({
      workspaceId: LOCAL_WS,
      nodeId: top.id,
      title: "Release notes live in CHANGELOG.md",
      content: "Every release adds a section at the top.",
    });
    const rule = await b.writeRule({
      workspaceId: LOCAL_WS,
      nodeId: web.id,
      name: "Never use cursor: pointer on a div",
      content: "Use a real button or anchor; cursor: pointer on a div hides the semantics.",
      scopeType: "folder",
      priority: "high",
      constraints: [CONSTRAINT as never],
    });
    const skill = await b.writeSkill({
      workspaceId: LOCAL_WS,
      nodeId: top.id,
      name: "release-check",
      description: "What to verify before a release",
      content: "1. Run the tests.\n2. Read the changelog.",
      source: "github_ref",
      githubUrl: "https://github.com/acme/skills/blob/main/release-check/SKILL.md",
      tags: ["release", "checklist"],
    });
    local = { m1: m1.id, m2: m2.id, rule: rule.id, skill: skill.id };
    await extra?.(b);
  } finally {
    b.close();
  }
  // Local keeps a skill's own version; a new one starts at 1.0.0 (schema default).
  const db = new Database(join(home, LOCAL_WS, "pathrule.db"));
  db.prepare("UPDATE skills SET version = '2.3.0' WHERE id = ?").run(local.skill);
  db.close();
}

/** What the Local store holds, read without the store's code: rows and their content. */
function localSnapshot(): string {
  const db = new Database(join(home, LOCAL_WS, "pathrule.db"), { readonly: true });
  try {
    // Every table, so a write anywhere in the store shows.
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["memories", "rules", "skills", "nodes"]));
    return JSON.stringify(
      tables.map((t) => [t, db.prepare(`SELECT * FROM "${t}" ORDER BY 1`).all()]),
    );
  } finally {
    db.close();
  }
}

/** The person chose Cloud for this folder before the Cloud setup runs; the folder is attached. */
async function cloudFolder(): Promise<void> {
  recordFolderChoice(env, repo, "cloud", "setup");
  await attachNativeWorkspace(
    USER,
    { workspace_id: CLOUD_WS, organization_id: ORG, name: "Acme App", root: repo },
    env,
  );
}

async function transfer(over: Partial<TransferInput> = {}) {
  const transport = { baseUrl: BASE, headers: async () => ({}), fetch: cloud };
  const backend = await createCloudProjectHttpBackend(transport, CLOUD_WS);
  return transferLocalKnowledge({
    env,
    cwd: repo,
    target: { workspaceId: CLOUD_WS, name: "Acme App", organizationId: ORG },
    backend: async () => backend,
    request: cloudHttp(transport),
    answer: null,
    ask: null,
    sleep: async () => {},
    ...over,
  });
}

function ctx(
  command: "setup" | "init",
  rt: CliRuntime,
  plan?: CliSetupPlan,
  json = false,
): CliCommandContext {
  const parsed = parseCliArgs([command, "--no-color", ...(json ? ["--json"] : [])], rt.env);
  return {
    command,
    args: [],
    flags: parsed.flags,
    runtime: rt,
    mode: { json, color: false, interactive: false },
    ...(plan ? { setupPlan: plan } : {}),
  };
}

const idOf = (kind: "memory" | "rule" | "skill", localId: string) =>
  transferItemId(LOCAL_WS, kind, localId, CLOUD_WS);
const state = () =>
  JSON.parse(readFileSync(transferStatePath(env, LOCAL_WS, CLOUD_WS), "utf8")) as {
    declined_at: string | null;
    items: Record<string, { status: string; code?: string }>;
  };

beforeEach(() => {
  // realpath: macOS hands out /var/... for a directory that lives at /private/var/...
  root = realpathSync(mkdtempSync(join(tmpdir(), "pr-transfer-")));
  home = join(root, ".pathrule");
  repo = join(root, "repo");
  mkdirSync(join(home, "intelligence"), { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(home, ".cli-update-check"), new Date().toISOString(), "utf8");
  writeFileSync(join(home, "intelligence", ".cli-offered"), new Date().toISOString(), "utf8");
  env = {
    PATHRULE_HOME: home,
    HOME: root,
    PATHRULE_DAEMON_AUTOSTART: "0",
    PATHRULE_NATIVE_CLOUD_URL: BASE,
    PATHRULE_NATIVE_DEVICE_CLIENT_ID: "pathrule-cli-test",
  };
  cloudStore = new LocalBackend(":memory:");
  writes = [];
  offersTransfer = true;
  usage = roomyUsage();
  refuse = null;
  cloudWorkspaces = [];
});
afterEach(() => {
  cloudStore.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("copying a folder's Local knowledge to Pathrule Cloud", () => {
  it("says what would leave, what is kept and lost, and what does not fit, before anything leaves", async () => {
    await localStore(async (b) => {
      await b.writeMemory({
        workspaceId: LOCAL_WS,
        nodeId: (await b.ensureNodeForPath(LOCAL_WS, "/docs")).id,
        title: "Design archive",
        content: "x".repeat(6000),
      });
    });
    await cloudFolder();
    usage = { ...roomyUsage(), item_max_bytes: 4096, nodes: { used: 98, limit: 100 } };
    const out = (await transfer())!;
    expect(out.data.status).toBe("approval_required");
    expect(writes).toEqual([]);
    const preview = out.data.preview!;
    expect(preview.counts).toEqual({ memories: 3, rules: 1, skills: 1, total: 5 });
    expect(preview.target).toEqual({
      workspace_id: CLOUD_WS,
      workspace_name: "Acme App",
      organization_id: ORG,
      organization_name: "Acme",
    });
    expect(preview.source).toEqual({
      local_workspace_id: LOCAL_WS,
      name: "repo-local",
      root: repo,
    });
    expect(preview.kept.join(" ")).toContain("rule priority, scope and constraint atoms");
    expect(preview.lost_or_changed).toEqual(
      expect.arrayContaining([
        expect.stringContaining("records you as the author"),
        expect.stringContaining("restart at 1.0.0"),
        expect.stringContaining("Remedy evidence and private session content are not copied"),
        expect.stringContaining("Local search vectors are not copied"),
        expect.stringContaining("pathrule activity import --from-local"),
      ]),
    );
    // Vectors as the Cloud indexes: one per placement and per folder above it.
    // memory /apps/web + /packages/payments: 5 + 2; memory /: 2; rule /apps/web: 4; skill /: 2.
    expect(preview.limits!.vectors).toMatchObject({ needed: 15, free: 990, fits: true });
    // /, /apps, /apps/web, /packages, /packages/payments; the Cloud workspace has no node yet.
    expect(preview.limits!.nodes).toMatchObject({
      needed: 5,
      free: 2,
      fits: false,
      upper_bound: false,
    });
    expect(preview.does_not_fit).toEqual(["Nodes: 5 new nodes needed, 2 free."]);
    expect(preview.cannot_copy).toEqual([
      expect.objectContaining({
        kind: "memory",
        title: "Design archive",
        reason: "item_too_large",
      }),
    ]);
    const text = out.lines.join("\n");
    expect(text).toContain('To: "Acme App" in "Acme"');
    expect(text).toContain("3 memories, 1 rule, 1 skill (5 items");
    expect(text).toContain(
      'Cannot be copied (never shortened to fit):\n  - memory "Design archive": 6.1 KB, the limit is 4.1 KB',
    );
    expect(text).toContain("Does not fit, so the copy would stop when the plan is full:");
    expect(text).toContain(
      `Nothing was copied: copying needs your approval, and nothing could ask here. To copy: ${TRANSFER_COMMAND}`,
    );
    expect(out.exitCode).toBe(0);
    expect(out.next).toEqual([expect.objectContaining({ command: TRANSFER_COMMAND })]);
  });

  it("refuses to copy, and says so, where the workspace's Cloud does not take copies", async () => {
    await localStore();
    await cloudFolder();
    offersTransfer = false;
    let asked = false;
    const quiet = (await transfer({
      ask: async () => {
        asked = true;
        return true;
      },
    }))!;
    expect(asked).toBe(false);
    expect(quiet.data.status).toBe("unavailable");
    expect(quiet.exitCode).toBe(0);
    expect(quiet.lines.at(-1)).toContain("Pathrule Cloud does not take copies of Local knowledge");
    const asking = (await transfer({ answer: true }))!;
    expect(asking.data.status).toBe("unavailable");
    expect(asking.exitCode).toBe(1);
    expect(writes).toEqual([]);
  });

  it("gives each copy an id derived from the item, the source and the target", async () => {
    const id = transferItemId(LOCAL_WS, "memory", "m-1", CLOUD_WS);
    expect(id).toBe(transferItemId(LOCAL_WS, "memory", "m-1", CLOUD_WS));
    expect(id).toMatch(/^lt_[A-Za-z0-9_-]{37}$/);
    expect(transferItemId(LOCAL_WS, "rule", "m-1", CLOUD_WS)).not.toBe(id);
    expect(transferItemId(LOCAL_WS, "memory", "m-1", "another-cloud-ws")).not.toBe(id);

    await localStore();
    await cloudFolder();
    await transfer({ answer: true });
    expect(writes.map((w) => w.input.id).sort()).toEqual(
      [
        idOf("memory", local.m1),
        idOf("memory", local.m2),
        idOf("rule", local.rule),
        idOf("skill", local.skill),
      ].sort(),
    );
  });

  it("copies everything on a yes, create-only and with each item's origin, and says all of it is there", async () => {
    await localStore();
    await cloudFolder();
    const before = localSnapshot();
    const out = (await transfer({ answer: true }))!;
    expect(out.exitCode).toBe(0);
    expect(out.data.status).toBe("copied");
    expect(out.lines).toContain('Copied 4 of 4 to "Acme App".');
    expect(out.lines).toContain(
      "All 4 items of this folder's Local knowledge are on Pathrule Cloud.",
    );
    expect(
      writes.every((w) => w.input.ifAbsent === true && w.input.origin.kind === "local-transfer"),
    ).toBe(true);
    const skill = writes.find((w) => w.op === "writeSkill")!.input;
    expect(skill.origin).toMatchObject({
      sourceVersion: "2.3.0",
      sourceCreatedAt: expect.any(String),
    });
    expect(skill).toMatchObject({
      tags: ["release", "checklist"],
      source: "github_ref",
      description: "What to verify before a release",
    });
    const rule = await cloudStore.readRule(idOf("rule", local.rule));
    expect(rule).toMatchObject({ priority: "high", scopeType: "folder" });
    expect(rule!.constraints).toEqual([
      expect.objectContaining({ id: "c-cursor", mode: "forbid" }),
    ]);
    expect((await cloudStore.getNodeForRule(rule!.id))!.relativePath).toBe("/apps/web");
    const memory = await cloudStore.readMemory(idOf("memory", local.m1));
    expect((await cloudStore.getNode(memory!.nodeId))!.relativePath).toBe("/apps/web");
    expect(writes.find((w) => w.input.id === memory!.id)!.input.relatedPaths).toEqual([
      "/packages/payments",
    ]);
    // The Local store is exactly as it was: rows and content.
    expect(localSnapshot()).toBe(before);
  });

  it("copies nothing twice and overwrites nothing on a second run, with or without its record", async () => {
    await localStore();
    await cloudFolder();
    await transfer({ answer: true });
    const first = writes.length;
    // Someone edits a copy on Cloud before the next run.
    const copy = (await cloudStore.readMemory(idOf("memory", local.m1)))!;
    await cloudStore.updateMemory({ id: copy.id, content: "Edited on Cloud." });

    const again = (await transfer({ answer: true }))!;
    expect(again.data.status).toBe("copied");
    expect(writes).toHaveLength(first);

    // Even with the record gone, every write is create-only: what is there stays as it is.
    rmSync(transferStatePath(env, LOCAL_WS, CLOUD_WS));
    await transfer({ answer: true });
    expect(writes.slice(first).every((w) => w.input.ifAbsent === true)).toBe(true);
    expect((await cloudStore.readMemory(copy.id))!.content).toBe("Edited on Cloud.");
    expect(await cloudStore.listMemories({ workspaceId: CLOUD_WS })).toHaveLength(2);
  });

  it("stops at a full plan, says what was not attempted, keeps the record, and resumes on a yes", async () => {
    await localStore();
    await cloudFolder();
    refuse = (_op, _input, taken) =>
      taken >= 2
        ? {
            status: 402,
            body: { error: "Your organization's storage is full", code: "storage_quota_reached" },
          }
        : null;
    const out = (await transfer({ answer: true }))!;
    expect(out.exitCode).toBe(1);
    expect(out.data.status).toBe("incomplete");
    expect(out.data.result).toMatchObject({ total: 4, copied: 2, copied_now: 2 });
    expect(out.data.result!.failed).toEqual([
      expect.objectContaining({ code: "storage_quota_reached" }),
    ]);
    expect(out.data.result!.not_attempted).toHaveLength(1);
    const text = out.lines.join("\n");
    expect(text).toContain('Copied 2 of 4 to "Acme App".');
    expect(text).toContain(
      "Not attempted (1): the copy stopped at storage_quota_reached: Your organization's storage is full",
    );
    expect(text).toContain("To copy what is missing: pathrule setup --cloud");
    expect(text).not.toContain("All 4 items");
    expect(writes).toHaveLength(2);
    const saved = state();
    expect(
      Object.values(saved.items)
        .map((i) => i.status)
        .sort(),
    ).toEqual(["copied", "copied", "failed", "not_attempted"]);
    if (process.platform !== "win32") expect(statSync(transferStatePath(env, LOCAL_WS, CLOUD_WS)).mode & 0o777).toBe(0o600);

    refuse = null;
    let question = "";
    const resumed = (await transfer({
      ask: async (q) => {
        question = q;
        return true;
      },
    }))!;
    expect(question).toBe('Continue copying the 2 items not yet on Pathrule Cloud to "Acme App"?');
    expect(resumed.data.result).toMatchObject({ total: 4, copied: 4, copied_now: 2 });
    expect(resumed.lines).toContain('Copied 4 of 4 to "Acme App" (2 in this run).');
    expect(writes).toHaveLength(4);
    expect(new Set(writes.map((w) => w.input.id)).size).toBe(4);
  });

  it("never shortens an item over a limit: it is listed, not sent, and the rest is copied whole", async () => {
    await localStore(async (b) => {
      await b.writeMemory({
        workspaceId: LOCAL_WS,
        nodeId: (await b.ensureNodeForPath(LOCAL_WS, "/docs")).id,
        title: "Design archive",
        content: "x".repeat(6000),
      });
    });
    await cloudFolder();
    usage = { ...roomyUsage(), item_max_bytes: 4096 };
    const out = (await transfer({ answer: true }))!;
    expect(out.exitCode).toBe(1);
    expect(out.data.result).toMatchObject({ total: 5, copied: 4 });
    expect(out.data.result!.too_large).toEqual([
      expect.objectContaining({ title: "Design archive", code: "item_too_large" }),
    ]);
    expect(writes.some((w) => w.input.title === "Design archive")).toBe(false);
    expect(out.lines.join("\n")).toContain(
      "Cannot be copied, over a limit (1); nothing was shortened:",
    );
    expect((await cloudStore.readMemory(idOf("memory", local.m1)))!.content).toBe(
      "The checkout posts to /api/pay and retries twice.",
    );
  });

  it("remembers a no and does not ask again until --transfer", async () => {
    await localStore();
    await cloudFolder();
    let asked = 0;
    let shown: readonly string[] = [];
    const no = (await transfer({
      ask: async (question, preview) => {
        asked += 1;
        shown = preview;
        expect(question).toBe('Copy these 4 items to "Acme App"?');
        return false;
      },
    }))!;
    expect(no.data.status).toBe("declined");
    expect(shown.join("\n")).toContain("1 rule, 1 skill (4 items");
    expect(no.lines).toEqual([
      `Nothing was copied, and you will not be asked again. To copy it later: ${TRANSFER_COMMAND}`,
    ]);
    expect(state().declined_at).toEqual(expect.any(String));

    const later = (await transfer({
      ask: async () => {
        asked += 1;
        return true;
      },
    }))!;
    expect(asked).toBe(1);
    expect(later.data.status).toBe("declined_earlier");
    expect(later.lines[0]).toContain(TRANSFER_COMMAND);
    expect(writes).toEqual([]);

    const yes = (await transfer({ answer: true }))!;
    expect(yes.data.status).toBe("copied");
    expect(state().declined_at).toBeNull();
  });

  it("records --no-transfer as a no, and copies nothing where nothing can ask", async () => {
    await localStore();
    await cloudFolder();
    const notice = (await transfer())!;
    expect(notice.data.status).toBe("approval_required");
    expect(notice.exitCode).toBe(0);
    expect(writes).toEqual([]);
    const skipped = (await transfer({ answer: false }))!;
    expect(skipped.data.status).toBe("declined");
    expect(skipped.lines[0]).toContain("--no-transfer");
    expect(state().declined_at).toEqual(expect.any(String));
    expect(writes).toEqual([]);
  });

  it("says how to finish when a person at a terminal declines to sign in", async () => {
    const rt = runtime(new MemoryWriter(), "n");
    const terminal = ctx("setup", rt, {
      from: "local",
      scope: "project",
      transfer: null,
      target: null,
    });
    terminal.mode = { ...terminal.mode, interactive: true };
    expect(await renderNative(terminal)).toBe(1);
    expect(String(rt.stderr)).toBe(
      "[error] Not signed in, so the Pathrule Cloud setup of this folder did not run.\nNext: pathrule login\nNext: pathrule setup --cloud\n",
    );
  });

  it("has nothing to do for a folder with no Local workspace", async () => {
    await cloudFolder();
    expect(await transfer({ answer: true })).toBeNull();
  });
});

describe("pathrule setup and init on Pathrule Cloud", () => {
  const run = (argv: string[], rt: CliRuntime) =>
    runOpenCli(argv, rt, { plugins: [cloudCliPlugin()] });

  beforeEach(async () => {
    expect(await run(["login", "--no-color"], runtime())).toBe(0);
    // The folder's own name: setup attaches the person's one workspace of that name.
    cloudWorkspaces = [{ id: CLOUD_WS, organization_id: ORG, name: "repo" }];
  });

  it("setup attaches the workspace of the folder's name, writes the MCP entries, copies on --transfer, then syncs", async () => {
    await localStore();
    recordFolderChoice(env, repo, "cloud", "setup");
    const stdout = new MemoryWriter();
    const code = await renderNative(
      ctx("setup", runtime(stdout), {
        from: "local",
        scope: "project",
        transfer: true,
        target: "claude",
      }),
    );
    const text = stdout.toString();
    expect(code).toBe(0);
    expect(text).toContain(
      `Attached ${repo} to your existing workspace "repo" in "Acme": it has this folder's name, and no other folder on this machine uses it (undo: pathrule detach).`,
    );
    expect(text).toMatch(/\[ok\] claude-code: MCP entry installed \(.+\)/);
    expect(text).toContain('Copied 4 of 4 to "repo".');
    const claude = JSON.parse(readFileSync(join(root, ".claude.json"), "utf8"));
    expect(claude.mcpServers.pathrule.args.slice(-2)).toEqual(["mcp", "run"]);
    // The copy ran before the sync: the hook index the sync wrote carries the copied memory.
    const index = readFileSync(join(home, "cache", CLOUD_WS, "hook-index.json"), "utf8");
    expect(index).toContain(idOf("memory", local.m1));
  });

  it("asks a person at a terminal after showing what setup did and the preview", async () => {
    await localStore();
    recordFolderChoice(env, repo, "cloud", "setup");
    const stdout = new MemoryWriter();
    const prompts: string[] = [];
    const rt: CliRuntime = {
      ...runtime(stdout),
      promptLine: async (prompt) => {
        prompts.push(prompt);
        // Everything before the question is on screen when it is asked.
        expect(stdout.toString()).toContain("Kept: Paths and related paths");
        return "y";
      },
    };
    const terminal = {
      ...ctx("setup", rt, { from: "local", scope: "project", transfer: null, target: "claude" }),
    };
    terminal.mode = { ...terminal.mode, interactive: true };
    expect(await renderNative(terminal)).toBe(0);
    expect(prompts).toEqual(['Copy these 4 items to "repo"? [y/N]: ']);
    const text = stdout.toString();
    const order = [
      "[ok] Attached",
      "claude-code: MCP entry installed",
      "can be copied to Pathrule Cloud",
      "Copied 4 of 4",
    ].map((s) => text.indexOf(s));
    expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!))).toBe(true);
    expect(text.match(/\[ok\] Attached/g)).toHaveLength(1);
  });

  it("init sets up the workspace and the copy notice, and writes no MCP entry", async () => {
    await localStore();
    recordFolderChoice(env, repo, "cloud", "init");
    const result = await jsonNative(ctx("init", runtime(), undefined, true));
    expect(result.exitCode).toBe(0);
    const data = result.envelope.data as Record<string, any>;
    expect(data).not.toHaveProperty("mcp");
    expect(data.action).toBe("attached");
    expect(data.transfer.status).toBe("approval_required");
    expect(data.transfer.preview.counts).toEqual({ memories: 2, rules: 1, skills: 1, total: 4 });
    expect(() => statSync(join(root, ".claude.json"))).toThrow();
    expect(writes).toEqual([]);
  });
});
