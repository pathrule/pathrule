// SPDX-License-Identifier: Apache-2.0
// `pathrule instrument events` with Pathrule Cloud installed. Until 2026-10-18 the account's
// `events` threw "Signals ingest on Pathrule Cloud is paused" for every folder, so a CLI with Cloud
// could not read even a local workspace's events. Until 2026-10-19 any folder the signed-in person
// had not attached read Pathrule Local, a Cloud folder signed out included. The folder's edition
// decides now (core's resolveFolderMode): a Local folder reads Pathrule Local, a Cloud folder reads
// the Cloud's groups (project-backend-runtime-events.test.ts) or says why it cannot, never Local.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseCliArgs } from "@pathrule/cli/args.js";
import { initLocalWorkspace } from "@pathrule/cli/local/init-local.js";
import type { CliCommandContext } from "@pathrule/cli/plugin.js";
import { LocalBackend } from "@pathrule/core";
import { recordFolderChoice, resolveFolderMode } from "@pathrule/core/workspace/folder-mode.js";

import { attachNativeWorkspace } from "../native/workspaces.js";
import { cloudCliPlugin } from "./plugin.js";

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

const tmps: string[] = [];
afterEach(() => {
  for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A home with a Cloud the build names and nobody signed in, and a project folder with a Local workspace holding events. */
async function shopWithLocalEvents() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pathrule-cloud-instrument-")));
  tmps.push(home);
  const env = {
    PATHRULE_HOME: home,
    PATHRULE_LOCAL_PRINCIPAL: "tester",
    PATHRULE_NATIVE_CLOUD_URL: "https://cloud.example",
    PATHRULE_NATIVE_DEVICE_CLIENT_ID: "pathrule-cli-test",
  } as NodeJS.ProcessEnv;
  const cwd = join(home, "shop");
  mkdirSync(cwd);
  const { workspaceId } = await initLocalWorkspace({ cwd, env, genWorkspaceId: () => "ws-shop" });
  const store = LocalBackend.openForWorkspace(workspaceId, env);
  await store.ingestRuntimeEvents(workspaceId, {
    schemaVersion: 1,
    id: "e1",
    environment: "development",
    release: "0.3.0",
    items: [
      { type: "signal", kind: "error", fingerprint: "fp-cart", countDelta: 2, node: "/cart" },
    ],
  });
  store.close();
  return { env, cwd };
}

/** The account's own `events`, as the open `instrument` command hands it a run. */
async function events(env: NodeJS.ProcessEnv, cwd: string, json = false) {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const subcommand = cloudCliPlugin().subcommands!.instrument!.events!;
  const argv = ["instrument", "events", json ? "--json" : "--no-color"];
  const ctx = {
    command: "instrument",
    args: ["events"],
    flags: parseCliArgs(argv, env).flags,
    runtime: { cwd, env, stdout, stderr },
    mode: { json, color: false, interactive: false, noOpen: true },
  } as unknown as CliCommandContext;
  if (json) {
    const result = await subcommand.json!(ctx);
    return {
      exitCode: result.exitCode,
      envelope: result.envelope as unknown as Record<string, unknown>,
    };
  }
  const exitCode = await subcommand.run(ctx);
  return { exitCode, stdout: stdout.toString(), stderr: stderr.toString() };
}

describe("pathrule instrument events with Pathrule Cloud installed", () => {
  it("reads a local workspace's events in a folder that uses Pathrule Local", async () => {
    const { env, cwd } = await shopWithLocalEvents();
    expect(resolveFolderMode(cwd, env, { cloudAvailable: true })).toMatchObject({
      mode: "local",
      local: { workspaceId: "ws-shop" },
    });
    const run = await events(env, cwd);
    expect(run.stderr).not.toContain("paused");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("Runtime events (local, workspace ws-shop)");
    expect(run.stdout).toContain("2 occurrence(s)");
  });

  it("refuses a Cloud folder signed out, never answering with the Local store kept there", async () => {
    const { env, cwd } = await shopWithLocalEvents();
    recordFolderChoice(env, cwd, "cloud", "setup");
    expect(resolveFolderMode(cwd, env, { cloudAvailable: true })).toMatchObject({
      mode: "cloud",
      dormant: { local: { workspaceId: "ws-shop" } },
    });
    const run = await events(env, cwd);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(
      "This folder uses Pathrule Cloud, and Pathrule CLI is not signed in.",
    );
    expect(run.stderr).toContain("pathrule login");
    const json = await events(env, cwd, true);
    expect(json.exitCode).toBe(1);
    expect(json.envelope).toMatchObject({ ok: false, error: { code: "not_signed_in" } });
    expect(JSON.stringify(json.envelope)).not.toContain("fp-cart");
  });

  it("refuses a folder with both editions and no choice, asking the person to choose", async () => {
    const { env, cwd } = await shopWithLocalEvents();
    await attachNativeWorkspace(
      "person-1",
      { workspace_id: "ws-cloud", organization_id: "org-1", name: "Shop", root: cwd },
      env,
    );
    const run = await events(env, cwd);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(
      `${cwd} has both a Pathrule Local workspace and a Pathrule Cloud workspace, and no choice between them.`,
    );
    expect(run.stderr).toContain("pathrule setup --cloud");
    const json = await events(env, cwd, true);
    expect(json.envelope).toMatchObject({ ok: false, error: { code: "folder_conflict" } });
  });
});
