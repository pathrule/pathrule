#!/usr/bin/env node
// Builds one npm package (scripts/npm-packages.mjs) into packages/<dir>/dist: one ES module bundle of
// the CLI from the package's entry (scripts/bundle-cli.mjs), with every workspace package inlined
// and the licence notices of what it inlines beside it, and the web apps it serves. Only the
// EXTERNAL_DEPENDENCIES stay imports; npm installs them.
//
// After the build, every import the bundle keeps must be a Node builtin or an external dependency.
//
// usage: node scripts/build-npm-package.mjs [packages/<dir> | --all]   (default: the current directory)
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bundleCli, CLI_ENTRIES } from "./bundle-cli.mjs";
import { EXTERNAL_DEPENDENCIES, NPM_PACKAGES, npmPackageByDir } from "./npm-packages.mjs";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const require = createRequire(import.meta.url);
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

const toPosix = (path) => path.split("\\").join("/");

export async function buildNpmPackage(dir, { quiet = false } = {}) {
  const pkg = npmPackageByDir(dir);
  const pkgDir = join(ROOT, "packages", pkg.dir);
  const distDir = join(pkgDir, "dist");
  const log = (line) => quiet || console.log(`[npm build ${pkg.name}] ${line}`);

  rmSync(distDir, { recursive: true, force: true });
  const metafile = await bundleCli({
    outDir: pkgDir,
    entry: CLI_ENTRIES[pkg.entry],
    build: require("esbuild").build,
    embedApps: Boolean(pkg.embeds),
    writeManifest: false,
  });
  const bundle = join(distDir, "index.js");
  chmodSync(bundle, 0o755);
  const inputs = Object.keys(metafile.inputs);
  log(`dist/index.js: ${inputs.length} inlined modules`);
  for (const key of Object.keys(pkg.embeds ?? {})) {
    if (!existsSync(join(distDir, key, "index.html"))) throw new Error(`${pkg.name}: dist/${key} is missing`);
    log(`dist/${key}/ from packages/${pkg.embeds[key]}`);
  }

  const problems = checkBundleImports(metafile);
  if (problems.length > 0) {
    throw new Error(`${pkg.name}: the bundle breaks its rules:\n  ${problems.join("\n  ")}`);
  }
  return { name: pkg.name, modules: inputs.length, bytes: readFileSync(bundle).length };
}

/** Every import the bundle keeps that is neither a Node builtin nor an external dependency. */
export function checkBundleImports(metafile) {
  const problems = [];
  for (const [output, { imports }] of Object.entries(metafile.outputs)) {
    for (const { path, external } of imports) {
      if (!external) continue;
      const name = path.startsWith("@") ? path.split("/").slice(0, 2).join("/") : path.split("/")[0];
      if (BUILTINS.has(path) || BUILTINS.has(name) || EXTERNAL_DEPENDENCIES.includes(name)) continue;
      problems.push(`${basename(output)}: imports ${path}, which is neither a builtin nor a dependency`);
    }
  }
  return problems;
}


if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dirs =
    process.argv[2] === "--all"
      ? NPM_PACKAGES.map((pkg) => pkg.dir)
      : [basename(resolve(process.argv[2] ?? process.cwd()))];
  for (const dir of dirs) {
    const result = await buildNpmPackage(dir, { quiet: dirs.length > 1 });
    console.log(
      `built ${result.name}: ${result.modules} inlined modules, ${(result.bytes / 1024).toFixed(0)} KB`,
    );
  }
}
