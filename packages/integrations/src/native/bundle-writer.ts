// SPDX-License-Identifier: Apache-2.0
// Write a generated plugin or marketplace tree to disk as one unit: it is assembled in a sibling
// staging directory and swapped into place, so a reader never sees half of an update.

import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import type { BundleFile } from "./plugin-bundle.js";

function safeJoin(root: string, rel: string): string {
  const target = resolve(root, rel);
  if (target !== resolve(root) && !target.startsWith(resolve(root) + sep)) {
    throw new Error(`bundle path escapes its root: ${rel}`);
  }
  return target;
}

export async function writeBundle(root: string, files: readonly BundleFile[]): Promise<void> {
  const parent = dirname(resolve(root));
  await mkdir(parent, { recursive: true });
  const staging = `${resolve(root)}.staging-${process.pid}-${Date.now()}`;
  await rm(staging, { recursive: true, force: true });
  try {
    for (const file of files) {
      const target = safeJoin(staging, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.encoding === "base64" ? Buffer.from(file.content, "base64") : file.content);
      if (file.executable) await chmod(target, 0o755);
    }
    const aside = `${resolve(root)}.old-${process.pid}-${Date.now()}`;
    let moved = false;
    try {
      await rename(resolve(root), aside);
      moved = true;
    } catch {
      // nothing there yet
    }
    await rename(staging, resolve(root));
    if (moved) await rm(aside, { recursive: true, force: true });
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }
}

export function bundleFile(files: readonly BundleFile[], rel: string): BundleFile | undefined {
  return files.find((f) => f.path === rel);
}

export { join as bundleJoin };
