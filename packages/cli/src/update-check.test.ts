// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  cliComponent,
  offline,
  release,
  serving,
  signedBody,
  testManifest,
  trustTestReleaseKey,
} from "@pathrule/core/release/__fixtures__/signed-manifest.js";
import { readUpdateState, updateUpdateState } from "@pathrule/core/release/update-state.js";

import {
  checkCliUpdate,
  cliUpdateNotice,
  isNewerVersion,
  pendingCliUpdateNotice,
  recordNoticeShown,
} from "./update-check.js";
import { planCliUpdate } from "./updates/cli-update.js";
import { detectInstallMethod } from "./updates/install-method.js";

const GLOBAL = "/usr/local/lib/node_modules/@pathrule/cli/dist/index.js";
const NOW = new Date("2026-10-13T12:00:00Z");

const body = (version = "1.0.1", extra: { minimum?: string; sequence?: number } = {}) =>
  signedBody(
    testManifest(
      {
        cli: cliComponent(
          { npm: { latest: release(version) }, homebrew: { latest: release("1.0.0") } },
          extra.minimum ? { minimum_version: extra.minimum } : {},
        ),
      },
      { sequence: extra.sequence ?? 1 },
    ),
  );

let untrust: () => void;
beforeAll(() => {
  untrust = trustTestReleaseKey();
});
afterAll(() => untrust());

let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pathrule-update-check-"));
  env = { PATHRULE_HOME: home };
});
afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const npmInstall = () => detectInstallMethod({ entry: GLOBAL, env, platform: "linux" });

describe("checking for a CLI update on request", () => {
  it("reports the verified release of the install's own channel", async () => {
    const { result } = await checkCliUpdate("1.0.0", env, serving(body()), {
      install: npmInstall(),
      now: () => NOW,
    });
    expect(result).toMatchObject({
      checked: true,
      source: "network",
      current_version: "1.0.0",
      latest_version: "1.0.1",
      status: "update_available",
      update_available: true,
      install_method: "npm-global",
      upgrade_command: "npm install -g @pathrule/cli@1.0.1",
      runnable: true,
      url: "https://releases.pathrule.io/v1/manifest.json",
    });
  });

  it("checks even under update.policy manual: manual only stops automatic checks", async () => {
    const calls: string[] = [];
    const { result } = await checkCliUpdate(
      "1.0.0",
      { ...env, PATHRULE_UPDATE_POLICY: "manual" },
      serving(body(), calls),
      {
        install: npmInstall(),
        now: () => NOW,
      },
    );
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ policy: "notify", update_available: true });
  });

  it("asks nothing of the network when updates are disabled", async () => {
    const calls: string[] = [];
    const { result } = await checkCliUpdate(
      "1.0.0",
      { ...env, PATHRULE_DISABLE_UPDATES: "1" },
      serving(body(), calls),
      {
        install: npmInstall(),
      },
    );
    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ checked: false, reason: "disabled", update_available: false });
  });

  it("answers from the last verified manifest when offline, and says so", async () => {
    await checkCliUpdate("1.0.0", env, serving(body()), { install: npmInstall(), now: () => NOW });
    const { result } = await checkCliUpdate("1.0.0", env, offline, {
      install: npmInstall(),
      now: () => NOW,
    });
    expect(result).toMatchObject({
      checked: false,
      source: "cache",
      reason: "offline",
      latest_version: "1.0.1",
    });
  });

  it("knows nothing offline without a previous check, without throwing", async () => {
    const { result } = await checkCliUpdate("1.0.0", env, offline, {
      install: npmInstall(),
      now: () => NOW,
    });
    expect(result).toMatchObject({
      checked: false,
      source: null,
      reason: "offline",
      status: "unknown",
      update_available: false,
    });
  });

  it("does not offer a Homebrew install what only npm has published", async () => {
    const brew = detectInstallMethod({
      entry: "/opt/homebrew/Cellar/pathrule/1.0.0/libexec/dist/index.js",
      env,
      platform: "darwin",
    });
    const { result } = await checkCliUpdate("1.0.0", env, serving(body()), {
      install: brew,
      now: () => NOW,
    });
    expect(result).toMatchObject({ status: "up_to_date", update_available: false });
  });

  it("ignores a manipulated manifest and keeps what it verified before", async () => {
    await checkCliUpdate("1.0.0", env, serving(body("1.0.1", { sequence: 2 })), {
      install: npmInstall(),
      now: () => NOW,
    });
    const tampered = JSON.parse(body("1.0.1", { sequence: 3 }));
    tampered.signed.components.cli.channels.npm.latest.version = "9.9.9";
    const { result } = await checkCliUpdate("1.0.0", env, serving(JSON.stringify(tampered)), {
      install: npmInstall(),
      now: () => NOW,
    });
    expect(result).toMatchObject({
      source: "cache",
      reason: "bad_signature",
      latest_version: "1.0.1",
    });
  });
});

