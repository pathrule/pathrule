// SPDX-License-Identifier: Apache-2.0
// `pathrule activity import --from-local`: it says what would leave before anything does, sends only
// the folder's own Local entries with workspace-relative paths, in bounded batches, copies nothing
// twice, stops when the organization's storage is full, and undoes only on request.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { runCli as runOpenCli, type CliRuntime } from "@pathrule/cli/run.js";
import { LocalBackend } from "@pathrule/core/backend/local/local-backend.js";
import { recordFolderChoice } from "@pathrule/core/workspace/folder-mode.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { attachNativeWorkspace } from "../native/workspaces.js";
import { hasLocalActivity } from "./commands/activity-import.js";
import { cloudCliPlugin } from "./plugin.js";

const BASE = "https://cloud.example.test";
const TOKEN = "native-session-token.signature";
const USER = "user-1";
const CLOUD_WS = "c1c1c1c1-0000-4000-8000-000000000001";
const LOCAL_WS = "5af08c07-b6c4-4ab9-89fe-298e59220650";
const IMPORT = `${BASE}/v1/workspaces/${CLOUD_WS}/activity/import`;
/** Entries start three days ago, well inside the 180 days Pathrule Cloud keeps. */
const START = Date.now() - 3 * 86_400_000;
const DAY = new Date(START).toISOString().slice(0, 10);

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

let root: string;
let home: string;
let repo: string;
let calls: { url: string; method: string; body: any }[];
let stored: Set<string>;
let storageFullAfter: number | null;

/** Pathrule Cloud as the CLI meets it: sign-in, identity and the import route. */
const cloud = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  calls.push({ url, method, body });
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  if (url === `${BASE}/api/auth/device/code`)
    return json({
      device_code: "device-1",
      user_code: "WXYZ2345",
      verification_uri: `${BASE}/device`,
      verification_uri_complete: `${BASE}/device?user_code=WXYZ2345`,
      interval: 1,
      expires_in: 600,
    });
  if (url === `${BASE}/api/auth/device/token`)
    return json({ access_token: TOKEN, token_type: "Bearer" });
  if (url === `${BASE}/api/auth/get-session`)
    return json({
      session: { expiresAt: "2026-12-20T00:00:00.000Z" },
      user: { id: USER, email: "person@example.invalid" },
    });
  if (url === `${BASE}/v1/me/identity`) return json({ userId: USER });
  if (url === IMPORT && method === "DELETE") {
    const deleted = stored.size;
    stored.clear();
    return json({ deleted });
  }
  if (url === IMPORT && method === "POST") {
    const result = {
      imported: 0,
      already_present: 0,
      skipped: { too_old: 0, invalid: 0 },
      storage_full: false,
    };
    for (const entry of body.entries as { source_id: string }[]) {
      if (stored.has(entry.source_id)) {
        result.already_present += 1;
        continue;
      }
      if (storageFullAfter !== null && stored.size >= storageFullAfter) {
        result.storage_full = true;
        break;
      }
      stored.add(entry.source_id);
      result.imported += 1;
    }
    return json(result);
  }
  return json({ error: "not a Pathrule Cloud route" }, 404);
}) as typeof fetch;

function runtime(
  stdout = new MemoryWriter(),
  stderr = new MemoryWriter(),
  cwd = repo,
  answer?: string,
): CliRuntime {
  return {
    cwd,
    env: {
      PATHRULE_HOME: home,
      PATHRULE_DAEMON_AUTOSTART: "0",
      PATHRULE_NATIVE_CLOUD_URL: BASE,
      PATHRULE_NATIVE_DEVICE_CLIENT_ID: "pathrule-cli-test",
    },
    stdout,
    stderr,
    fetch: cloud,
    sleep: async () => {},
    openUrl: async () => {},
    ...(answer === undefined ? {} : { promptLine: async () => answer }),
  };
}
const run = (argv: string[], rt: CliRuntime) =>
  runOpenCli(argv, rt, { plugins: [cloudCliPlugin()] });
const imports = () => calls.filter((c) => c.url === IMPORT);

