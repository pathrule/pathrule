// SPDX-License-Identifier: Apache-2.0
// Bundles the extension to a single CJS file for the VSCode extension host.
//
// usage: node esbuild.mjs [--watch]
//
// - The entry is src/extension.ts, which composes Pathrule Cloud (src/cloud.ts). Output: dist/.
// - The extension carries the CLI as one bundle (scripts/bundle-cli.mjs, its editor entry, which
//   always composes Pathrule Cloud) in dist/cli: the MCP entries it registers/writes spawn
//   `<extension>/dist/cli/dist/index.js mcp run`.
// - `vscode` is provided by the host: always external.
// - `better-sqlite3` ships a native binary; it stays external and is loaded
//   lazily ONLY by the local-mode module (src/binding/local.ts wraps the
//   dynamic import in a graceful-degrade path for ABI mismatches).
// - CLI modules are imported BY SOURCE via the #cli alias (the CLI package main
//   points at its bundle).
// - Build-time defines are the CLI's (scripts/build-time-cli-defines.mjs), so resolveCliMcpEntry and
//   installCliHookScript work verbatim. All values are publishable-class.

import { build, context } from "esbuild";
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";

import { loadBuildTimeCliDefines } from "../../scripts/build-time-cli-defines.mjs";
import { bundleCli, CLI_ENTRIES } from "../../scripts/bundle-cli.mjs";
import { thirdPartyNotices } from "../../scripts/third-party-notices.mjs";

const pkgRoot = resolve(fileURLToPath(import.meta.url), "..");
const watching = process.argv.includes("--watch");
const distDir = resolve(pkgRoot, "dist");
const entry = resolve(pkgRoot, "src/extension.ts");
const { define } = loadBuildTimeCliDefines();

const cliMetafile = await bundleCli({
  outDir: resolve(distDir, "cli"),
  entry: CLI_ENTRIES.editor,
  define,
  build,
  absWorkingDir: pkgRoot,
});

// Vendor better-sqlite3 next to the bundled CLI so local mode resolves it inside the packaged .vsix
// (the CLI keeps it external + lazy). better-sqlite3 13 is Node-API: one prebuilt binary per platform
// loads in every Node and Electron, so its prebuilds/ directory travels as it is. The release packs
// one .vsix per target and keeps only that target's binary (scripts/release/lib/checks.mjs).
const require = createRequire(import.meta.url);
const sqliteRoot = dirname(require.resolve("better-sqlite3/package.json"));
{
  const vendorRoot = resolve(distDir, "cli/node_modules/better-sqlite3");
  rmSync(vendorRoot, { recursive: true, force: true });
  mkdirSync(vendorRoot, { recursive: true });
  copyFileSync(resolve(sqliteRoot, "package.json"), resolve(vendorRoot, "package.json"));
  copyFileSync(resolve(sqliteRoot, "LICENSE"), resolve(vendorRoot, "LICENSE"));
  cpSync(resolve(sqliteRoot, "lib"), resolve(vendorRoot, "lib"), { recursive: true });
  cpSync(resolve(sqliteRoot, "prebuilds"), resolve(vendorRoot, "prebuilds"), { recursive: true });
}

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: [entry],
  outfile: resolve(distDir, "extension.cjs"),
  absWorkingDir: pkgRoot,
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: watching,
  // Production bundles are minified: smaller .vsix AND no third-party JSDoc
  // (a bundled client's comments mention `service_role` and would trip the 6.6 scan).
  minify: !watching,
  // better-sqlite3 is loaded from the copy vendored beside the bundled CLI: the .vsix carries no
  // other (node_modules/ is excluded), so a bare require from dist/ found nothing in an installed
  // extension, and local mode was unavailable there.
  external: ["vscode"],
  alias: {
    "#cli": resolve(pkgRoot, "../cli/src"),
  },
  define: { ...define, "import.meta.url": "import_meta_url" },
  inject: [resolve(pkgRoot, "import-meta-url-shim.js")],
  // Licence notices of every package this bundle inlines, plus better-sqlite3, which ships
  // beside it. The bundled CLI's own notices sit in dist/cli/dist/.
  metafile: true,
  plugins: [
    {
      name: "vendored-better-sqlite3",
      setup(pluginBuild) {
        // The package's entry file, not its directory: a dynamic import() stays an ES import,
        // and ES resolution refuses a directory.
        pluginBuild.onResolve({ filter: /^better-sqlite3$/ }, () => ({
          path: "./cli/node_modules/better-sqlite3/lib/index.js",
          external: true,
        }));
      },
    },
    thirdPartyNotices({
      outFile: resolve(distDir, "THIRD_PARTY_NOTICES.md"),
      product: "The Pathrule VS Code extension",
      extraPackageDirs: [sqliteRoot],
    }),
  ],
  logLevel: "info",
};

if (watching) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  const result = await build(options);
}
