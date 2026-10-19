// The web apps a CLI package serves (`embeds` in scripts/npm-packages.mjs): `pathrule ui` serves the
// Local Console from dist/ui. Each app is built by its own package's `build` script, which checks
// the build (packages/local-console/scripts/check-bundle.mjs: self-contained, no source map) and
// writes the licence notices of every package it inlines, failing on one without an approved
// licence. The build is then carried as it is, by every CLI bundle that serves it
// (scripts/bundle-cli.mjs: the npm package, the standalone tarball, the checkout's CLI).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

/** Files every embedded build must hold. */
export const EMBEDDED_APP_FILES = ["index.html", "THIRD_PARTY_NOTICES.md"];

/** Builds the web app in packages/<dir> with its own `build` script and returns its dist/. */
export function buildEmbeddedApp(dir) {
  const appDir = join(ROOT, "packages", dir);
  try {
    execFileSync("npm", ["run", "--silent", "build"], {
      cwd: appDir,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const out = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    throw new Error(`packages/${dir}: its build failed\n${out}`);
  }
  const dist = join(appDir, "dist");
  for (const file of EMBEDDED_APP_FILES) {
    if (!existsSync(join(dist, file))) throw new Error(`packages/${dir}: dist/${file} is missing`);
  }
  return dist;
}

/**
 * Builds each web app `pkg` embeds and copies it to `<distDir>/<key>`, replacing what was there.
 * Returns the embeds, `{ <key>: <package dir> }`.
 */
export function embedEmbeddedApps(pkg, distDir) {
  const embeds = pkg.embeds ?? {};
  for (const [to, from] of Object.entries(embeds)) {
    const target = join(distDir, to);
    rmSync(target, { recursive: true, force: true });
    cpSync(buildEmbeddedApp(from), target, { recursive: true });
  }
  return embeds;
}
