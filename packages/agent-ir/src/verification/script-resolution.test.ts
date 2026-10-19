// SPDX-License-Identifier: Apache-2.0
// Authoring-time command resolution, and the trust boundary around it.
//
// The gap this closes was measured: `pnpm --filter @pathrule/app test:watch` was an
// acceptable CHECK requirement, and the script it names is `vitest` with no `run`, so it
// never exits and its exit code could never be evidence.
//
// The fixture below is REAL data from this repo's package.json files, transcribed. It is
// a fixture rather than a live read so the test says the same thing on a machine where
// the checkout is elsewhere.

import { describe, expect, it } from "vitest";

import {
  provenNonTerminating,
  resolveScriptCommand,
  type PackageScripts,
} from "./script-resolution.js";
import { stampProposedCheck, validateCheckInput, type CheckInput } from "../atoms/check.js";

const PACKAGES: PackageScripts[] = [
  {
    name: "pathrule",
    dir: "/",
    scripts: {
      typecheck: "pnpm -r --parallel typecheck",
      "web:prod-security": "node scripts/check-production-web-security.mjs",
      "db:test": "supabase db test",
      dev: "pnpm run mcp:build && pnpm --filter @pathrule/app dev",
      "mcp:build": "pnpm --filter @pathrule/mcp-server build",
      "release:security-gates":
        "node scripts/check-supabase-timeouts.mjs && node scripts/check-core-no-cloud-imports.mjs",
      selfref: "pnpm run selfref",
    },
  },
  { name: "@pathrule/shared", dir: "/packages/shared", scripts: { test: "vitest run", typecheck: "tsc --noEmit" } },
  {
    name: "@pathrule/app",
    dir: "/packages/app",
    scripts: {
      test: "vitest run",
      "test:watch": "vitest",
      "build-storybook": "storybook build --disable-telemetry",
      dev: "electron-forge start",
      typecheck: "tsc --noEmit && tsc --noEmit -p tsconfig.node.json",
    },
  },
  {
    name: "@pathrule/core",
    dir: "/packages/core",
    scripts: { test: "node ../../scripts/with-sqlite-native.mjs vitest run", typecheck: "tsc --noEmit" },
  },
  { name: "@pathrule/web", dir: "/packages/web", scripts: { dev: "vite --host 127.0.0.1", build: "vite build" } },
  { name: "@pathrule/mcp-server", dir: "/packages/mcp-server", scripts: { build: "tsup" } },
];

const resolve = (command: string) => resolveScriptCommand(command, PACKAGES);

describe("provenNonTerminating", () => {
  it("proves the forms it can and stays silent on the rest", () => {
    expect(provenNonTerminating("vitest")).toContain('watches unless given "run"');
    expect(provenNonTerminating("vitest run")).toBeNull();
    expect(provenNonTerminating("vitest --run")).toBeNull();
    expect(provenNonTerminating("jest --watch")).toContain("never exits");
    expect(provenNonTerminating("electron-forge start")).toContain("long-running server");
    expect(provenNonTerminating("vite --host 127.0.0.1")).toContain("long-running server");
    expect(provenNonTerminating("vite build")).toBeNull();
    expect(provenNonTerminating("CI=1 vitest")).toContain('watches unless given "run"');
  });

  it("does NOT guess from the name", () => {
    // The whole point of resolving the body: a name is not evidence in either direction.
    expect(provenNonTerminating("pnpm test:watch")).toBeNull();
    expect(provenNonTerminating("storybook build --disable-telemetry")).toBeNull();
    expect(provenNonTerminating("node scripts/check-production-web-security.mjs")).toBeNull();
  });
});

