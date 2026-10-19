// SPDX-License-Identifier: Apache-2.0
// A folder no workspace covers is the first error a new user meets, and the agent
// relays its remedy word for word. The remedy must be a step every composition of
// this server has (the CLI, or the VS Code command), not the desktop app.

import { removeScratch } from "./scratch.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalBackend } from "@pathrule/core";
import { getContextTool } from "../tools/get-context.js";
import { bindFolderStep, resolveWorkspaceTarget } from "../tools/helpers.js";
import { resetLocalBackends } from "../local-runtime.js";

afterEach(async () => {
  await resetLocalBackends();
});

describe("bindFolderStep", () => {
  it("names a local workspace on the local store", () => {
    const step = bindFolderStep(false);
    expect(step).toContain("`pathrule init --local`");
    expect(step).toContain("Pathrule: Set Up Workspace");
    expect(step).not.toMatch(/Pathrule app/);
  });

  it("names attaching to an account workspace under an account", () => {
    const step = bindFolderStep(true);
    expect(step).toContain("`pathrule attach`");
    expect(step).toContain("Pathrule: Connect Existing Workspace");
    expect(step).not.toMatch(/Pathrule app/);
  });
});

describe("an unbound folder on the local store", () => {
  it("get_context and a write's target resolution both name `pathrule init --local`", async () => {
    const home = mkdtempSync(join(tmpdir(), "pathrule-bind-home-"));
    const bound = mkdtempSync(join(tmpdir(), "pathrule-bind-root-"));
    const folder = mkdtempSync(join(tmpdir(), "pathrule-bind-folder-"));
    const saved = {
      home: process.env.PATHRULE_HOME,
      local: process.env.PATHRULE_LOCAL,
      cwd: process.cwd(),
    };
    try {
      process.env.PATHRULE_HOME = home;
      process.env.PATHRULE_LOCAL = "1";
      // The server runs inside a workspace of this home; the agent asks about a
      // folder no workspace covers.
      process.chdir(bound);
      LocalBackend.openForWorkspace("ws-bound", process.env).registerWorkspace({
        workspaceId: "ws-bound",
        name: "bound",
        localRootPath: process.cwd(),
      });

      const context = (await getContextTool.handler({ cwd: folder } as never)) as {
        ok?: boolean;
        error?: { code: string; message: string };
      };
      expect(context.ok).toBe(false);
      expect(context.error?.code).toBe("not_found");
      expect(context.error?.message).toContain("`pathrule init --local`");
      expect(context.error?.message).not.toMatch(/Pathrule app/);

      const target = await resolveWorkspaceTarget({ cwd: folder });
      expect(target.ok).toBe(false);
      if (!target.ok) {
        expect(target.error.message).toContain("`pathrule init --local`");
        expect(target.error.message).not.toMatch(/Pathrule app/);
      }
    } finally {
      process.chdir(saved.cwd);
      if (saved.home === undefined) delete process.env.PATHRULE_HOME;
      else process.env.PATHRULE_HOME = saved.home;
      if (saved.local === undefined) delete process.env.PATHRULE_LOCAL;
      else process.env.PATHRULE_LOCAL = saved.local;
      removeScratch(home);
      removeScratch(bound);
      removeScratch(folder);
    }
  });
});
