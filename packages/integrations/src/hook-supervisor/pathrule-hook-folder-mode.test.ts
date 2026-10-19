// SPDX-License-Identifier: Apache-2.0
// One edition per folder, as the hook picks the index it delivers (core workspace/folder-mode.ts is the
// rule it mirrors), run as the real script in child processes:
//
// - the deepest folder choice (capabilities/folders.json under PATHRULE_HOME) drops the other
//   edition's indexes at or above its folder: a Cloud folder never gets a Local index, even when that
//   is the only one;
// - a nested project's index, deeper than the choice, keeps its own edition;
// - a Local and a Cloud index on one folder with no choice deliver nothing, and the session start
//   says what to run; a Cloud attachment counts as Cloud's claim even with no Cloud index here;
// - an index written before `mode` is a Cloud one when it carries the Cloud's semantic endpoint;
// - a Cloud index never spawns the Local learning drain.

import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HOOK_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const LOCAL_ID = "ws-folder-local";
const CLOUD_ID = "ws-folder-cloud";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

interface Home {
  home: string;
  /** HOME for the hook: a `~/.pathrule` the hook must not read when PATHRULE_HOME names another. */
  userHome: string;
  hook: string;
  repo: string;
}

async function makeHome(): Promise<Home> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "pathrule-folder-mode-")));
  const userHome = await realpath(await mkdtemp(join(tmpdir(), "pathrule-folder-mode-user-")));
  dirs.push(home, userHome);
  const hook = join(home, "bin", "pathrule-hook.js");
  await mkdir(dirname(hook), { recursive: true });
  await copyFile(HOOK_SOURCE, hook);
  const repo = join(home, "repo");
  await mkdir(join(repo, "packages", "app"), { recursive: true });
  return { home, userHome, hook, repo };
}

/** A hook index for `id` at `root`. `mode` undefined writes an index from before the stamp. */
async function index(
  h: Home,
  id: string,
  root: string,
  opts: { mode?: "cloud" | "local"; semantic?: boolean; generatedAt?: string } = {},
): Promise<void> {
  await mkdir(join(h.home, "cache", id), { recursive: true });
  await writeFile(
    join(h.home, "cache", id, "hook-index.json"),
    JSON.stringify({
      schema_version: 2,
      workspace_id: id,
      workspace_root: root,
      generated_at: opts.generatedAt ?? "2026-10-01T00:00:00.000Z",
      path_memories: {},
      path_rules: {},
      project_rules: [],
      ...(opts.mode ? { mode: opts.mode } : {}),
      ...(opts.semantic
        ? { cloud_semantic: { url: "https://cloud.example.test", kind: "native" } }
        : {}),
    }),
  );
}

/** The folder choices `pathrule setup` records, under `pathruleHome`. */
async function choose(
  pathruleHome: string,
  folders: Array<{ root: string; mode: "cloud" | "local" }>,
) {
  await mkdir(join(pathruleHome, "capabilities"), { recursive: true });
  await writeFile(
    join(pathruleHome, "capabilities", "folders.json"),
    JSON.stringify({
      schema: 1,
      folders: folders.map((f) => ({ ...f, set_at: "2026-10-18T00:00:00.000Z", via: "setup" })),
    }),
  );
}

function fire(h: Home, payload: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [h.hook],
      {
        env: { ...process.env, PATHRULE_HOME: h.home, HOME: h.userHome, PATHRULE_HOOK_CHANNEL: "" },
        timeout: 15_000,
      },
      (error, stdout) => {
        if (error && typeof error.code === "number" && error.code !== 0)
          reject(new Error(`hook exited ${error.code}`));
        else resolve(stdout.trim());
      },
    );
    child.stdin!.end(JSON.stringify(payload));
  });
}

/** What SessionStart in `cwd` hands the agent. */
async function sessionStart(h: Home, cwd: string): Promise<string> {
  const out = await fire(h, { hook_event_name: "SessionStart", source: "startup", cwd });
  try {
    return JSON.parse(out)?.hookSpecificOutput?.additionalContext ?? "";
  } catch {
    return "";
  }
}

