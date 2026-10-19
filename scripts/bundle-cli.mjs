#!/usr/bin/env node
// Bundles the CLI into one ES module, better-sqlite3 left external, in the npm package's layout
// (package.json beside dist/) with the licence notices of the packages the bundle inlines beside it.
// Every distribution of the CLI is one of these bundles, built with the same defines
// (build-time-cli-defines.mjs):
//
//   - `pathrule` (src/index.ts): the npm package @pathrule/cli, the standalone tarball and Homebrew,
//     and the checkout's CLI (`node artifacts/cli/dist/index.js`). It embeds the web apps the CLI
//     package names (`embeds` in npm-packages.mjs: the Local Console in dist/ui).
//   - the MCP server (src/mcp-bin.ts): the npm package @pathrule/mcp.
//   - the VS Code extension's copy (src/editor-bin.ts), without the web apps: the CLI it carries is
//     the MCP server it registers, not a distribution of `pathrule ui`.
//
// usage: node scripts/bundle-cli.mjs [<out dir>]   (default: artifacts/cli)
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cliBuildDefines } from "./build-time-cli-defines.mjs";
import { embedEmbeddedApps } from "./build-embedded-apps.mjs";
import { npmPackageByDir } from "./npm-packages.mjs";
import { thirdPartyNotices } from "./third-party-notices.mjs";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const CLI_DIR = resolve(ROOT, "packages", "cli");

/** The CLI's entries, by what runs them. */
export const CLI_ENTRIES = {
  pathrule: resolve(CLI_DIR, "src/index.ts"),
  mcp: resolve(CLI_DIR, "src/mcp-bin.ts"),
  editor: resolve(CLI_DIR, "src/editor-bin.ts"),
};

/**
 * Writes <outDir>/package.json (unless `writeManifest` is false), <outDir>/dist/index.js and its
 * notices, and returns esbuild's metafile. `build` is the caller's esbuild, so a package keeps the
 * esbuild it pins.
 */
export async function bundleCli({
  outDir,
  entry = CLI_ENTRIES.pathrule,
  define = cliBuildDefines(),
  build,
  absWorkingDir = ROOT,
  embedApps = false,
  product = "The Pathrule CLI",
  writeManifest = true,
}) {
  mkdirSync(resolve(outDir, "dist"), { recursive: true });
  if (writeManifest) copyFileSync(resolve(CLI_DIR, "package.json"), resolve(outDir, "package.json"));
  const result = await build({
    entryPoints: [entry],
    outfile: resolve(outDir, "dist/index.js"),
    absWorkingDir,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    minify: true,
    legalComments: "none",
    external: ["better-sqlite3"],
    define,
    // An ES module has no `require`, and the CommonJS dependencies the bundle inlines call it for
    // Node's builtins: give the module its own.
    banner: {
      js: '#!/usr/bin/env node\nimport { createRequire as __pathruleCreateRequire } from "node:module";\nconst require = __pathruleCreateRequire(import.meta.url);',
    },
    metafile: true,
    plugins: [
      thirdPartyNotices({
        outFile: resolve(outDir, "dist/THIRD_PARTY_NOTICES.md"),
        product,
      }),
    ],
    logLevel: "warning",
  });
  if (embedApps) {
    embedEmbeddedApps(npmPackageByDir("cli"), resolve(outDir, "dist"));
  }
  return result.metafile;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = resolve(process.argv[2] ?? resolve(ROOT, "artifacts", "cli"));
  const { build } = createRequire(import.meta.url)("esbuild");
  await bundleCli({ outDir, build, embedApps: true });
  console.log(`bundled the CLI: ${resolve(outDir, "dist/index.js")}`);
}
