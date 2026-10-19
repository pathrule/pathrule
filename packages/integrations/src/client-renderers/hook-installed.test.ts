// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { HOOK_CONFIG_LOCATIONS, configInstallsPathruleHook } from "./hook-installed.js";

const withHook = JSON.stringify({
  hooks: {
    UserPromptSubmit: [
      { hooks: [{ type: "command", command: "/Users/x/.pathrule/bin/pathrule-hook.js" }] },
    ],
  },
});

describe("configInstallsPathruleHook", () => {
  it("recognises an installed hook regardless of where the script lives", () => {
    expect(configInstallsPathruleHook(withHook)).toBe(true);
    expect(
      configInstallsPathruleHook(
        JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "C:\\p\\pathrule-hook.js" }] }] } }),
      ),
    ).toBe(true);
  });

  it("says no for a settings file with hooks that are not ours", () => {
    expect(
      configInstallsPathruleHook(JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "./notify.sh" }] }] } })),
    ).toBe(false);
  });

  // Every one of these guesses "not installed", and that direction is deliberate:
  // a wrong "installed" removes the protocol from disk with nothing replacing it.
  it("says no for empty, malformed, or hook-less input", () => {
    for (const body of [
      "",
      "   ",
      "not json",
      "{",
      "null",
      "[]",
      JSON.stringify({}),
      JSON.stringify({ hooks: null }),
      JSON.stringify({ hooks: {} }),
      JSON.stringify({ permissions: { allow: ["pathrule-hook"] } }),
    ]) {
      expect(configInstallsPathruleHook(body), `body=${body}`).toBe(false);
    }
  });

  it("does not count the script name appearing outside the hooks block", () => {
    expect(
      configInstallsPathruleHook(JSON.stringify({ comment: "we removed pathrule-hook", hooks: {} })),
    ).toBe(false);
  });

  it("offers no location for a client Pathrule cannot install a hook for", () => {
    expect(HOOK_CONFIG_LOCATIONS.windsurf).toEqual([]);
    for (const id of ["claude-code", "codex", "cursor", "copilot"] as const) {
      expect(HOOK_CONFIG_LOCATIONS[id].length).toBeGreaterThan(0);
    }
  });
});

// The disk reader lives with the other Node-only detection (skills/disk-detection.ts);
// its contract is tested here, next to the rule it applies.
describe("detectInstalledHooks", () => {
  it("reports a project-level install, a user-level install, and neither", async () => {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { detectInstalledHooks } = await import("../skills/disk-detection.js");

    const root = await mkdtemp(join(tmpdir(), "pathrule-hookdetect-"));
    const home = await mkdtemp(join(tmpdir(), "pathrule-hookhome-"));

    // Nothing installed yet.
    expect(await detectInstalledHooks(root, { home })).toEqual([]);

    // Project-level codex hook.
    await mkdir(join(root, ".codex"), { recursive: true });
    await writeFile(join(root, ".codex", "hooks.json"), withHook);
    expect(await detectInstalledHooks(root, { home })).toEqual(["codex"]);

    // User-level Claude hook counts too.
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), withHook);
    expect((await detectInstalledHooks(root, { home })).sort()).toEqual(["claude-code", "codex"]);

    // A config present but hook-less does not count.
    await mkdir(join(root, ".cursor"), { recursive: true });
    await writeFile(join(root, ".cursor", "hooks.json"), JSON.stringify({ hooks: {} }));
    expect((await detectInstalledHooks(root, { home })).sort()).toEqual(["claude-code", "codex"]);
  });

  it("never reports windsurf, which has no hook builder", async () => {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { detectInstalledHooks } = await import("../skills/disk-detection.js");

    const root = await mkdtemp(join(tmpdir(), "pathrule-hookws-"));
    const home = await mkdtemp(join(tmpdir(), "pathrule-hookwshome-"));
    await mkdir(join(root, ".windsurf"), { recursive: true });
    await writeFile(join(root, ".windsurf", "hooks.json"), withHook);
    expect(await detectInstalledHooks(root, { home })).toEqual([]);
  });
});
