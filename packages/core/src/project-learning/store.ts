// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  localRuntimePaths,
  PATHRULE_DIR_MODE,
  PATHRULE_FILE_MODE,
} from "../storage/paths.js";
import { allowedProjectPath, rootKey } from "./capture.js";
import { validManifestFacts } from "./manifests.js";
import { MAX_REVIEW_TARGETS, validReviewTarget } from "./review-targets.js";
import type { ProjectMapSnapshot } from "@pathrule/protocol/project-learning-types.js";

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

/** Resolve the nearest existing parent, including a PATHRULE_HOME symlink. */
async function canonicalDestination(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw err;
    return join(await canonicalDestination(dirname(path)), basename(path));
  }
}

export async function projectMapPath(
  workspaceId: string,
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (!/^[\w-]{1,160}$/.test(workspaceId)) return null;
  const target = await canonicalDestination(
    resolve(
      localRuntimePaths(env).home,
      "cache",
      workspaceId,
      "project-learning",
      `${rootKey(root)}.json`,
    ),
  );
  return within(root, target) ? null : target;
}

export async function loadProjectMap(
  path: string | null,
  key: string,
): Promise<ProjectMapSnapshot | undefined> {
  if (!path) return undefined;
  try {
    if ((await stat(path)).size > 16 * 1024 * 1024) return undefined;
    const value = JSON.parse(await readFile(path, "utf8")) as ProjectMapSnapshot;
    if (
      value.version !== 1 ||
      value.rootKey !== key ||
      !Array.isArray(value.files) ||
      value.files.length > 20000
    )
      return undefined;
    // Only known evidence is reused. A malformed cache cannot acquire source authority.
    if (
      !value.files.every(
        (file) =>
          file &&
          typeof file.path === "string" &&
          allowedProjectPath(file.path) &&
          (!file.digest || /^(?:git:[a-f0-9]{40,64}|sha256:[a-f0-9]{64})$/.test(file.digest)) &&
          (!file.facts || validManifestFacts(file.facts)),
      )
    )
      return undefined;
    return {
      ...value,
      reviewTargets: Array.isArray(value.reviewTargets)
        ? value.reviewTargets
            .slice(0, MAX_REVIEW_TARGETS)
            .filter(validReviewTarget)
            .map(({ path, reason, digest }) => ({ path, reason, ...(digest ? { digest } : {}) }))
        : [],
      reviewTargetsTruncated: value.reviewTargetsTruncated === true,
      files: value.files.map((file) => ({
        ...file,
        facts: file.facts
          ? {
              ecosystem: file.facts.ecosystem,
              name: file.facts.name,
              dependencies: file.facts.dependencies.map((dep) => ({
                name: dep.name,
                kind: dep.kind,
              })),
              taskNames: file.facts.taskNames,
            }
          : undefined,
      })),
    };
  } catch {
    return undefined;
  }
}

export async function saveProjectMap(
  path: string | null,
  snapshot: ProjectMapSnapshot,
): Promise<boolean> {
  if (!path) return false;
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: PATHRULE_DIR_MODE });
    await writeFile(tmp, JSON.stringify(snapshot), {
      encoding: "utf8",
      flag: "wx",
      mode: PATHRULE_FILE_MODE,
    });
    await rename(tmp, path);
    return true;
  } catch {
    return false;
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}
