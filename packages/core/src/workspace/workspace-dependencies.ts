// SPDX-License-Identifier: Apache-2.0
/**
 * The third-party libraries a workspace depends on, with the version actually installed.
 *
 * An expertise lease is bound to a library at a version, so "which version is this project on" has to
 * come from the disk, never from the model's memory: that gap is the whole reason a lease exists. The
 * installed version is read from `node_modules/<name>/package.json` (pnpm's symlinks resolve to the real
 * package); a manifest range is the fallback, marked as such. Workspace-internal packages (`workspace:`,
 * `file:`, `link:`) and type stubs are left out: nothing external to verify there.
 *
 * Bounded reads only: the root manifest, one level of `packages/*` and `apps/*`, and a pinned root
 * `requirements.txt`. Cached briefly per root, because this runs on the turn path.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface WorkspaceDependency {
  name: string;
  version: string;
  /** True when `version` came from the installed package, false when it is the manifest's range. */
  installed: boolean;
  ecosystem: "npm" | "pypi";
}

const MAX_MANIFESTS = 40;
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; deps: Promise<WorkspaceDependency[]> }>();

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const v = JSON.parse(await readFile(path, "utf8")) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** First `x.y.z` (or `x.y`) in a range or version string. */
export function versionFromSpec(spec: string): string | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(spec);
  return m ? m.slice(1).filter((p) => p !== undefined).join(".") : null;
}

/** The part of a version a lease is bound to: major.minor. Patch releases do not change an API. */
export function versionKey(version: string): string | null {
  const m = /(\d+)\.(\d+)/.exec(version);
  return m ? `${m[1]}.${m[2]}` : null;
}

const LOCAL_SPEC = /^(workspace:|file:|link:|portal:)/;

async function manifestDirs(root: string): Promise<string[]> {
  const dirs = [root];
  for (const group of ["packages", "apps"]) {
    try {
      const entries = await readdir(join(root, group), { withFileTypes: true });
      for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".")) dirs.push(join(root, group, e.name));
    } catch {
      // No such group: a single-package repo.
    }
  }
  return dirs.slice(0, MAX_MANIFESTS);
}

async function installedVersion(dirs: readonly string[], name: string): Promise<string | null> {
  for (const dir of dirs) {
    const pkg = await readJson(join(dir, "node_modules", name, "package.json"));
    if (pkg && typeof pkg["version"] === "string") return pkg["version"];
  }
  return null;
}

async function readNpm(root: string): Promise<WorkspaceDependency[]> {
  const out = new Map<string, WorkspaceDependency>();
  for (const dir of await manifestDirs(root)) {
    const manifest = await readJson(join(dir, "package.json"));
    if (!manifest) continue;
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      const deps = manifest[field];
      if (!deps || typeof deps !== "object") continue;
      for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
        if (typeof spec !== "string" || LOCAL_SPEC.test(spec) || name.startsWith("@types/")) continue;
        if (out.get(name)?.installed) continue;
        const installed = await installedVersion(dir === root ? [root] : [dir, root], name);
        const version = installed ?? versionFromSpec(spec);
        if (!version) continue;
        out.set(name, { name, version, installed: installed !== null, ecosystem: "npm" });
      }
    }
  }
  return [...out.values()];
}

async function readPypi(root: string): Promise<WorkspaceDependency[]> {
  let text: string;
  try {
    text = await readFile(join(root, "requirements.txt"), "utf8");
  } catch {
    return [];
  }
  const out: WorkspaceDependency[] = [];
  for (const raw of text.split("\n")) {
    const m = /^\s*([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*==\s*([0-9][\w.]*)/.exec(raw);
    if (m) out.push({ name: m[1]!.toLowerCase(), version: m[2]!, installed: false, ecosystem: "pypi" });
  }
  return out;
}

export function readWorkspaceDependencies(root: string, nowMs = Date.now()): Promise<WorkspaceDependency[]> {
  const hit = cache.get(root);
  if (hit && nowMs - hit.at < CACHE_TTL_MS) return hit.deps;
  const deps = Promise.all([readNpm(root), readPypi(root)]).then(([a, b]) => [...a, ...b]).catch(() => []);
  cache.set(root, { at: nowMs, deps });
  return deps;
}

/** Test seam: forget cached roots. */
export function clearWorkspaceDependencyCache(): void {
  cache.clear();
}

/**
 * Library names that are also everyday words. They count as mentioned only in a decorated form
 * ("next.js", "nextjs", "express.js"), or "Next" in "next step" would send an agent to read docs.
 */
const AMBIGUOUS = new Set([
  "next", "express", "request", "debug", "open", "glob", "got", "ms", "ws", "sharp", "history", "path",
  "events", "util", "assert", "buffer", "process", "url", "string", "format", "color", "colors", "cookie",
  "cors", "chalk", "commander", "yaml", "uuid", "dotenv", "nock", "mime", "semver", "async", "lodash",
  "core", "test", "run", "build", "server", "client", "app", "node",
]);

/**
 * How a prompt may name one dependency, most specific first. A scoped name is unambiguous as written; a
 * bare name that is also a word, or shorter than three letters, counts only decorated ("next.js").
 */
export function dependencyAliases(name: string): string[] {
  const lower = name.toLowerCase();
  const bare = lower.replace(/^@[^/]+\//, "");
  const stem = bare.replace(/[.-]?js$/, "");
  const out = new Set<string>();
  if (lower !== bare) out.add(lower);
  for (const alias of new Set([bare, stem])) {
    if (alias.length === 0) continue;
    if (alias.length < 3 || AMBIGUOUS.has(alias)) {
      out.add(`${alias}.js`);
      out.add(`${alias}js`);
    } else {
      out.add(alias);
    }
  }
  return [...out];
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * The dependencies a task names, in the order it names them. The match is bounded on both sides so
 * "zod" does not match "zodiac", while "supabase'de" and "Supabase," still name Supabase.
 */
/**
 * Does the text name a VERSION of this dependency ("next.js 16", "react@19", "vite v6")? A number right
 * after the library's own name is the same signal in every language, unlike the words people use for
 * "upgrade" or "breaking change".
 */
export function mentionsVersionOf(dep: WorkspaceDependency, text: string): boolean {
  const lower = (text ?? "").toLowerCase();
  return dependencyAliases(dep.name).some((alias) =>
    new RegExp(`(^|[^a-z0-9@/_.-])${escape(alias)}\\s*(?:@\\s*)?v?\\d+`).test(lower),
  );
}

export function dependencyMentions(deps: readonly WorkspaceDependency[], text: string): WorkspaceDependency[] {
  const lower = (text ?? "").toLowerCase();
  if (lower.length === 0) return [];
  const found: Array<{ dep: WorkspaceDependency; at: number }> = [];
  for (const dep of deps) {
    let at = -1;
    for (const alias of dependencyAliases(dep.name)) {
      const m = new RegExp(`(^|[^a-z0-9@/_.-])${escape(alias)}(?![a-z0-9_-])`).exec(lower);
      if (m) { at = m.index; break; }
    }
    if (at >= 0) found.push({ dep, at });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.dep);
}
