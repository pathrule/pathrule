// SPDX-License-Identifier: Apache-2.0
// Copy-register invariants (design skill rules 2 & 6) + status bar model.

import { describe, expect, it } from "vitest";

import type { BoundFolder, UnboundFolder } from "../binding/types.js";
import { icons } from "../ui/icons.js";
import { deliveryTooltipLines, displayPath, statusBarModel } from "../ui/status-text.js";
import { strings } from "../ui/strings.js";

function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "function") {
    // Sample the factories with representative args.
    out.push(String((value as (...a: never[]) => string)(...(["x", "y", "z"] as never[]))));
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) allStrings(v, out);
  }
  return out;
}

describe("copy register", () => {
  const samples = allStrings(strings);

  it("no exclamation marks anywhere", () => {
    for (const s of samples) expect(s).not.toContain("!");
  });

  it("no em dashes anywhere (owner rule)", () => {
    for (const s of samples) expect(s).not.toContain("—");
  });

  it("no em dashes in shipped copy surfaces: manifest, walkthroughs, README (owner rule)", async () => {
    const { readFile, readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const root = join(__dirname, "..", "..");
    const files = [
      join(root, "README.md"),
      ...(await readdir(join(root, "resources", "walkthrough"))).map((f) =>
        join(root, "resources", "walkthrough", f),
      ),
    ];
    for (const file of files) {
      expect((await readFile(file, "utf8")).includes("—"), file).toBe(false);
    }
    // Manifest: only user-facing copy fields (descriptions, titles, welcome contents).
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const copy: string[] = [];
    const walk = (v: unknown, keyHint: string): void => {
      if (typeof v === "string") {
        if (/description|title|contents|label|displayName/i.test(keyHint)) copy.push(v);
      } else if (Array.isArray(v)) v.forEach((item) => walk(item, keyHint));
      else if (v && typeof v === "object") {
        for (const [k, val] of Object.entries(v)) walk(val, k);
      }
    };
    walk(pkg, "");
    for (const s of copy) expect(s, s).not.toContain("—");
  });

  it('internal term "node" never reaches UI copy', () => {
    for (const s of samples) expect(s.toLowerCase()).not.toMatch(/\bnodes?\b/);
  });

  it("icons are codicon names (lowercase, dashes only)", () => {
    for (const name of Object.values(icons)) expect(name).toMatch(/^[a-z][a-z-]*$/);
  });
});

describe("statusBarModel", () => {
  const bound: BoundFolder = {
    kind: "cloud",
    backend: {} as BoundFolder["backend"],
    workspaceId: "ws",
    workspaceName: "Acme",
    localRootPath: "/repo",
    relativePath: "/apps/web",
  };

  it("null binding → resolving state", () => {
    expect(statusBarModel(null, null, null).text).toContain("Pathrule…");
  });

  const unbound = (
    over: Partial<UnboundFolder> & Pick<UnboundFolder, "reason">,
  ): UnboundFolder => ({
    kind: "unbound",
    mode: "cloud",
    hasSession: false,
    localAvailable: true,
    ...over,
  });

  it("a folder not set up → set up CTA wired to pathrule.setUp, naming its edition", () => {
    const m = statusBarModel(unbound({ reason: "not-set-up", mode: "local" }), null, null);
    expect(m.text).toContain("Set up");
    expect(m.tooltip).toContain("Pathrule Local");
    expect(m.command).toBe("pathrule.setUp");
  });

  it("a Cloud folder not set up, signed in elsewhere → one-click connect", () => {
    const m = statusBarModel(
      unbound({ reason: "not-set-up", canAdopt: true, adoptAccount: "ada@example.com" }),
      null,
      null,
    );
    expect(m.text).toContain("Connect as ada@example.com");
    expect(m.command).toBe("pathrule.connectExisting");
  });

  it("a Cloud folder signed out → sign in, naming its workspace, never Local", () => {
    const m = statusBarModel(
      unbound({ reason: "signed-out", cloudWorkspace: { id: "ws", name: "Acme" } }),
      null,
      null,
    );
    expect(m.text).toContain("Sign in");
    expect(m.tooltip).toContain('"Acme"');
    expect(m.command).toBe("pathrule.signIn");
  });

  it("a folder in conflict shows the conflict sentence and asks to choose", () => {
    const message = "/repo has both a Pathrule Local workspace and a Pathrule Cloud workspace.";
    const m = statusBarModel(
      unbound({ reason: "conflict", mode: null, conflict: { root: "/repo", message } }),
      null,
      null,
    );
    expect(m.text).toContain("Choose Cloud or Local");
    expect(m.tooltip).toBe(message);
    expect(m.command).toBe("pathrule.setUp");
  });

  it("every other reason says what is wrong and leads to setup, which explains it", () => {
    for (const reason of [
      "cloud-unreachable",
      "cloud-unavailable",
      "local-unavailable",
      "failed",
    ] as const) {
      const m = statusBarModel(unbound({ reason }), null, null);
      expect(m.text).not.toContain("Set up");
      expect(m.tooltip.length).toBeGreaterThan(0);
      expect(m.command).toBe("pathrule.setUp");
    }
  });

  it("a Cloud folder that did not open names why: offline, no access, or a Cloud error", () => {
    const seen = new Set<string>();
    for (const cloudFailure of ["offline", "access-denied", "cloud-error"] as const) {
      const m = statusBarModel(unbound({ reason: "cloud-unreachable", cloudFailure }), null, null);
      seen.add(m.text);
      seen.add(m.tooltip);
      expect(m.command).toBe("pathrule.setUp");
    }
    expect(seen.size).toBe(6);
    const offline = statusBarModel(unbound({ reason: "cloud-unreachable", cloudFailure: "offline" }), null, null);
    expect(offline.text).toContain("Offline");
    expect(offline.tooltip).toContain("Nothing is served from Pathrule Local");
  });

  it("bound cloud shows active path without leading slash, click opens the quick menu", () => {
    const m = statusBarModel(bound, "/apps/web/checkout", "3 memories · 1 rule");
    expect(m.text).toContain("apps/web/checkout");
    expect(m.tooltip).toContain("Acme");
    expect(m.tooltip).toContain("Cloud");
    expect(m.command).toBe("pathrule.quickMenu");
  });

  it("deliveryTooltipLines caps items and reports the remainder", () => {
    const lines = deliveryTooltipLines(
      [
        { path: "/apps/web", titles: ["a", "b"] },
        { path: "", titles: ["c", "d", "e"] },
      ],
      3,
    );
    expect(lines.filter((l) => l.startsWith("- ")).length).toBe(4); // 3 items + more-line
    expect(lines.at(-1)).toContain("and 2 more");
    expect(lines.join("\n")).toContain("c · /");
  });

  it("bound local carries the local suffix", () => {
    const m = statusBarModel({ ...bound, kind: "local" }, null, null);
    expect(m.text).toContain("· local");
  });

  it("workspace root renders as /", () => {
    expect(displayPath("")).toBe("/");
    expect(displayPath("/")).toBe("/");
  });
});
