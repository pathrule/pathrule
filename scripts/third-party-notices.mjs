// Third-party licence notices for the bundles Pathrule distributes (the CLI, the VS Code
// extension, the Remote MCP build).
//
// A bundle inlines its dependencies, and their licences (MIT, ISC, BSD, Apache-2.0) require the
// copyright and permission notice to travel with every copy. esbuild's `legalComments` keeps
// only comments marked @license or @preserve, which most packages do not have, so the notice is
// rebuilt from the bundle's metafile instead: every input under node_modules names a package,
// and that package's own licence file (and NOTICE, for Apache-2.0) is reproduced as shipped.
//
// Used as an esbuild plugin (tsup takes it through `esbuildPlugins`), and as a Vite plugin for the
// Local Console the CLI serves (`thirdPartyNoticesVite`, from the Rollup bundle's modules). In
// strict mode a package with no licence, a licence outside PERMISSIVE, or no licence text fails the
// build, so a new dependency cannot slip into a distributed bundle without its notice.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Licences whose terms a bundled copy satisfies by carrying the notice. */
export const PERMISSIVE = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "Python-2.0",
  "Unlicense",
]);

/**
 * Licence texts for packages that publish to npm without a licence file, taken from their
 * source repository and kept in scripts/third-party-licenses/. Keyed by package name; each
 * entry records where the text came from, and applies only while the package declares `license`.
 */
const UPSTREAM_LICENSES = {
  // https://github.com/radix-ui/primitives/blob/main/LICENSE (fetched 2026-10-09), the root licence
  // of the monorepo these packages publish from; its other packages ship the same text.
  ...Object.fromEntries(
    [
      "react-compose-refs",
      "react-context",
      "react-direction",
      "react-id",
      "react-use-callback-ref",
      "react-use-escape-keydown",
      "react-use-layout-effect",
      "react-use-size",
    ].map((p) => [
      `@radix-ui/${p}`,
      { file: "radix-ui-primitives.LICENSE", license: "MIT", source: "https://github.com/radix-ui/primitives" },
    ]),
  ),
  // https://github.com/theKashey/react-remove-scroll-bar/blob/master/LICENSE (fetched 2026-10-09).
  "react-remove-scroll-bar": {
    file: "react-remove-scroll-bar.LICENSE",
    license: "MIT",
    source: "https://github.com/theKashey/react-remove-scroll-bar",
  },
};
const UPSTREAM_DIR = fileURLToPath(new URL("./third-party-licenses/", import.meta.url));

const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:[-.][\w.-]*)?$/i;
const NOTICE_FILE = /^notice(?:\.(?:md|txt))?$/i;
const NODE_MODULES = `${sep}node_modules${sep}`;

/** The package directory and name that own a file under node_modules, or null. */
export function packageRootOf(absPath) {
  const idx = absPath.lastIndexOf(NODE_MODULES);
  if (idx === -1) return null;
  const parts = absPath.slice(idx + NODE_MODULES.length).split(sep);
  const name = parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
  if (!name) return null;
  return { name, dir: absPath.slice(0, idx + NODE_MODULES.length) + name.split("/").join(sep) };
}

/** Package directories behind every node_modules input of an esbuild metafile. */
export function packageDirsFromMetafile(metafile, absWorkingDir) {
  const dirs = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    // Namespaced inputs (`<runtime>`, `(disabled):x`) are not files.
    if (/^[<(]/.test(input)) continue;
    const owner = packageRootOf(resolve(absWorkingDir, input));
    if (owner) dirs.add(owner.dir);
  }
  return [...dirs];
}

function licenseIdOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license.trim();
  if (pkg.license && typeof pkg.license.type === "string") return pkg.license.type.trim();
  if (Array.isArray(pkg.licenses)) {
    const ids = pkg.licenses.map((l) => (typeof l === "string" ? l : l?.type)).filter(Boolean);
    if (ids.length) return ids.length === 1 ? ids[0] : `(${ids.join(" OR ")})`;
  }
  return null;
}

/** True when an SPDX expression can be satisfied with permissive licences only. */
export function isPermissive(expression) {
  if (!expression) return false;
  const flat = expression.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  return flat
    .split(/ OR /i)
    .some((alternative) => alternative.split(/ AND /i).every((id) => PERMISSIVE.has(id.trim())));
}

/** One notice entry per package directory, with any problem that makes it unfit to ship. */
export function readNotice(dir) {
  const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
  const files = readdirSync(dir).sort();
  const read = (re) =>
    files
      .filter((f) => re.test(f))
      .map((f) => readFileSync(resolve(dir, f), "utf8").trim())
      .filter(Boolean);
  const license = licenseIdOf(pkg);
  const licenseTexts = read(LICENSE_FILE);
  let licenseSource = null;
  const upstream = UPSTREAM_LICENSES[pkg.name];
  if (licenseTexts.length === 0 && upstream && upstream.license === license) {
    licenseTexts.push(readFileSync(resolve(UPSTREAM_DIR, upstream.file), "utf8").trim());
    licenseSource = upstream.source;
  }
  const problems = [];
  if (!license) problems.push("declares no licence");
  else if (!isPermissive(license)) problems.push(`licence "${license}" is not in the permissive list`);
  if (licenseTexts.length === 0) problems.push("ships no licence file");
  return {
    name: pkg.name,
    version: pkg.version,
    license: license ?? "UNKNOWN",
    licenseTexts,
    licenseSource,
    noticeTexts: read(NOTICE_FILE),
    problems,
  };
}

