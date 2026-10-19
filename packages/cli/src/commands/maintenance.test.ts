// SPDX-License-Identifier: Apache-2.0
// `pathrule index refresh` and `pathrule learning drain` on a real local workspace: the index is
// written again from the store with its framing kept, and a folder that is not a local workspace is
// left alone without an error.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../run.js";

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

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function cli(env: NodeJS.ProcessEnv, cwd: string, argv: string[]) {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const code = await runCli(argv, { cwd, env, stdout, stderr });
  return { code, json: stdout.toString() ? JSON.parse(stdout.toString()) : null, stderr: stderr.toString() };
}

describe("hook-triggered maintenance commands", () => {
  it("refresh the index of a local workspace and keep its framing; skip a folder that is not one", async () => {
    const root = await mkdtemp(join(tmpdir(), "pathrule-maintenance-"));
    roots.push(root);
    const project = join(root, "project");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "CLAUDE.md"), "# Demo\n\nSessions expire after one hour.\n");
    const env: NodeJS.ProcessEnv = { HOME: root, PATHRULE_HOME: join(root, ".pathrule"), NODE_ENV: "test" };

    const init = await cli(env, project, ["init", "--local", "--json"]);
    expect(init.code).toBe(0);
    const workspaceId = init.json.data.workspace_id ?? init.json.data.workspaceId;
    expect(typeof workspaceId).toBe("string");
    const indexPath = join(root, ".pathrule", "cache", workspaceId, "hook-index.json");
    const before = JSON.parse(await readFile(indexPath, "utf8"));
    // Framing a sync decided, which a refresh must carry rather than drop.
    await writeFile(indexPath, JSON.stringify({ ...before, protocol: "PROTOCOL_KEPT", generated_at: "2020-01-01T00:00:00.000Z" }));

    const refreshed = await cli(env, project, ["index", "refresh", "--workspace", workspaceId, "--json"]);
    expect(refreshed.code).toBe(0);
    const after = JSON.parse(await readFile(indexPath, "utf8"));
    expect(after.protocol).toBe("PROTOCOL_KEPT");
    expect(after.generated_at > "2020-01-01").toBe(true);

    const drained = await cli(env, project, ["learning", "drain", "--workspace", workspaceId, "--json"]);
    expect(drained.code).toBe(0);
    expect(drained.json.data).toMatchObject({ workspace_id: workspaceId, observed: 0 });

    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    const skipped = await cli(env, elsewhere, ["index", "refresh", "--json"]);
    expect(skipped.code).toBe(0);
    expect(skipped.json.data.skipped).toBe("no_local_workspace");
  }, 60_000);
});
