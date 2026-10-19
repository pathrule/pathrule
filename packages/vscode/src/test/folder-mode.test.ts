// SPDX-License-Identifier: Apache-2.0
// Where the extension records a person's choice of edition, in a scratch home: the folder's own
// choice (this project only), and the device default for new projects, written with the CLI's own
// selection reader and writer. The device default never changes a folder that is set up.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readDeviceDefault,
  readFolderChoices,
  resolveFolderMode,
} from "@pathrule/core/workspace/folder-mode.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readFolderMode,
  recordProjectEdition,
  writeDeviceDefault,
} from "../binding/folder-mode.js";

let root: string;
let env: NodeJS.ProcessEnv;
const noLocal = () => null;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pathrule-vscode-edition-")));
  env = { PATHRULE_HOME: join(root, ".pathrule"), HOME: root };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("recording a choice of edition", () => {
  it("this project only: the folder's own choice, recorded as made in VS Code", async () => {
    const project = join(root, "project");
    mkdirSync(project);
    await recordProjectEdition(env, project, "local");
    expect(readFolderChoices(env)).toEqual([
      expect.objectContaining({ root: project, mode: "local", via: "vscode" }),
    ]);
    expect(
      (
        await readFolderMode(project, env, {
          cloudAvailable: true,
          localAvailable: true,
          discoverLocal: noLocal,
        })
      ).mode,
    ).toBe("local");
    // The device default is untouched.
    expect(readDeviceDefault(env, { cloudAvailable: true })).toEqual({
      mode: "cloud",
      source: "new-install",
    });
  });

  it("device default: new projects follow it, a folder already set up keeps its edition", async () => {
    const chosen = join(root, "chosen");
    const fresh = join(root, "fresh");
    mkdirSync(chosen);
    mkdirSync(fresh);
    await recordProjectEdition(env, chosen, "cloud");
    await writeDeviceDefault(env, "local");
    expect(readDeviceDefault(env, { cloudAvailable: true })).toEqual({
      mode: "local",
      source: "chosen",
    });
    const options = { cloudAvailable: true, discoverLocal: noLocal };
    expect(resolveFolderMode(fresh, env, options)).toMatchObject({
      mode: "local",
      source: "device-default",
    });
    expect(resolveFolderMode(chosen, env, options)).toMatchObject({
      mode: "cloud",
      source: "project",
    });
    expect(readFolderChoices(env)).toHaveLength(1);
  });

  it("device default changes only `setup`: the capabilities the CLI loads stay as chosen", async () => {
    const selection = join(root, ".pathrule", "capabilities", "selection.json");
    mkdirSync(join(root, ".pathrule", "capabilities"), { recursive: true });
    writeFileSync(
      selection,
      JSON.stringify({
        schema: 1,
        capabilities: ["cloud"],
        setup: "cloud",
        source: "onboarding",
        updatedAt: "",
      }),
    );
    await writeDeviceDefault(env, "local");
    expect(JSON.parse(readFileSync(selection, "utf8"))).toMatchObject({
      schema: 1,
      capabilities: ["cloud"],
      setup: "local",
      source: "onboarding",
    });
  });
});
