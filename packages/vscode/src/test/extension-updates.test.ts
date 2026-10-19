// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { parseReleaseManifest, type ReleaseManifest } from "@pathrule/protocol/release-manifest.js";

import {
  autoUpdateSetting,
  extensionDistribution,
  extensionUpdateView,
  noticeShownRecently,
  pendingRestartVersion,
} from "../updates/extension-updates.js";

const verified = (version: string) => ({
  version,
  published_at: "2026-10-13T09:00:00Z",
  verified_at: "2026-10-13T09:10:00Z",
});

function manifest(extra: Record<string, unknown> = {}): ReleaseManifest {
  const parsed = parseReleaseManifest({
    schema_version: 1,
    sequence: 3,
    generated_at: "2026-10-13T10:00:00Z",
    expires_at: "2027-04-11T10:00:00Z",
    components: {
      vscode: {
        restart: "restart-extensions",
        channels: {
          "vscode-marketplace": { latest: verified("0.9.0") },
          // The Open VSX publish failed this round: it still holds the previous verified release.
          "open-vsx": { latest: verified("0.8.0") },
        },
        ...extra,
      },
    },
  });
  if (!parsed.ok) throw new Error(parsed.detail);
  return parsed.manifest;
}

const base = { version: "0.8.0", cliVersion: "1.0.0", appName: "Visual Studio Code" };

describe("which marketplace this editor installs from", () => {
  it("is the VS Code Marketplace for VS Code, Open VSX for its forks", () => {
    expect(extensionDistribution("Visual Studio Code")).toBe("vscode-marketplace");
    expect(extensionDistribution("Visual Studio Code - Insiders")).toBe("vscode-marketplace");
    expect(extensionDistribution("VSCodium")).toBe("open-vsx");
    expect(extensionDistribution("Cursor")).toBe("open-vsx");
    expect(extensionDistribution("Windsurf")).toBe("open-vsx");
  });

  it("reads the editor's extensions.autoUpdate", () => {
    expect(autoUpdateSetting(true)).toBe("on");
    expect(autoUpdateSetting(undefined)).toBe("on");
    expect(autoUpdateSetting("onlyEnabledExtensions")).toBe("on");
    expect(autoUpdateSetting("onlySelectedExtensions")).toBe("selected");
    expect(autoUpdateSetting(false)).toBe("off");
  });
});

describe("the extension's update view", () => {
  it("leaves an available update to the editor when it updates extensions itself", () => {
    const view = extensionUpdateView({ ...base, manifest: manifest(), autoUpdate: "on" });
    expect(view).toMatchObject({ status: "update_available", latest: "0.9.0", notice: null });
    expect(view.summary).toBe(
      "0.8.0 · CLI 1.0.0 · VS Code Marketplace · editor updates on · Pathrule Automatic · latest 0.9.0",
    );
  });

  it("points to the editor's update page when automatic updates are off", () => {
    const view = extensionUpdateView({ ...base, manifest: manifest(), autoUpdate: "off" });
    expect(view.notice).toEqual({
      key: "vscode:update_available",
      version: "0.9.0",
      message: "Pathrule 0.9.0 is available. You're using 0.8.0.",
      actions: ["update"],
    });
  });

  it("does not offer Open VSX users a release Open VSX has not verifiably published", () => {
    const view = extensionUpdateView({
      ...base,
      appName: "VSCodium",
      manifest: manifest(),
      autoUpdate: "off",
    });
    expect(view).toMatchObject({ distribution: "open-vsx", status: "up_to_date", notice: null });
  });

  it("requires an update below the minimum, and offers Restart Extensions when the editor may hold it already", () => {
    const view = extensionUpdateView({
      ...base,
      manifest: manifest({ minimum_version: "0.9.0" }),
      autoUpdate: "on",
    });
    expect(view.status).toBe("update_required");
    expect(view.notice).toMatchObject({
      message:
        "Your Pathrule extension is outdated. Update it to continue using the latest Cloud capabilities.",
      actions: ["restartExtensions", "update"],
    });
  });

  it("knows nothing without a verified manifest, and says nothing", () => {
    expect(extensionUpdateView({ ...base, manifest: null, autoUpdate: "off" })).toMatchObject({
      status: "unknown",
      notice: null,
      latest: null,
    });
  });
});

describe("notice repetition", () => {
  const notice = { key: "vscode:update_available", version: "0.9.0" };
  const now = new Date("2026-10-13T12:00:00Z");
  it("shows a version's notice once a day", () => {
    expect(noticeShownRecently(undefined, notice, now)).toBe(false);
    expect(noticeShownRecently({ ...notice, at: "2026-10-13T08:00:00Z" }, notice, now)).toBe(true);
    expect(noticeShownRecently({ ...notice, at: "2026-10-12T08:00:00Z" }, notice, now)).toBe(false);
    expect(
      noticeShownRecently({ ...notice, version: "0.8.5", at: "2026-10-13T08:00:00Z" }, notice, now),
    ).toBe(false);
  });
});

describe("Pathrule's policy beside the editor's", () => {
  it("under Notify only, says the editor installs it anyway when its automatic updates are on", () => {
    const view = extensionUpdateView({
      ...base,
      manifest: manifest(),
      autoUpdate: "on",
      policy: "notify",
    });
    expect(view.notice).toMatchObject({
      key: "vscode:host_updates",
      actions: ["update"],
      message:
        "Pathrule 0.9.0 is available. Your editor updates extensions automatically, so Notify only cannot hold it back. Turn off automatic updates for Pathrule in the Extensions view to choose when it updates.",
    });
  });

  it("under either policy with the editor's updates off, only points at the editor's update page", () => {
    for (const policy of ["automatic", "notify"] as const) {
      expect(
        extensionUpdateView({ ...base, manifest: manifest(), autoUpdate: "off", policy }).notice,
      ).toMatchObject({ key: "vscode:update_available", actions: ["update"] });
    }
  });
});

describe("an update the editor installed and that waits for a restart", () => {
  it("finds the newer installed folder, whatever its platform suffix, and skips obsolete ones", () => {
    const folders = [
      "pathrule.pathrule-vscode-0.8.0-darwin-arm64",
      "pathrule.pathrule-vscode-0.9.0-darwin-arm64",
      "pathrule.pathrule-vscode-0.10.0",
      "other.ext-9.9.9",
      ".obsolete",
    ];
    expect(pendingRestartVersion(folders, new Set(), "0.8.0")).toBe("0.10.0");
    expect(
      pendingRestartVersion(folders, new Set(["pathrule.pathrule-vscode-0.10.0"]), "0.8.0"),
    ).toBe("0.9.0");
    expect(
      pendingRestartVersion(["pathrule.pathrule-vscode-0.8.0-win32-x64"], new Set(), "0.8.0"),
    ).toBeNull();
  });

  it("asks for Restart Extensions before anything else", () => {
    const view = extensionUpdateView({
      ...base,
      manifest: manifest({ minimum_version: "0.9.0" }),
      autoUpdate: "on",
      pendingRestart: "0.9.0",
    });
    expect(view.notice).toEqual({
      key: "vscode:restart",
      version: "0.9.0",
      message: "Pathrule 0.9.0 has been installed. Restart Extensions to activate it.",
      actions: ["restartExtensions"],
    });
  });
});