describe("resolution against the real script graph", () => {
  it("A. a terminating package suite resolves to its runner", () => {
    expect(resolve("pnpm --filter @pathrule/shared test")).toMatchObject({
      status: "resolved",
      runs: "vitest run",
    });
  });

  it("B. the measured case resolves to a watch and is proven non-terminating", () => {
    const r = resolve("pnpm --filter @pathrule/app test:watch");
    expect(r.status).toBe("non_terminating");
    expect(r.runs).toBe("vitest");
    expect(r.reason).toContain('watches unless given "run"');
    // The chain is what a human reads at approval.
    expect(r.chain.join(" | ")).toContain("@pathrule/app:test:watch = vitest");
  });

  it("C. a gate that does not look like a verification still resolves fine", () => {
    // build-storybook is a merge gate by project rule and has no verification signal
    // anywhere. Resolution must not reject it; it only reports what it runs.
    expect(resolve("pnpm --filter @pathrule/app build-storybook")).toMatchObject({
      status: "resolved",
      runs: "storybook build --disable-telemetry",
    });
  });

  it("D. a root custom gate resolves", () => {
    expect(resolve("pnpm web:prod-security")).toMatchObject({
      status: "resolved",
      runs: "node scripts/check-production-web-security.mjs",
    });
  });

  it("E. a missing package or script is unresolved, never silently resolved", () => {
    expect(resolve("pnpm --filter @pathrule/nope test")).toMatchObject({
      status: "unresolved",
      reason: 'no package matching filter "@pathrule/nope"',
    });
    expect(resolve("pnpm no-such-script")).toMatchObject({ status: "unresolved" });
    expect(resolve("pnpm --filter @pathrule/web test")).toMatchObject({
      status: "unresolved",
      reason: 'package "@pathrule/web" has no script "test"',
    });
  });

  it("follows -F as an alias for --filter", () => {
    expect(resolve("pnpm -F @pathrule/shared test").runs).toBe("vitest run");
    expect(resolve("pnpm --filter=@pathrule/shared test").runs).toBe("vitest run");
  });

  it("follows a script that wraps a runner", () => {
    expect(resolve("pnpm --filter @pathrule/core test")).toMatchObject({
      status: "resolved",
      runs: "node ../../scripts/with-sqlite-native.mjs vitest run",
    });
  });

  it("follows a script-to-script chain and an && chain", () => {
    // root `dev` is `pnpm run mcp:build && pnpm --filter @pathrule/app dev`, and the
    // second half is a server. One non-terminating leaf makes the whole thing one.
    const r = resolve("pnpm dev");
    expect(r.status).toBe("non_terminating");
    expect(r.reason).toContain("electron-forge start");
  });

  it("resolves a recursive invocation to many leaves without a single runs value", () => {
    const r = resolve("pnpm typecheck");
    expect(r.status).toBe("resolved");
    expect(r.runs).toBeNull();
    expect(r.reason).toContain("concrete commands");
  });

  it("survives a self-referential script instead of looping", () => {
    // Real shape: the root `typecheck` names the per-package script of the same name.
    // `selfref` is the degenerate version of that.
    const r = resolve("pnpm selfref");
    expect(["resolved", "unresolved"]).toContain(r.status);
    expect(r.chain.length).toBeLessThan(12);
  });

  it("says unresolved, not resolved, when the surface supplied no package data", () => {
    // The remote MCP has no repo filesystem. Absence must be a stated outcome.
    expect(resolveScriptCommand("pnpm --filter @pathrule/shared test", [])).toMatchObject({
      status: "unresolved",
      reason: "no package.json data was available on this surface",
    });
  });

  it("catches a watch flag passed on the invocation itself", () => {
    expect(resolve("pnpm --filter @pathrule/shared test -- --watch").status).toBe("non_terminating");
  });
});

describe("the gate in the validator", () => {
  const BASE: CheckInput = {
    scope_path: "/packages/app",
    command: "pnpm --filter @pathrule/app test:watch",
    message: "The app suite has to pass before this is done, and it must be a one-shot run.",
  };

  it("refuses a proven non-terminating requirement", () => {
    const result = validateCheckInput(BASE, { resolved: resolve(BASE.command) });
    expect(result).toMatchObject({ ok: false, code: "check_command_non_terminating" });
  });

  it("accepts the same shape once the command is a one-shot form", () => {
    const ok = validateCheckInput(
      { ...BASE, command: "pnpm --filter @pathrule/app test" },
      { resolved: resolve("pnpm --filter @pathrule/app test") },
    );
    expect(ok.ok).toBe(true);
  });

  it("accepts a gate that is not a test, because that judgement is the human's", () => {
    const cmd = "pnpm --filter @pathrule/app build-storybook";
    const ok = validateCheckInput({ ...BASE, command: cmd }, { resolved: resolve(cmd) });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.resolved?.runs).toBe("storybook build --disable-telemetry");
  });

  it("accepts when resolution was unavailable, and records that it was", () => {
    // Not a silent pass: the stored atom carries the unresolved status and its reason.
    const cmd = "pnpm --filter @pathrule/shared test";
    const ok = validateCheckInput(
      { ...BASE, command: cmd },
      { resolved: resolveScriptCommand(cmd, []) },
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value.resolved?.status).toBe("unresolved");
    const atom = stampProposedCheck(ok.value, { id: "c1", now: "2026-09-03T00:00:00.000Z" });
    expect(atom.requires.resolved?.status).toBe("unresolved");
    expect(atom.requires.resolved?.reason).toContain("no package.json data");
  });

  it("behaves exactly as before when no resolution is supplied at all", () => {
    // Backward compatibility: every caller that predates this passes nothing.
    const cmd = "pnpm --filter @pathrule/app test:watch";
    const ok = validateCheckInput({ ...BASE, command: cmd });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.resolved).toBeUndefined();
  });
});
