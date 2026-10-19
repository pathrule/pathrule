// SPDX-License-Identifier: Apache-2.0
// Where `pathrule ui` finds the built Local Console in each shape the CLI ships in.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { resolveUiAssetsDir, uiAssetCandidates, UI_ASSETS_ENV } from "./assets.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A folder tree with an `index.html` in each of `built`, and the module URL of `module`. */
function layout(module: string, built: string[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pr-ui-assets-")));
  roots.push(root);
  for (const dir of built) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "index.html"), "<!doctype html>");
  }
  return { root, moduleUrl: pathToFileURL(join(root, module)).href };
}

describe("the Local Console's assets", () => {
  it("are dist/ui beside the bundle's one file (the official CLI and its tarball)", () => {
    const { root, moduleUrl } = layout("pkg/dist/index.js", ["pkg/dist/ui"]);
    expect(uiAssetCandidates({}, moduleUrl)[0]).toBe(join(root, "pkg/dist/ui"));
    expect(resolveUiAssetsDir({}, moduleUrl)).toBe(join(root, "pkg/dist/ui"));
  });

  it("are dist/ui of the npm package, built one module per source", () => {
    const { root, moduleUrl } = layout("pkg/dist/local/ui/assets.js", ["pkg/dist/ui"]);
    expect(resolveUiAssetsDir({}, moduleUrl)).toBe(join(root, "pkg/dist/ui"));
  });

  it("are the monorepo's console build for a CLI run from its sources", () => {
    const { root, moduleUrl } = layout("packages/cli/src/local/ui/assets.ts", [
      "packages/local-console/dist",
    ]);
    const candidates = uiAssetCandidates({}, moduleUrl);
    // src is not dist: no package folder two levels up is taken for the build.
    expect(candidates).not.toContain(join(root, "packages/cli/src/ui"));
    expect(resolveUiAssetsDir({}, moduleUrl)).toBe(join(root, "packages/local-console/dist"));
  });

  it("are only the named folder when PATHRULE_UI_ASSETS is set", () => {
    const { root, moduleUrl } = layout("pkg/dist/index.js", ["pkg/dist/ui"]);
    const env = { [UI_ASSETS_ENV]: join(root, "elsewhere") };
    expect(uiAssetCandidates(env, moduleUrl)).toEqual([join(root, "elsewhere")]);
    expect(resolveUiAssetsDir(env, moduleUrl)).toBeNull();
  });

  it("are none when nothing is built", () => {
    const { moduleUrl } = layout("pkg/dist/local/ui/assets.js", []);
    expect(resolveUiAssetsDir({}, moduleUrl)).toBeNull();
  });
});