describe("the update notice", () => {
  const planFor = async (version = "1.0.1", current = "1.0.0", extra: { minimum?: string } = {}) =>
    (
      await checkCliUpdate(current, env, serving(body(version, extra)), {
        install: npmInstall(),
        now: () => NOW,
      })
    ).plan;

  it("under automatic, a confirmed npm install says nothing until it is installed", async () => {
    expect(
      cliUpdateNotice(await planFor(), readUpdateState(env), "1.0.0", NOW, "automatic"),
    ).toBeNull();
  });

  it("says what is available and how to get it", async () => {
    const notice = cliUpdateNotice(await planFor(), readUpdateState(env), "1.0.0", NOW, "notify");
    expect(notice?.lines).toEqual([
      "Pathrule 1.0.1 is available. You're using 1.0.0.",
      "Run: pathrule update",
    ]);
  });

  it("is shown once a day per version, and again for a newer version", async () => {
    const plan = await planFor();
    const first = cliUpdateNotice(plan, readUpdateState(env), "1.0.0", NOW, "notify")!;
    recordNoticeShown(env, first, NOW);
    expect(
      cliUpdateNotice(
        plan,
        readUpdateState(env),
        "1.0.0",
        new Date(NOW.getTime() + 3_600_000),
        "notify",
      ),
    ).toBeNull();
    expect(
      cliUpdateNotice(
        plan,
        readUpdateState(env),
        "1.0.0",
        new Date(NOW.getTime() + 25 * 3_600_000),
        "notify",
      ),
    ).not.toBeNull();
    const newer = await planFor("1.0.2");
    expect(
      cliUpdateNotice(
        newer,
        readUpdateState(env),
        "1.0.0",
        new Date(NOW.getTime() + 3_600_000),
        "notify",
      )?.version,
    ).toBe("1.0.2");
  });

  it("says a compatibility update is required below the minimum", async () => {
    const notice = cliUpdateNotice(
      await planFor("1.2.0", "1.0.0", { minimum: "1.1.0" }),
      readUpdateState(env),
      "1.0.0",
      NOW,
    );
    expect(notice?.lines[0]).toBe(
      "Your Pathrule CLI and MCP server are outdated. Update them to continue using the latest Cloud capabilities.",
    );
  });

  it("is silent when up to date or ahead", async () => {
    expect(
      cliUpdateNotice(await planFor("1.0.0"), readUpdateState(env), "1.0.0", NOW, "notify"),
    ).toBeNull();
    expect(
      cliUpdateNotice(
        await planFor("1.0.0", "1.1.0"),
        readUpdateState(env),
        "1.1.0",
        NOW,
        "notify",
      ),
    ).toBeNull();
  });

  it("gives an install something else updates the right next step, never `pathrule update`", () => {
    const plan = planCliUpdate({
      manifest: testManifest({ cli: cliComponent({ npm: { latest: release("1.0.1") } }) }),
      install: detectInstallMethod({
        entry: "/home/a/.npm/_npx/1/node_modules/@pathrule/cli/dist/index.js",
        env,
        platform: "linux",
      }),
      current: "1.0.0",
      track: "latest",
    });
    expect(cliUpdateNotice(plan, readUpdateState(env), "1.0.0", NOW, "notify")?.lines[1]).toBe(
      "npx keeps reusing the copy in its cache unless you name a version: use npx @pathrule/cli@1.0.1.",
    );
  });

  it("announces an automatic update once, from the new version", () => {
    updateUpdateState(env, (s) => ({
      ...s,
      installed: {
        component: "cli",
        from: "1.0.0",
        to: "1.0.1",
        at: NOW.toISOString(),
        by: "auto",
      },
    }));
    const notice = pendingCliUpdateNotice("1.0.1", env, { now: NOW });
    expect(notice?.lines).toEqual([
      "Pathrule has been updated to 1.0.1. Restart your session to activate the new version.",
    ]);
    recordNoticeShown(env, notice!, NOW);
    expect(pendingCliUpdateNotice("1.0.1", env, { now: NOW })).toBeNull();
  });

  it("reads nothing but the disk, and hedges for an install it cannot place", async () => {
    await planFor();
    // No fetch is passed here: the notice comes from the verified manifest on disk. The running
    // entry is the test runner, which no package manager owns, so no command is claimed.
    expect(pendingCliUpdateNotice("1.0.0", env, { now: NOW })?.lines).toEqual([
      "Pathrule 1.0.1 is available. You're using 1.0.0.",
      "Pathrule could not tell how this copy was installed; update it with the tool you installed it with (with npm: npm install -g @pathrule/cli@1.0.1).",
    ]);
  });
});

describe("isNewerVersion", () => {
  it("never calls a downgrade newer", () => {
    expect(isNewerVersion("0.0.11", "0.3.2")).toBe(false);
    expect(isNewerVersion("0.10.0", "0.9.0")).toBe(true);
    expect(isNewerVersion("latest", "0.3.2")).toBe(false);
  });
});