/** Deduplicated, sorted notices for a set of package directories. */
export function collectNotices(dirs) {
  const byId = new Map();
  for (const dir of dirs) {
    const notice = readNotice(dir);
    byId.set(`${notice.name}@${notice.version}`, notice);
  }
  return [...byId.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

const fence = (text) => "```text\n" + text.replace(/```/g, "'''") + "\n```";

export function renderNotices(product, notices) {
  const lines = [
    "# Third-party notices",
    "",
    `${product} includes code from the third-party packages below. Each one is used under its own licence, reproduced here as the package ships it.`,
    "",
    `${notices.length} packages.`,
  ];
  for (const n of notices) {
    lines.push("", "---", "", `## ${n.name} ${n.version}`, "", `Licence: ${n.license}`);
    if (n.licenseSource) {
      lines.push("", `The npm package ships no licence file; this is the licence of its source repository, ${n.licenseSource}.`);
    }
    for (const text of n.licenseTexts) lines.push("", fence(text));
    for (const text of n.noticeTexts) lines.push("", "NOTICE:", "", fence(text));
  }
  return lines.join("\n") + "\n";
}

/**
 * Package directories behind the modules of a Rollup bundle (what Vite builds a web app with).
 * Every module of every chunk counts, including code tree-shaking emptied, so the list can only err
 * on the side of an extra notice. Vite's own helpers enter as virtual modules (`\0vite/...`,
 * `\0commonjsHelpers.js`) and are Vite's code, so `viteDir` stands for them.
 */
export function packageDirsFromRollupBundle(bundle, { viteDir } = {}) {
  const dirs = new Set();
  for (const output of Object.values(bundle)) {
    if (output.type !== "chunk") continue;
    for (const raw of Object.keys(output.modules)) {
      const id = raw.replace(/^\0/, "").replace(/\?.*$/, "");
      if (raw.startsWith("\0") && /^(?:vite\/|commonjsHelpers)/.test(id)) {
        if (!viteDir) throw new Error(`the bundle holds Vite's ${id}; pass viteDir`);
        dirs.add(viteDir);
        continue;
      }
      const owner = packageRootOf(resolve(id));
      if (owner) dirs.add(owner.dir);
    }
  }
  return [...dirs];
}

/**
 * Vite (Rollup) plugin for a web app the CLI serves: emits `fileName` into the build beside the
 * app's files, with the same strict check as the esbuild plugin below.
 */
export function thirdPartyNoticesVite({ fileName, product, viteDir, strict = true }) {
  return {
    name: "pathrule-third-party-notices",
    apply: "build",
    generateBundle(_options, bundle) {
      const dirs = packageDirsFromRollupBundle(bundle, { viteDir });
      const notices = collectNotices(dirs.filter((d) => existsSync(resolve(d, "package.json"))));
      const problems = notices.flatMap((n) => n.problems.map((p) => `${n.name}@${n.version} ${p}`));
      if (problems.length > 0 && strict) {
        this.error(
          `third-party notices for ${product}: ${problems.length} package(s) cannot ship without review:\n  ` +
            problems.join("\n  "),
        );
      }
      for (const p of problems) this.warn(`${product}: ${p}`);
      this.emitFile({ type: "asset", fileName, source: renderNotices(product, notices) });
    },
  };
}

/**
 * esbuild plugin: writes `outFile` after a successful build.
 * `extraPackageDirs` adds packages that ship beside the bundle rather than inside it.
 */
export function thirdPartyNotices({ outFile, product, extraPackageDirs = [], strict = true }) {
  return {
    name: "pathrule-third-party-notices",
    setup(build) {
      build.initialOptions.metafile = true;
      build.onEnd((result) => {
        if (result.errors.length > 0 || !result.metafile) return;
        const cwd = build.initialOptions.absWorkingDir ?? process.cwd();
        const dirs = [...packageDirsFromMetafile(result.metafile, cwd), ...extraPackageDirs];
        const notices = collectNotices(dirs.filter((d) => existsSync(resolve(d, "package.json"))));
        const problems = notices.flatMap((n) => n.problems.map((p) => `${n.name}@${n.version} ${p}`));
        if (problems.length > 0 && strict) {
          throw new Error(
            `third-party notices for ${product}: ${problems.length} package(s) cannot ship without review:\n  ` +
              problems.join("\n  "),
          );
        }
        for (const p of problems) console.warn(`[third-party-notices] ${product}: ${p}`);
        mkdirSync(dirname(outFile), { recursive: true });
        writeFileSync(outFile, renderNotices(product, notices));
      });
    },
  };
}