/** The workspace SessionStart in `cwd` served, or null when it served none. */
async function served(h: Home, cwd: string): Promise<string | null> {
  return /workspace_id: `([^`]+)`/.exec(await sessionStart(h, cwd))?.[1] ?? null;
}

describe("the hook's index for a folder", () => {
  it("serves the chosen edition when both have an index on the folder", async () => {
    const h = await makeHome();
    await index(h, LOCAL_ID, h.repo, { mode: "local", generatedAt: "2026-10-09T00:00:00.000Z" });
    await index(h, CLOUD_ID, h.repo, { mode: "cloud" });
    await choose(h.home, [{ root: h.repo, mode: "cloud" }]);
    expect(await served(h, h.repo)).toBe(CLOUD_ID);
    expect(await served(h, join(h.repo, "packages", "app"))).toBe(CLOUD_ID);

    await choose(h.home, [{ root: h.repo, mode: "local" }]);
    expect(await served(h, h.repo)).toBe(LOCAL_ID);
  });

  it("delivers nothing to a Cloud folder that has only a Local index", async () => {
    const h = await makeHome();
    await index(h, LOCAL_ID, h.repo, { mode: "local" });
    await choose(h.home, [{ root: h.repo, mode: "cloud" }]);
    expect(await sessionStart(h, h.repo)).toBe("");
    const prompt = await fire(h, {
      hook_event_name: "UserPromptSubmit",
      cwd: h.repo,
      session_id: "s1",
      prompt: "fix it",
    });
    expect(prompt).not.toContain(LOCAL_ID);
  });

  it("delivers nothing to a folder with both editions and no choice, and says once what to run", async () => {
    const h = await makeHome();
    await index(h, LOCAL_ID, h.repo, { mode: "local" });
    await index(h, CLOUD_ID, h.repo, { mode: "cloud" });
    const said = await sessionStart(h, h.repo);
    expect(said).toBe(
      `Pathrule: ${h.repo} has both a Local and a Cloud workspace; choose one with \`pathrule setup --cloud\` or \`pathrule setup --local\`.`,
    );
    const prompt = await fire(h, {
      hook_event_name: "UserPromptSubmit",
      cwd: h.repo,
      session_id: "s1",
      prompt: "fix it",
    });
    expect(prompt).not.toContain(LOCAL_ID);
    expect(prompt).not.toContain(CLOUD_ID);
  });

  it("treats a Cloud attachment as Cloud's claim on its folder, with no Cloud index on this machine", async () => {
    const h = await makeHome();
    await index(h, LOCAL_ID, h.repo, { mode: "local" });
    // The attachment an earlier `pathrule setup --cloud` wrote (packages/cloud native/workspaces.ts).
    await mkdir(join(h.home, "config", "users", "person"), { recursive: true });
    await writeFile(
      join(h.home, "config", "users", "person", "native-workspaces.json"),
      JSON.stringify({
        schema_version: 1,
        workspaces: [{ workspace_id: CLOUD_ID, organization_id: "org", name: "acme", root: h.repo, attached_at: "2026-10-01T00:00:00.000Z" }],
      }),
    );
    // No choice: a Local workspace and a Cloud attachment on one folder are a conflict.
    expect(await sessionStart(h, h.repo)).toContain("has both a Local and a Cloud workspace");
    // Chosen Cloud: nothing is delivered, never the Local index.
    await choose(h.home, [{ root: h.repo, mode: "cloud" }]);
    expect(await sessionStart(h, h.repo)).toBe("");
    // Chosen Local: the Local index serves it.
    await choose(h.home, [{ root: h.repo, mode: "local" }]);
    expect(await served(h, h.repo)).toBe(LOCAL_ID);
  });

  it("keeps a nested project's own edition, and the deepest choice decides", async () => {
    const h = await makeHome();
    const app = join(h.repo, "packages", "app");
    const other = join(h.repo, "packages");
    await index(h, CLOUD_ID, h.repo, { mode: "cloud" });
    await index(h, LOCAL_ID, app, { mode: "local" });
    await choose(h.home, [{ root: h.repo, mode: "cloud" }]);
    // The nested project is deeper than the choice: its Local index serves it.
    expect(await served(h, app)).toBe(LOCAL_ID);
    expect(await served(h, other)).toBe(CLOUD_ID);

    // A deeper choice drops the other edition's index above it; outside it, the parent's conflict stands.
    await index(h, "ws-folder-local-root", h.repo, { mode: "local" });
    await choose(h.home, [{ root: other, mode: "local" }]);
    expect(await served(h, other)).toBe("ws-folder-local-root");
    expect(await sessionStart(h, h.repo)).toContain("has both a Local and a Cloud workspace");
  });

  it("reads an index from before `mode` by the Cloud's semantic endpoint", async () => {
    const h = await makeHome();
    await index(h, LOCAL_ID, h.repo, { generatedAt: "2026-10-09T00:00:00.000Z" });
    await index(h, CLOUD_ID, h.repo, { semantic: true });
    await choose(h.home, [{ root: h.repo, mode: "cloud" }]);
    expect(await served(h, h.repo)).toBe(CLOUD_ID);
    await choose(h.home, [{ root: h.repo, mode: "local" }]);
    expect(await served(h, h.repo)).toBe(LOCAL_ID);
  });

  it("takes the newest index when one edition has two on the folder", async () => {
    const h = await makeHome();
    await index(h, LOCAL_ID, h.repo, { mode: "local", generatedAt: "2026-10-01T00:00:00.000Z" });
    await index(h, "ws-folder-local-again", h.repo, {
      mode: "local",
      generatedAt: "2026-10-09T00:00:00.000Z",
    });
    expect(await served(h, h.repo)).toBe("ws-folder-local-again");
  });

  it("reads the choices under PATHRULE_HOME, never under ~/.pathrule", async () => {
    const h = await makeHome();
    await index(h, LOCAL_ID, h.repo, { mode: "local" });
    await index(h, CLOUD_ID, h.repo, { mode: "cloud" });
    // A choice in the default home, and the retired app's active-workspace pointer: neither counts.
    await choose(join(h.userHome, ".pathrule"), [{ root: h.repo, mode: "local" }]);
    await writeFile(
      join(h.userHome, ".pathrule", "active-workspace.json"),
      JSON.stringify({ workspace_id: LOCAL_ID }),
    );
    expect(await served(h, h.repo)).toBeNull();
    await choose(h.home, [{ root: h.repo, mode: "cloud" }]);
    expect(await served(h, h.repo)).toBe(CLOUD_ID);
  });
});

