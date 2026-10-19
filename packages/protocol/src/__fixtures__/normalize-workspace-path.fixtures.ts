// SPDX-License-Identifier: Apache-2.0
// Fixture corpus for normalize_workspace_path().
// ≥ 20 cases covering every rule of the contract in normalize-workspace-path.ts.

import type { NormalizeInput, NormalizeResult } from "../normalize-workspace-path.js";

export interface Fixture {
  label: string;
  input: NormalizeInput;
  expected: NormalizeResult;
}

const ROOT = "/Users/x/GitHub/pathrule";

export const FIXTURES: Fixture[] = [
  // ── 1: macOS absolute path inside workspace root ───────────────────────
  {
    label: "macOS absolute path inside workspace root",
    input: {
      raw_path: "/Users/x/GitHub/pathrule/packages/app/src/foo.ts",
      workspace_root: ROOT,
    },
    expected: { ok: true, path: "packages/app/src/foo.ts" },
  },

  // ── 2: already relative POSIX — no change ─────────────────────────────
  {
    label: "already relative POSIX path",
    input: {
      raw_path: "packages/app/src/foo.ts",
      workspace_root: ROOT,
    },
    expected: { ok: true, path: "packages/app/src/foo.ts" },
  },

  // ── 3: relative with leading ./ ───────────────────────────────────────
  {
    label: "relative with leading ./",
    input: {
      raw_path: "./packages/app/src/foo.ts",
      workspace_root: ROOT,
    },
    expected: { ok: true, path: "packages/app/src/foo.ts" },
  },

  // ── 4: Windows backslash absolute inside workspace root ───────────────
  {
    label: "Windows backslash absolute path inside workspace root",
    input: {
      raw_path: "C:\\Users\\x\\GitHub\\pathrule\\packages\\app\\src\\foo.ts",
      workspace_root: ROOT,
    },
    expected: { ok: true, path: "packages/app/src/foo.ts" },
  },

  // ── 5: Windows backslash relative ────────────────────────────────────
  {
    label: "Windows backslash relative path",
    input: {
      raw_path: "packages\\app\\src\\foo.ts",
      workspace_root: ROOT,
    },
    expected: { ok: true, path: "packages/app/src/foo.ts" },
  },

  // ── 6: absolute path with no shared prefix — treated as workspace-relative
  // (pure util cannot distinguish /etc from /packages without filesystem access;
  // paths with no initial-segment overlap with workspace_root are stripped
  // rather than rejected. Callers with filesystem access may add a second-
  // pass validation against the workspace directory listing.)
  {
    label: "absolute path with no shared prefix with workspace root (stripped)",
    input: {
      raw_path: "/etc/passwd",
      workspace_root: ROOT,
    },
    expected: { ok: true, path: "etc/passwd" },
  },

  // ── 7: parent traversal — reject ─────────────────────────────────────
  {
    label: "path containing .. traversal",
    input: {
      raw_path: "packages/../etc/passwd",
      workspace_root: ROOT,
    },
    expected: { ok: false, reason: "parent_traversal" },
  },

  // ── 8: trailing slash stripped ───────────────────────────────────────
  {
    label: "trailing slash stripped",
    input: {
      raw_path: "packages/app/",
      workspace_root: ROOT,
    },
    expected: { ok: true, path: "packages/app" },
  },

  // ── 9: workspace-absolute leading slash treated as workspace-relative ─
  {
    label: "leading slash treated as workspace-relative",
    input: {
      raw_path: "/packages/app/src/foo.ts",
      workspace_root: ROOT,
    },
    expected: { ok: true, path: "packages/app/src/foo.ts" },
  },

  // ── 10: symlink-style with /. and // ─────────────────────────────────
  {
    label: "symlink-style with /. and // collapsed",
    input: {
      raw_path: "/Users/x/GitHub/pathrule/./packages/./app//src/foo.ts",
      workspace_root: ROOT,
    },
    expected: { ok: true, path: "packages/app/src/foo.ts" },
  },

  // ── 11: mixed-case drive letter Windows ──────────────────────────────
  {
    label: "lowercase drive letter Windows",
    input: {
      raw_path: "c:\\Users\\x\\GitHub\\pathrule\\packages\\app\\src\\foo.ts",
      workspace_root: ROOT,
    },
    expected: { ok: true, path: "packages/app/src/foo.ts" },
  },

  // ── 12: workspace root literal → empty_after_normalize ───────────────
  {
    label: "path equal to workspace root rejects as empty",
    input: {
      raw_path: ROOT,
      workspace_root: ROOT,
    },
    expected: { ok: false, reason: "empty_after_normalize" },
  },

  // ── 13: long path (300 chars) passes through ─────────────────────────
  {
    label: "long relative path (300 chars) passes through",
    input: {
      raw_path: "packages/" + "a".repeat(290),
      workspace_root: ROOT,
    },
    expected: { ok: true, path: "packages/" + "a".repeat(290) },
  },

  // ── 14: Unicode + spaces preserved ────────────────────────────────────
  {
    label: "Unicode + spaces in path preserved",
    input: {
      raw_path: "packages/app/Çalışma Alanı/foo.ts",
      workspace_root: ROOT,
    },
    expected: { ok: true, path: "packages/app/Çalışma Alanı/foo.ts" },
  },

  // ── 15: URL scheme — reject with unsupported_scheme ───────────────────
  {
    label: "file:// URL scheme rejected",
    input: {
      raw_path: "file:///Users/x/GitHub/pathrule/packages/app/src/foo.ts",
      workspace_root: ROOT,
    },
    expected: { ok: false, reason: "unsupported_scheme" },
  },

  // ── 16: http:// URL scheme — reject ───────────────────────────────────
  {
    label: "http:// URL scheme rejected",
    input: {
      raw_path: "http://example.com/packages/app/src/foo.ts",
      workspace_root: ROOT,
    },
    expected: { ok: false, reason: "unsupported_scheme" },
  },

  // ── 17: empty string → empty_after_normalize ─────────────────────────
  {
    label: "empty string rejects",
    input: {
      raw_path: "",
      workspace_root: ROOT,
    },
    expected: { ok: false, reason: "empty_after_normalize" },
  },

  // ── 18: only slashes → empty_after_normalize ─────────────────────────
  {
    label: "only slashes rejects",
    input: {
      raw_path: "///",
      workspace_root: ROOT,
    },
    expected: { ok: false, reason: "empty_after_normalize" },
  },

  // ── 19: .. at the very start — reject ────────────────────────────────
  {
    label: ".. at start rejects",
    input: {
      raw_path: "../packages/app/src/foo.ts",
      workspace_root: ROOT,
    },
    expected: { ok: false, reason: "parent_traversal" },
  },

  // ── 20: Windows absolute path with uppercase workspace_root ───────────
  {
    label: "Windows absolute with uppercase drive letter C:\\",
    input: {
      raw_path: "C:\\Users\\x\\GitHub\\pathrule\\packages\\mcp-server\\src\\index.ts",
      workspace_root: ROOT,
    },
    expected: { ok: true, path: "packages/mcp-server/src/index.ts" },
  },

  // ── 20b: a Windows workspace root (what a Windows host passes) ────────
  {
    label: "Windows absolute path under a Windows workspace root",
    input: {
      raw_path: "C:\\Users\\x\\GitHub\\pathrule\\packages\\app\\src\\foo.ts",
      workspace_root: "C:\\Users\\x\\GitHub\\pathrule",
    },
    expected: { ok: true, path: "packages/app/src/foo.ts" },
  },

  // ── 21: path with only a dot ─────────────────────────────────────────
  {
    label: "single dot path becomes empty",
    input: {
      raw_path: ".",
      workspace_root: ROOT,
    },
    expected: { ok: false, reason: "empty_after_normalize" },
  },

  // ── 22: deeply nested relative path ───────────────────────────────────
  {
    label: "deeply nested relative path passes through",
    input: {
      raw_path: "packages/shared/src/tools/deeply/nested/util.ts",
      workspace_root: ROOT,
    },
    expected: { ok: true, path: "packages/shared/src/tools/deeply/nested/util.ts" },
  },

  // ── 23: absolute path that shares initial segments with workspace root → outside
  // e.g. /Users/x/GitHub/other-repo/... shares /Users/x/GitHub with the workspace
  // root /Users/x/GitHub/pathrule, so it's clearly a sibling repo → rejected.
  {
    label: "sibling-repo absolute path shares initial segments with workspace root",
    input: {
      raw_path: "/Users/x/GitHub/other-repo/packages/app/src/foo.ts",
      workspace_root: ROOT,
    },
    expected: { ok: false, reason: "outside_workspace_root" },
  },
];
