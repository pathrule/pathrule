#!/usr/bin/env node
// Stages the npm packages (scripts/npm-packages.mjs) as publish-shaped packages and tarballs.
// Nothing is published.
//
//   --out <dir>          default artifacts/npm-packages (or PATHRULE_NPM_PACKAGES_OUT)
//   --skip-build         stage the dist/ already built.
//   --for-publication    exit 1 when anything blocks a publish (staging.json's publishBlockers).
//   --plugin <dir>       also pack a provider plugin that is an npm package by nature (the OpenCode
//                        plugin, plugins/opencode in pathrule/pathrule): packed as it is, no build.
//
// Each package is built (scripts/build-npm-package.mjs: one bundle of the CLI), and its manifest is
// made from the workspace one: its metadata, the package's `description` and `bin` when
// npm-packages.mjs gives them, and as dependencies only the EXTERNAL_DEPENDENCIES the bundle keeps,
// with the CLI's ranges. No workspace package is a dependency: the bundle inlines them.
//
// The staged packages must:
// - share one version (lockstep);
// - be Apache-2.0 and ship LICENSE, NOTICE and README.md;
// - carry open code only (checked where the boundary data lives: scripts/check-open-npm-packages.mjs);
// - hold only their manifest, licence files, shrinkwrap and dist/ in the tarball.
//
// Each package ships an npm-shrinkwrap.json, as npm recommends for a tool installed globally: it
// pins better-sqlite3 to the version this workspace tests.
//
// `staging.json` lists the tarballs, and what still blocks a real publish.
import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildNpmPackage } from "./build-npm-package.mjs";
import { EXTERNAL_DEPENDENCIES, NPM_PACKAGES } from "./npm-packages.mjs";
import { startStagingRegistry } from "./npm-staging-registry.mjs";

const PUBLIC_REGISTRY = "https://registry.npmjs.org";
/** The repository the packages publish from; npm provenance names it. */
const PUBLIC_REPOSITORY = "git+https://github.com/pathrule/pathrule.git";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const PASSTHROUGH_FIELDS = [
  "name",
  "version",
  "description",
  "license",
  "homepage",
  "repository",
  "bugs",
  "keywords",
  "type",
  "bin",
  "engines",
  // The official MCP Registry proves npm ownership by this field (server.json at pathrule/pathrule's root).
  "mcpName",
];
const LICENCE_FILES = ["LICENSE", "NOTICE", "README.md"];