/** A Local store for `repo` holding `count` entries, plus one entry of another workspace id. */
function localStore(count: number): void {
  const backend = LocalBackend.openForWorkspace(LOCAL_WS, { PATHRULE_HOME: home });
  try {
    backend.registerWorkspace({ workspaceId: LOCAL_WS, localRootPath: repo });
  } finally {
    backend.close();
  }
  const db = new Database(join(home, LOCAL_WS, "pathrule.db"));
  try {
    const insert = db.prepare(
      "INSERT INTO activity_logs(id, workspace_id, node_path, domain, action, scope, subjects, task_summary, files_touched, ai_client, created_at, provenance) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    const start = START;
    for (let i = 0; i < count; i += 1)
      insert.run(
        `local-${String(i).padStart(4, "0")}`,
        LOCAL_WS,
        "/packages/intelligence-engine",
        "docs",
        "create",
        "project",
        JSON.stringify(["plan"]),
        `Entry ${i}`,
        JSON.stringify({
          total: 2,
          by_area: { src: [join(repo, "src", `a${i}.ts`), "/Users/someone-else/notes.txt"] },
        }),
        "codex",
        new Date(start + i * 60_000).toISOString(),
        null,
      );
    insert.run(
      "foreign-1",
      "467b0e6e-dec5-46a6-bd5e-4294a82603d6",
      "/",
      "docs",
      "create",
      "project",
      "[]",
      "Another workspace's entry",
      "[]",
      "codex",
      new Date(start).toISOString(),
      null,
    );
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  // realpath: macOS hands out /var/... for a directory that lives at /private/var/...
  root = realpathSync(mkdtempSync(join(tmpdir(), "pathrule-activity-import-")));
  home = join(root, ".pathrule");
  repo = join(root, "repo");
  mkdirSync(join(home, "intelligence"), { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(home, ".cli-update-check"), new Date().toISOString(), "utf8");
  writeFileSync(join(home, "intelligence", ".cli-offered"), new Date().toISOString(), "utf8");
  calls = [];
  stored = new Set();
  storageFullAfter = null;
  expect(await run(["login", "--no-color"], runtime())).toBe(0);
  await attachNativeWorkspace(
    USER,
    { workspace_id: CLOUD_WS, organization_id: "org-1", name: "Pathrule", root: repo },
    { PATHRULE_HOME: home } as NodeJS.ProcessEnv,
  );
  // The folder moved from Pathrule Local to Pathrule Cloud (`pathrule setup --cloud`): its Local
  // workspace stays on this machine, unused, and its activity is what this command copies.
  recordFolderChoice({ PATHRULE_HOME: home } as NodeJS.ProcessEnv, repo, "cloud", "setup");
  calls = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

describe("pathrule activity import --from-local", () => {
  it("says what would leave on --dry-run and sends nothing", async () => {
    localStore(3);
    const stdout = new MemoryWriter();
    expect(
      await run(["activity", "import", "--from-local", "--dry-run", "--no-color"], runtime(stdout)),
    ).toBe(0);
    expect(stdout.toString()).toContain(
      `3 Local entries from ${DAY} to ${new Date(START + 120_000).toISOString().slice(0, 10)} can be copied to "Pathrule".`,
    );
    expect(stdout.toString()).toContain("Leaves this machine: the summary, folder, subjects");
    expect(stdout.toString()).toContain("pathrule activity import --from-local --yes");
    expect(imports()).toEqual([]);
  });

  it("sends only the folder's entries, workspace-relative, in batches of at most 50", async () => {
    localStore(120);
    const stdout = new MemoryWriter();
    expect(
      await run(["activity", "import", "--from-local", "--yes", "--no-color"], runtime(stdout)),
    ).toBe(0);
    expect(stdout.toString()).toContain(
      'Copied 120 Local entries to "Pathrule" (0 already there, 0 too old, 0 unreadable).',
    );
    expect(imports().map((c) => c.body.entries.length)).toEqual([50, 50, 20]);
    const sent = imports().flatMap((c) => c.body.entries);
    expect(imports().every((c) => c.body.source.workspace_id === LOCAL_WS)).toBe(true);
    expect(sent.map((e: { source_id: string }) => e.source_id)).not.toContain("foreign-1");
    expect(sent[0]).toEqual({
      source_id: "local-0000",
      created_at: new Date(START).toISOString(),
      node_path: "/packages/intelligence-engine",
      domain: "docs",
      action: "create",
      scope: "project",
      subjects: ["plan"],
      task_summary: "Entry 0",
      files_touched: { total: 1, by_area: { src: ["src/a0.ts"] } },
      ai_client: "codex",
    });
    expect(JSON.stringify(sent)).not.toContain(root);
  });

  it("copies nothing twice when run again", async () => {
    localStore(4);
    await run(["activity", "import", "--from-local", "--yes"], runtime());
    const stdout = new MemoryWriter();
    expect(
      await run(["activity", "import", "--from-local", "--yes", "--no-color"], runtime(stdout)),
    ).toBe(0);
    expect(stdout.toString()).toContain("Copied 0 Local entries");
    expect(stdout.toString()).toContain("(4 already there");
    expect(stored.size).toBe(4);
  });

  it("stops when the organization's storage is full, and says how to finish", async () => {
    localStore(60);
    storageFullAfter = 30;
    const json = new MemoryWriter();
    expect(
      await run(["activity", "import", "--from-local", "--yes", "--json"], runtime(json)),
    ).toBe(1);
    expect(JSON.parse(json.toString())).toMatchObject({
      ok: false,
      data: { imported: 30, storage_full: true, entries: 60 },
    });
    expect(imports()).toHaveLength(1);
  });

  it("asks before sending, and sends nothing on a no", async () => {
    localStore(2);
    const stdout = new MemoryWriter();
    expect(
      await run(
        ["activity", "import", "--from-local", "--no-color"],
        runtime(stdout, new MemoryWriter(), repo, "n"),
      ),
    ).toBe(0);
    expect(stdout.toString()).toContain("2 Local entries from");
    expect(stdout.toString()).toContain("Nothing was copied.");
    expect(imports()).toEqual([]);
  });

  it("needs --yes where nothing can ask", async () => {
    localStore(2);
    const json = new MemoryWriter();
    expect(await run(["activity", "import", "--from-local", "--json"], runtime(json))).toBe(1);
    expect(JSON.parse(json.toString())).toMatchObject({
      ok: false,
      error: { code: "confirmation_required" },
    });
    expect(imports()).toEqual([]);
  });

  it("undoes the copy on request", async () => {
    localStore(3);
    await run(["activity", "import", "--from-local", "--yes"], runtime());
    const stdout = new MemoryWriter();
    expect(
      await run(
        ["activity", "import", "--from-local", "--undo", "--yes", "--no-color"],
        runtime(stdout),
      ),
    ).toBe(0);
    expect(stdout.toString()).toContain('Removed 3 Local entries copied to "Pathrule".');
    expect(imports().at(-1)).toMatchObject({
      method: "DELETE",
      body: { source: { kind: "local", workspace_id: LOCAL_WS } },
    });
  });

  it("refuses a folder with no attachment, and a wrong command line", async () => {
    localStore(1);
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    const stderr = new MemoryWriter();
    expect(
      await run(
        ["activity", "import", "--from-local", "--yes", "--no-color"],
        runtime(new MemoryWriter(), stderr, elsewhere),
      ),
    ).toBe(1);
    expect(stderr.toString()).toContain("not attached to a Pathrule Cloud workspace");
    const usage = new MemoryWriter();
    expect(
      await run(
        ["activity", "import", "--days", "400", "--from-local"],
        runtime(new MemoryWriter(), usage),
      ),
    ).toBe(1);
    expect(usage.toString()).toContain("Usage: pathrule activity import --from-local");
    expect(imports()).toEqual([]);
  });

  it("offers the import after attaching only where Local activity exists", () => {
    const env = { PATHRULE_HOME: home } as NodeJS.ProcessEnv;
    expect(hasLocalActivity(repo, env)).toBe(false);
    localStore(1);
    expect(hasLocalActivity(repo, env)).toBe(true);
    expect(hasLocalActivity(join(root, "elsewhere"), env)).toBe(false);
  });
});
