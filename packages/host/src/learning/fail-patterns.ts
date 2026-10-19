// SPDX-License-Identifier: Apache-2.0
// Local failure-pattern files: the scan.
//
// The hook script (pathrule-hook.js) appends one line per failing PostToolUse to
// <home>/cache/<ws>/fail-patterns.jsonl and reads <home>/cache/<ws>/fail-patterns.json on every
// PreToolUse. Nothing promotes patterns into that file, so the scan removes a detected file left by
// an earlier build wherever the hook is still recording failures: the hook never serves stale
// patterns. No raw error content leaves the local file.

import { readdir, stat, unlink } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { pathruleHome } from "@pathrule/core/storage/paths.js";

const JSONL_FILE = "fail-patterns.jsonl";
const DETECTED_FILE = "fail-patterns.json";

const SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface FailPatternDetectorOptions {
  /** The directory holding one directory per workspace. Default: the Pathrule home's `cache`. */
  cacheDir?: string;
  env?: NodeJS.ProcessEnv;
}

/** Scan now and every 5 minutes, for the life of the process. Returns a function that stops it. */
export function startFailPatternDetector(options: FailPatternDetectorOptions = {}): () => void {
  const cacheDir = options.cacheDir ?? join(pathruleHome(options.env), "cache");
  void scanFailPatterns(cacheDir);
  const timer = setInterval(() => {
    void scanFailPatterns(cacheDir);
  }, SCAN_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** One scan of every workspace directory under `cacheDir`. Never throws. */
export async function scanFailPatterns(cacheDir: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(cacheDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    console.warn("[fail-detector] readdir failed:", err);
    return;
  }

  // Skip non-directory entries (e.g. macOS .DS_Store, stray files).
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await scanWorkspace(cacheDir, entry.name).catch((err) =>
      console.warn(`[fail-detector] ${entry.name} scan failed:`, err),
    );
  }
}

async function scanWorkspace(cacheDir: string, workspaceId: string): Promise<void> {
  const wsDir = join(cacheDir, workspaceId);
  try {
    await stat(join(wsDir, JSONL_FILE));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  // Remove a stale detected file so the hook script doesn't serve old patterns.
  const detectedPath = join(wsDir, DETECTED_FILE);
  try {
    await stat(detectedPath);
    await unlink(detectedPath).catch(() => {});
  } catch {
    /* no prior file */
  }
}