const readManifest = (dir) =>
  JSON.parse(readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8"));

export async function stageNpmPackages({ out, skipBuild = false, quiet = false, plugins = [] } = {}) {
  const outDir = resolve(
    ROOT,
    out ?? process.env.PATHRULE_NPM_PACKAGES_OUT ?? "artifacts/npm-packages",
  );
  const log = (line) => quiet || console.log(`[stage-npm-packages] ${line}`);
  const cli = readManifest("cli");

  const sources = NPM_PACKAGES.map((pkg) => ({ pkg, manifest: readManifest(pkg.dir) }));
  const versions = new Set(sources.map((s) => s.manifest.version));
  if (versions.size !== 1) {
    throw new Error(
      `The packages are not on one version (lockstep): ${sources.map((s) => `${s.manifest.name}@${s.manifest.version}`).join(", ")}`,
    );
  }
  const [version] = versions;

  if (!skipBuild) {
    for (const { pkg } of sources) await buildNpmPackage(pkg.dir, { quiet: true });
    log(`built ${sources.length} packages`);
  }

  rmSync(outDir, { recursive: true, force: true });
  const tarballDir = join(outDir, "tarballs");
  mkdirSync(tarballDir, { recursive: true });

  const findings = [];
  const staged = [];
  for (const { pkg, manifest: source } of sources) {
    const dir = join(outDir, "packages", pkg.dir);
    const distDir = join(ROOT, "packages", pkg.dir, "dist");
    if (!existsSync(join(distDir, "index.js")))
      throw new Error(`${pkg.name}: packages/${pkg.dir}/dist/index.js is missing`);
    mkdirSync(dir, { recursive: true });
    cpSync(distDir, join(dir, "dist"), { recursive: true });
    const shipped = [];
    for (const file of LICENCE_FILES) {
      const path = join(ROOT, "packages", pkg.dir, file);
      if (existsSync(path)) {
        copyFileSync(path, join(dir, file));
        shipped.push(file);
      }
    }
    const manifest = publishManifest(pkg, source, { version, shipped, cli });
    findings.push(...checkStagedManifest(pkg, manifest, { version, shipped }));
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    staged.push({ pkg, dir, manifest, shipped });
  }
  if (findings.length > 0) {
    throw new Error(`The staged packages break their rules:\n  ${findings.join("\n  ")}`);
  }

  const tarballs = [];
  for (const { pkg, dir, manifest, shipped } of staged) {
    await writeShrinkwrap({ dir, manifest });
    shipped.push("npm-shrinkwrap.json");
    log(`${manifest.name}: npm-shrinkwrap.json pins the tested versions`);
    const [packed] = JSON.parse(
      execFileSync("npm", ["pack", "--json", "--pack-destination", tarballDir], {
        cwd: dir,
        encoding: "utf8",
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    const paths = packed.files.map((file) => file.path);
    const stray = paths.filter(
      (path) =>
        !(path === "package.json" || shipped.includes(path) || path.startsWith("dist/")) ||
        /\.(map|tsbuildinfo)$|\.test\.|\/test\/|__fixtures__/.test(path),
    );
    if (stray.length > 0) throw new Error(`${pkg.name}: the tarball holds ${stray.join(", ")}`);
    if (!paths.includes("npm-shrinkwrap.json")) {
      throw new Error(`${pkg.name}: the tarball lacks its npm-shrinkwrap.json`);
    }
    tarballs.push({
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      role: pkg.role,
      tarball: join("tarballs", packed.filename),
      integrity: packed.integrity,
      shasum: packed.shasum,
      size: packed.size,
      unpackedSize: packed.unpackedSize,
      files: paths.length,
      dependencies: manifest.dependencies ?? {},
      peerDependencies: manifest.peerDependencies ?? {},
    });
  }

  for (const pluginDir of plugins) {
    const packed = packPluginPackage(resolve(ROOT, pluginDir), { version, outDir });
    tarballs.push(packed);
    log(`${packed.name}: packed from ${pluginDir}`);
  }

  const report = { version, packages: tarballs, publishBlockers: publishBlockers(staged) };
  writeFileSync(join(outDir, "staging.json"), `${JSON.stringify(report, null, 2)}\n`);
  log(`${tarballs.length} tarballs in ${tarballDir}`);
  return { outDir, tarballDir, report };
}

/** The version of `dep` this workspace installs for the CLI, as Node resolves it. */
function testedVersion(dep) {
  const req = createRequire(join(ROOT, "packages", "cli", "package.json"));
  for (const base of req.resolve.paths(dep) ?? []) {
    const manifest = join(base, dep, "package.json");
    if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, "utf8")).version;
  }
  throw new Error(`${dep} is not installed for packages/cli; run pnpm install`);
}

/**
 * Writes a package's npm-shrinkwrap.json: its install tree with every external dependency at the
 * version this workspace tests. It is resolved through the staging registry, which passes every
 * request to the public registry, and records the public registry's URLs.
 */
async function writeShrinkwrap({ dir, manifest }) {
  const registry = await startStagingRegistry({ tarballs: [] });
  const work = mkdtempSync(join(tmpdir(), "pathrule-shrinkwrap-"));
  try {
    const resolving = structuredClone(manifest);
    for (const dep of Object.keys(resolving.dependencies ?? {})) {
      resolving.dependencies[dep] = testedVersion(dep);
    }
    writeFileSync(join(work, "package.json"), JSON.stringify(resolving, null, 2));
    const result = await new Promise((done) => {
      const child = spawn(
        "npm",
        [
          "install",
          "--package-lock-only",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--registry",
          registry.url,
        ],
        { cwd: work, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (c) => (output += c));
      child.stderr.on("data", (c) => (output += c));
      child.on("close", (status) => done({ status, output }));
    });
    if (result.status !== 0)
      throw new Error(`${manifest.name}: resolving its shrinkwrap failed:\n${result.output}`);
    const lock = JSON.parse(readFileSync(join(work, "package-lock.json"), "utf8"));
    // The root entry describes the published manifest, ranges and all; the pins live in the tree.
    restoreShrinkwrapRoot(lock.packages[""], manifest);
    const text = JSON.stringify(lock, null, 2).split(registry.url).join(PUBLIC_REGISTRY);
    if (text.includes("127.0.0.1"))
      throw new Error(`${manifest.name}: the shrinkwrap names the staging registry`);
    if (/node_modules\/@pathrule\//.test(text))
      throw new Error(`${manifest.name}: the shrinkwrap installs a workspace package`);
    writeFileSync(join(dir, "npm-shrinkwrap.json"), `${text}\n`);
    // npm packs a shrinkwrap only when `files` lists it.
    manifest.files = [...manifest.files, "npm-shrinkwrap.json"];
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    await registry.close();
    rmSync(work, { recursive: true, force: true });
  }
}

/** Restore published dependency declarations without changing the resolved tree's pins. */
export function restoreShrinkwrapRoot(root, manifest) {
  delete root.overrides;
  for (const field of ["dependencies", "peerDependencies", "peerDependenciesMeta"]) {
    if (manifest[field] === undefined) delete root[field];
    else root[field] = structuredClone(manifest[field]);
  }
  return root;
}

/**
 * The published manifest of a package: its workspace metadata, the package's own description and
 * bin when npm-packages.mjs gives them, and the external dependencies at the CLI's ranges.
 */
export function publishManifest(pkg, source, { version, shipped, cli }) {
  const out = {};
  for (const field of PASSTHROUGH_FIELDS)
    if (source[field] !== undefined) out[field] = structuredClone(source[field]);
  out.version = version;
  if (pkg.description) out.description = pkg.description;
  if (pkg.bin) out.bin = structuredClone(pkg.bin);
  if (out.bin) {
    out.bin = Object.fromEntries(
      Object.entries(out.bin).map(([k, v]) => [k, String(v).replace(/^\.\//, "")]),
    );
  }
  out.exports = { "./package.json": "./package.json" };
  out.files = ["dist", ...shipped];
  out.dependencies = Object.fromEntries(
    EXTERNAL_DEPENDENCIES.map((name) => {
      const range = cli.dependencies?.[name];
      if (!range) throw new Error(`packages/cli/package.json does not declare ${name}`);
      return [name, range];
    }),
  );
  out.publishConfig = { access: source.publishConfig?.access ?? "public" };
  return out;
}

export function checkStagedManifest(pkg, manifest, { version, shipped }) {
  const findings = [];
  const text = JSON.stringify(manifest);
  if (text.includes("workspace:")) findings.push(`${pkg.name}: a workspace: range is left`);
  if ("private" in manifest) findings.push(`${pkg.name}: private is set`);
  if (manifest.name !== pkg.name) findings.push(`${pkg.name}: the manifest is ${manifest.name}`);
  if (manifest.version !== version)
    findings.push(`${pkg.name}: version ${manifest.version}, not ${version}`);
  if (!manifest.bin || Object.keys(manifest.bin).length === 0)
    findings.push(`${pkg.name}: an application names its bin`);
  for (const target of Object.values(manifest.bin ?? {})) {
    if (target !== "dist/index.js") findings.push(`${pkg.name}: bin ${target} is not the bundle`);
  }
  const deps = Object.keys(manifest.dependencies ?? {}).sort();
  if (JSON.stringify(deps) !== JSON.stringify([...EXTERNAL_DEPENDENCIES].sort()))
    findings.push(`${pkg.name}: depends on ${deps.join(", ")}, not ${EXTERNAL_DEPENDENCIES.join(", ")}`);
  for (const field of ["peerDependencies", "optionalDependencies", "pathrule"]) {
    if (manifest[field]) findings.push(`${pkg.name}: the manifest has ${field}`);
  }
  if (manifest.license !== "Apache-2.0")
    findings.push(`${pkg.name}: an npm package is Apache-2.0, not ${manifest.license}`);
  for (const file of ["LICENSE", "NOTICE"]) {
    if (!shipped.includes(file)) findings.push(`${pkg.name}: the ${file} file is not shipped`);
  }
  return findings;
}

/**
 * A provider plugin that is an npm package by nature (the OpenCode plugin), packed exactly as the
 * plugin generator wrote it. It depends on nothing: its module and scripts use Node built-ins only,
 * and the runtime it drives is installed separately.
 */
export function packPluginPackage(source, { version, outDir }) {
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  // Staged like every package: its directory under packages/<unscoped name>, its tarball in tarballs/
  // (scripts/npm-staging-registry.mjs and the install smokes read both).
  const dir = join(outDir, "packages", String(manifest.name).split("/").pop());
  const tarballDir = join(outDir, "tarballs");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(tarballDir, { recursive: true });
  cpSync(source, dir, { recursive: true });
  const findings = [];
  if (!/^@pathrule\/[a-z-]+$/.test(manifest.name ?? "")) findings.push(`${dir}: the package is ${manifest.name}`);
  if (manifest.version !== version) findings.push(`${manifest.name}: version ${manifest.version}, not ${version}`);
  if (manifest.license !== "Apache-2.0") findings.push(`${manifest.name}: an npm package is Apache-2.0, not ${manifest.license}`);
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies", "scripts", "bin"]) {
    if (manifest[field] !== undefined) findings.push(`${manifest.name}: a plugin package declares ${field}`);
  }
  for (const file of ["LICENSE", "NOTICE", "README.md"]) {
    if (!existsSync(join(dir, file))) findings.push(`${manifest.name}: the ${file} file is missing`);
  }
  if (manifest.repository?.url !== PUBLIC_REPOSITORY) findings.push(`${manifest.name}: its repository is not ${PUBLIC_REPOSITORY}`);
  if (findings.length > 0) throw new Error(`The plugin package breaks its rules:\n  ${findings.join("\n  ")}`);
  const [packed] = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", tarballDir], {
      cwd: dir,
      encoding: "utf8",
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  return {
    name: manifest.name,
    version: manifest.version,
    license: manifest.license,
    role: "plugin",
    tarball: join("tarballs", packed.filename),
    integrity: packed.integrity,
    shasum: packed.shasum,
    size: packed.size,
    unpackedSize: packed.unpackedSize,
    files: packed.files.length,
    dependencies: {},
    peerDependencies: {},
  };
}

function publishBlockers(staged) {
  const blockers = [];
  for (const { manifest, shipped } of staged) {
    if (!shipped.includes("README.md")) blockers.push(`${manifest.name}: no README.`);
    // npm provenance ties a tarball to the repository whose workflow published it.
    if (manifest.repository?.url !== PUBLIC_REPOSITORY) {
      blockers.push(`${manifest.name}: its repository is not ${PUBLIC_REPOSITORY}.`);
    }
  }
  return blockers;
}

// Compared on real paths, so a symlinked checkout cannot turn `--for-publication` into a silent no-op.
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const arg = (flag) => {
    const i = process.argv.indexOf(flag);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const forPublication = process.argv.includes("--for-publication");
  const { outDir, report } = await stageNpmPackages({
    out: arg("--out"),
    skipBuild: process.argv.includes("--skip-build"),
    plugins: arg("--plugin") ? [arg("--plugin")] : [],
  });
  for (const p of report.packages) {
    console.log(
      `  ${p.name}@${p.version}  ${p.license}  ${p.files} files  ${(p.size / 1024).toFixed(0)} KB`,
    );
  }
  console.log(`staged ${report.packages.length} packages (${report.version}): ${outDir}`);
  if (report.publishBlockers.length > 0) {
    console.log("Not publishable yet:");
    for (const blocker of report.publishBlockers) console.log(`  - ${blocker}`);
    // Staging for publication fails closed: nothing is handed on while anything blocks it.
    if (forPublication) {
      console.error("Staging for publication refused: resolve the blockers above first.");
      process.exitCode = 1;
    }
  }
}
