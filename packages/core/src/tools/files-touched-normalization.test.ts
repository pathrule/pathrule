// SPDX-License-Identifier: Apache-2.0
// Integration test: files_touched normalizer behavior.
//
// Verifies that normalize_workspace_path produces consistent canonical paths
// regardless of how a path is expressed by a writer, matching the files_touched contract.

import { describe, it, expect } from "vitest";

import { clampFilesTouched } from "./activity-log.js";
import {
  normalizeFilesTouched,
  normalize_workspace_path,
} from "@pathrule/protocol/normalize-workspace-path.js";

const WORKSPACE_ROOT = "/Users/x/GitHub/pathrule";

describe("files_touched normalization integration", () => {
  it("macOS absolute path inside workspace root normalizes to relative", () => {
    const result = normalize_workspace_path({
      raw_path: `${WORKSPACE_ROOT}/packages/app/src/i18n/translations/en.ts`,
      workspace_root: WORKSPACE_ROOT,
    });
    expect(result).toEqual({ ok: true, path: "packages/app/src/i18n/translations/en.ts" });
  });

  it("already relative path produces identical canonical form", () => {
    const result = normalize_workspace_path({
      raw_path: "packages/app/src/i18n/translations/en.ts",
      workspace_root: WORKSPACE_ROOT,
    });
    expect(result).toEqual({ ok: true, path: "packages/app/src/i18n/translations/en.ts" });
  });

  it("absolute and relative forms of same file produce identical path (duplicate collapse)", () => {
    const absResult = normalize_workspace_path({
      raw_path: `${WORKSPACE_ROOT}/packages/app/src/i18n/translations/en.ts`,
      workspace_root: WORKSPACE_ROOT,
    });
    const relResult = normalize_workspace_path({
      raw_path: "packages/app/src/i18n/translations/en.ts",
      workspace_root: WORKSPACE_ROOT,
    });
    expect(absResult.ok && relResult.ok && absResult.path === relResult.path).toBe(true);
  });

  it("path outside workspace root is dropped (not inserted into files_touched)", () => {
    // A sibling-repo path should not land in files_touched
    const result = normalize_workspace_path({
      raw_path: "/Users/x/GitHub/other-repo/packages/app/src/foo.ts",
      workspace_root: WORKSPACE_ROOT,
    });
    expect(result.ok).toBe(false);
  });

  it("normalizeFilesTouched merges duplicate paths that normalize to the same canonical form", () => {
    const raw = {
      total: 3,
      by_area: {
        src: [
          `${WORKSPACE_ROOT}/packages/app/src/i18n/translations/en.ts`,
          "packages/app/src/i18n/translations/en.ts", // same file, relative form
          "./packages/app/src/i18n/translations/en.ts", // same file with ./
        ],
      },
    };
    const { normalized } = normalizeFilesTouched(raw, WORKSPACE_ROOT);
    // All three forms resolve to the same canonical path → deduplicated to 1
    expect(normalized.by_area["src"]).toHaveLength(1);
    expect(normalized.by_area["src"]![0]).toBe("packages/app/src/i18n/translations/en.ts");
  });

  it("normalizeFilesTouched drops paths with parent traversal and counts the reason", () => {
    const raw = {
      total: 2,
      by_area: {
        src: ["packages/app/src/foo.ts", "packages/../etc/passwd"],
      },
    };
    const { normalized, dropped } = normalizeFilesTouched(raw, WORKSPACE_ROOT);
    expect(normalized.by_area["src"]).toHaveLength(1);
    expect(normalized.by_area["src"]![0]).toBe("packages/app/src/foo.ts");
    expect(dropped["parent_traversal"]).toBe(1);
  });

  it("normalizeFilesTouched preserves total as count of canonical paths", () => {
    const raw = {
      total: 5,
      by_area: {
        src: ["packages/a.ts", "packages/b.ts"],
        test: ["packages/c.test.ts"],
      },
    };
    const { normalized } = normalizeFilesTouched(raw, WORKSPACE_ROOT);
    const countedTotal = Object.values(normalized.by_area).reduce(
      (n, paths) => n + paths.length,
      0,
    );
    expect(normalized.total).toBe(countedTotal);
  });

  // The activity-log "never hard-reject" contract: a missing/malformed files_touched
  // must coerce to an empty map, never throw (a throw is a tool error the model
  // retry-loops on).
  it("normalizeFilesTouched tolerates undefined/null without throwing", () => {
    expect(normalizeFilesTouched(undefined, WORKSPACE_ROOT).normalized).toEqual({ total: 0, by_area: {}, normalized_v1: true });
    expect(normalizeFilesTouched(null, WORKSPACE_ROOT).normalized).toEqual({ total: 0, by_area: {}, normalized_v1: true });
  });

  it("normalizeFilesTouched skips a non-object by_area and non-array/non-string entries", () => {
    expect(normalizeFilesTouched({ by_area: "oops" } as never, WORKSPACE_ROOT).normalized).toEqual({ total: 0, by_area: {}, normalized_v1: true });
    const mixed = normalizeFilesTouched(
      { by_area: { src: ["packages/a.ts", 7, null], bad: "x" } } as never,
      WORKSPACE_ROOT,
    ).normalized;
    expect(mixed.by_area.src).toEqual(["packages/a.ts"]);
    expect(mixed.by_area.bad).toBeUndefined();
  });
});

describe("normalized_v1 attestation (the co-change contract)", () => {
  // The bug this pins: from the normalizer's introduction until 2026-08-22 the co-change materializer filtered on
  // `files_touched ->> 'normalized_v1' = 'true'` and NO producer ever wrote that key.
  // Result: co_change_weights stayed empty through 92 successful cron runs with 0 errors,
  // so one of retrieval's three signals was dead while every indicator read healthy.
  it("is set by the normalizer, which is the only thing entitled to claim it", () => {
    const { normalized } = normalizeFilesTouched(
      { total: 2, by_area: { api: ["/repo/src/a.ts", "src/b.ts"] } },
      "/repo",
    );
    expect(normalized.normalized_v1).toBe(true);
  });

  it("survives the storage clamp, which rebuilds the object", () => {
    const { normalized } = normalizeFilesTouched(
      { total: 1, by_area: { api: ["src/a.ts"] } },
      "/repo",
    );
    // clampFilesTouched constructs a fresh object; dropping the flag there would
    // silently re-break the materializer.
    expect(clampFilesTouched(normalized).normalized_v1).toBe(true);
  });

  it("is NOT invented for input that was never normalized", () => {
    // A false attestation is worse than a missing one: it would let an absolute path
    // into a co-change pair. Studio's host-side logger does not normalize, so its rows
    // must stay unflagged rather than be assumed clean.
    expect(clampFilesTouched({ total: 1, by_area: { api: ["/Users/x/repo/src/a.ts"] } }).normalized_v1)
      .toBeUndefined();
    expect(clampFilesTouched(undefined).normalized_v1).toBeUndefined();
  });
});