describe("hook-triggered maintenance for a Cloud index", () => {
  it("never spawns the Local learning drain or index refresh", { timeout: 20_000 }, async () => {
    const h = await makeHome();
    await index(h, CLOUD_ID, h.repo, { mode: "cloud" });
    const log = join(h.home, "maintenance.log");
    const fakeCli = join(h.home, "fake-cli.cjs");
    await writeFile(
      fakeCli,
      `require("fs").appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");`,
    );
    await writeFile(
      join(h.home, "bin", "runtime.json"),
      JSON.stringify({
        schema_version: 1,
        cli: { node: process.execPath, entry: fakeCli },
        maintenance: { consent: true },
      }),
    );
    // A store left under the Cloud id, newer than the index, and evidence waiting to drain.
    await mkdir(join(h.home, CLOUD_ID), { recursive: true });
    await writeFile(join(h.home, CLOUD_ID, "pathrule.db"), "");
    await writeFile(
      join(h.home, "cache", CLOUD_ID, "knowledge-observations.jsonl"),
      '{"sid":"s"}\n',
    );

    await fire(h, {
      hook_event_name: "SessionStart",
      source: "startup",
      cwd: h.repo,
      session_id: "s-c",
    });
    await fire(h, {
      hook_event_name: "Stop",
      cwd: h.repo,
      session_id: "s-c",
      transcript_path: join(h.home, "t.jsonl"),
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(await readFile(log, "utf8").catch(() => "")).toBe("");
    // The ended turn is still recorded: the MCP server drains it through the Project.
    expect(await readFile(join(h.home, "cache", CLOUD_ID, "ended-turns.jsonl"), "utf8")).toContain(
      "t.jsonl",
    );
  });
});
