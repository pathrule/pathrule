// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  actionEdition,
  editionScopeItems,
  editionStep,
  scopeChangesFolder,
} from "../onboarding/edition.js";
import { onboardingItems } from "../onboarding/items.js";

const base = {
  folderName: "acme-shop",
  cloudAvailable: true,
  hasSession: false,
  localAvailable: true,
  orgName: null,
  attachCandidates: [],
};

describe("onboardingItems (design spec §4.2)", () => {
  it("signed out → sign-in-create + local, in that order", () => {
    const items = onboardingItems(base);
    expect(items.map((i) => i.action.kind)).toEqual(["sign-in-create", "init-local"]);
    expect(items[1]?.label).toContain("no account");
  });

  it("signed in with org → create + local + switch-org", () => {
    const items = onboardingItems({ ...base, hasSession: true, orgName: "Atolye15" });
    expect(items.map((i) => i.action.kind)).toEqual(["create-cloud", "init-local", "switch-org"]);
    expect(items[0]?.label).toBe('Create "acme-shop" in Atolye15');
    expect(items[0]?.description).toBe("recommended");
  });

  it("existing workspace matches outrank creation (bind-don't-duplicate)", () => {
    const items = onboardingItems({
      ...base,
      hasSession: true,
      orgName: "Atolye15",
      attachCandidates: [{ selector: "ws-1", name: "acme-shop" }],
    });
    expect(items[0]?.action).toEqual({ kind: "attach", selector: "ws-1", name: "acme-shop" });
    // Create loses its "recommended" badge when an attach candidate exists.
    expect(items[1]?.description).toBeUndefined();
  });

  it("local unavailable (sqlite ABI) → no local item, signed-out still has a path", () => {
    const items = onboardingItems({ ...base, localAvailable: false });
    expect(items.map((i) => i.action.kind)).toEqual(["sign-in-create"]);
  });

  it("a build without Pathrule Cloud offers local mode only, with no upgrade pitch", () => {
    const items = onboardingItems({ ...base, cloudAvailable: false });
    expect(items.map((i) => i.action.kind)).toEqual(["init-local"]);
    expect(items[0]?.label).toContain("no account");
    expect(items[0]?.detail).not.toMatch(/upgrade|team/i);
  });

  it("a build without Pathrule Cloud ignores a session and offers nothing it cannot run", () => {
    expect(
      onboardingItems({
        ...base,
        cloudAvailable: false,
        hasSession: true,
        orgName: "Atolye15",
        attachCandidates: [{ selector: "ws-1", name: "acme-shop" }],
      }).map((i) => i.action.kind),
    ).toEqual(["init-local"]);
    expect(onboardingItems({ ...base, cloudAvailable: false, localAvailable: false })).toEqual([]);
  });
});

describe("changing a folder's edition: exactly two scopes", () => {
  it("asks nothing when the pick is the folder's edition, and asks for a scope when it is not", () => {
    expect(editionStep("cloud", "cloud")).toBe("same");
    expect(editionStep("local", "local")).toBe("same");
    expect(editionStep("cloud", "local")).toBe("ask-scope");
    expect(editionStep("local", "cloud")).toBe("ask-scope");
    // A folder in conflict is settled for this folder: a device default would not settle it.
    expect(editionStep(null, "local")).toBe("record-project");
  });

  it("offers this project first, then the device default for new projects, and nothing else", () => {
    const items = editionScopeItems("local", "acme-shop");
    expect(items.map((i) => [i.scope, i.label])).toEqual([
      ["project", "This project only (recommended)"],
      ["device", "Device default (new projects only)"],
    ]);
    expect(items[0]?.detail).toContain("Only acme-shop uses Pathrule Local");
    // Choosing a scope never approves a data transfer.
    for (const item of items) expect(item.detail).toContain("nothing is copied");
  });

  it("the device default changes only a folder that follows it, never one already set up", () => {
    expect(scopeChangesFolder("device-default", "device")).toBe(true);
    expect(scopeChangesFolder("project", "device")).toBe(false);
    expect(scopeChangesFolder("workspace", "device")).toBe(false);
    for (const source of ["device-default", "project", "workspace"] as const) {
      expect(scopeChangesFolder(source, "project")).toBe(true);
    }
  });

  it("knows the edition each setup action sets up", () => {
    expect(actionEdition({ kind: "create-cloud" })).toBe("cloud");
    expect(actionEdition({ kind: "attach", selector: "ws-1", name: "acme" })).toBe("cloud");
    expect(actionEdition({ kind: "sign-in-create" })).toBe("cloud");
    expect(actionEdition({ kind: "init-local" })).toBe("local");
    expect(actionEdition({ kind: "switch-org" })).toBeNull();
  });
});
