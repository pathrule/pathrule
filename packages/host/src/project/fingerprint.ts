// SPDX-License-Identifier: Apache-2.0
// Deterministic PROJECT fingerprint for project scan eligibility.
//
// On first open of a workspace, Pathrule should show the user that it already
// UNDERSTANDS their codebase: the stack it runs on (framework + key deps), its
// brand (colours/fonts/logo, from the surface's brand detector), a small directory
// map, and whether it already carries a CLAUDE.md / rules.
//
// Same discipline as the brand detector it composes (bounded, cached, NEVER throws,
// zero LLM tokens), calling it rather than re-implementing the scan.
//
// COST DISCIPLINE: the extra work over brand detection is intentionally SHALLOW.
// Stack comes from the root (and monorepo package) package.json; the map is a
// single top-level readdir plus a few existence checks; `existing` is two stats.
// Result is cached per workspace root (10 min TTL) and served on repeat opens.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import type {
  ProjectBrandFacts,
  ProjectFingerprint,
} from "@pathrule/protocol/project-fingerprint.js";


export interface FingerprintDeps {
  /** The project's brand, from the surface's own detector. */
  detectBrand: (workspaceRoot: string) => Promise<ProjectBrandFacts>;
}

const EMPTY_FINGERPRINT: ProjectFingerprint = {
  stack: { framework: null, runtime: null, deps: [], monorepo: false, testCommand: null },
  platformMarkers: [],
  brand: { colors: [], fonts: [], logoPath: null, logoInlined: false },
  map: { topDirs: [], entryPoints: [], packages: [] },
  existing: { hasClaudeMd: false, hasRules: false },
};

// ---------------------------------------------------------------------------
// Marker tables (deterministic dependency -> label mapping)
// ---------------------------------------------------------------------------

// App frameworks, most-specific first. A project can carry several markers
// (e.g. electron + vite + react); we report the single highest-priority one.
const FRAMEWORK_MARKERS: Array<{ dep: string; label: string }> = [
  { dep: "expo", label: "Expo" },
  { dep: "react-native", label: "React Native" },
  { dep: "next", label: "Next.js" },
  { dep: "@remix-run/react", label: "Remix" },
  { dep: "@remix-run/node", label: "Remix" },
  { dep: "astro", label: "Astro" },
  { dep: "nuxt", label: "Nuxt" },
  { dep: "@sveltejs/kit", label: "SvelteKit" },
  { dep: "svelte", label: "Svelte" },
  { dep: "@nestjs/core", label: "NestJS" },
  { dep: "electron", label: "Electron" },
  { dep: "vite", label: "Vite" },
  { dep: "express", label: "Express" },
  { dep: "fastify", label: "Fastify" },
  { dep: "@angular/core", label: "Angular" },
  { dep: "vue", label: "Vue" },
  { dep: "react", label: "React" },
];

// Well-known non-framework dependencies worth surfacing as "key deps".
const KEY_DEP_MARKERS: Array<{ dep: string; label: string }> = [
  { dep: "@supabase/supabase-js", label: "Supabase" },
  { dep: "supabase", label: "Supabase" },
  { dep: "firebase", label: "Firebase" },
  { dep: "@prisma/client", label: "Prisma" },
  { dep: "prisma", label: "Prisma" },
  { dep: "drizzle-orm", label: "Drizzle" },
  { dep: "mongoose", label: "MongoDB (Mongoose)" },
  { dep: "@trpc/server", label: "tRPC" },
  { dep: "@tanstack/react-query", label: "TanStack Query" },
  { dep: "graphql", label: "GraphQL" },
  { dep: "@apollo/client", label: "Apollo" },
  { dep: "tailwindcss", label: "Tailwind CSS" },
  { dep: "@mui/material", label: "MUI" },
  { dep: "@chakra-ui/react", label: "Chakra UI" },
  { dep: "stripe", label: "Stripe" },
  { dep: "@stripe/stripe-js", label: "Stripe" },
  { dep: "zustand", label: "Zustand" },
  { dep: "redux", label: "Redux" },
  { dep: "@reduxjs/toolkit", label: "Redux Toolkit" },
  { dep: "vitest", label: "Vitest" },
  { dep: "jest", label: "Jest" },
  { dep: "playwright", label: "Playwright" },
  { dep: "@playwright/test", label: "Playwright" },
  { dep: "cypress", label: "Cypress" },
];

const MAX_KEY_DEPS = 8;

// Directories that never describe the project's own structure.
const SKIP_TOP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  ".turbo",
  ".cache",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  "Pods",
  "tmp",
]);

// Candidate entry points, checked shallowly in priority order.
const ENTRY_CANDIDATES = [
  "app/page.tsx",
  "app/layout.tsx",
  "pages/index.tsx",
  "pages/index.ts",
  "src/main.tsx",
  "src/main.ts",
  "src/index.tsx",
  "src/index.ts",
  "src/app.tsx",
  "src/App.tsx",
  "src/server.ts",
  "server.ts",
  "index.html",
  "index.ts",
  "index.js",
  "main.ts",
];
const MAX_ENTRY_POINTS = 4;
const MAX_PACKAGES = 12;

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  main?: string;
  module?: string;
}

async function readJson(file: string): Promise<PackageJson | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function dirHasEntries(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

/** A test script that actually runs something (npm's default placeholder does not). */
function realTestCommand(pkg: PackageJson | null): string | null {
  const cmd = pkg?.scripts?.test?.trim();
  if (!cmd) return null;
  if (/^echo\b.*exit\s+1/i.test(cmd)) return null; // npm init placeholder
  return cmd;
}

function collectDeps(pkg: PackageJson | null): Record<string, string> {
  if (!pkg) return {};
  return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
}

function detectFramework(deps: Record<string, string>): string | null {
  for (const { dep, label } of FRAMEWORK_MARKERS) {
    if (deps[dep]) return label;
  }
  return null;
}

function detectKeyDeps(deps: Record<string, string>): string[] {
  const out: string[] = [];
  for (const { dep, label } of KEY_DEP_MARKERS) {
    if (deps[dep] && !out.includes(label)) out.push(label);
    if (out.length >= MAX_KEY_DEPS) break;
  }
  return out;
}

async function detectRuntime(root: string, hasPackageJson: boolean): Promise<string | null> {
  if (await pathExists(join(root, "bun.lockb"))) return "Bun";
  if ((await pathExists(join(root, "deno.json"))) || (await pathExists(join(root, "deno.jsonc")))) {
    return "Deno";
  }
  return hasPackageJson ? "Node.js" : null;
}

async function detectMonorepo(root: string, pkg: PackageJson | null): Promise<boolean> {
  if (pkg?.workspaces) return true;
  if (await pathExists(join(root, "pnpm-workspace.yaml"))) return true;
  if (await pathExists(join(root, "turbo.json"))) return true;
  if (await pathExists(join(root, "lerna.json"))) return true;
  return false;
}

async function detectTopDirs(root: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_TOP_DIRS.has(e.name))
    .map((e) => e.name)
    .sort();
}

async function detectEntryPoints(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const rel of ENTRY_CANDIDATES) {
    if (found.length >= MAX_ENTRY_POINTS) break;
    if (await pathExists(join(root, rel))) found.push(rel);
  }
  return found;
}

/** Immediate subdirectories of common monorepo roots (packages/, apps/). */
async function detectPackages(root: string, monorepo: boolean): Promise<string[]> {
  if (!monorepo) return [];
  const out: string[] = [];
  for (const base of ["packages", "apps"]) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(join(root, base), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (out.length >= MAX_PACKAGES) break;
      if (e.isDirectory() && !e.name.startsWith(".")) out.push(`${base}/${e.name}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API (cached)
// ---------------------------------------------------------------------------

interface CacheEntry {
  result: ProjectFingerprint;
  ts: number;
}
const CACHE = new Map<string, CacheEntry>();
const TTL_MS = 10 * 60 * 1000;

/** Detect the current project's fingerprint. Best-effort, bounded, cached; never throws. */
export async function detectProjectFingerprint(
  workspaceRoot: string,
  deps: FingerprintDeps,
): Promise<ProjectFingerprint> {
  if (!workspaceRoot || !workspaceRoot.startsWith("/")) return EMPTY_FINGERPRINT;
  const cached = CACHE.get(workspaceRoot);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.result;
  let result = EMPTY_FINGERPRINT;
  try {
    result = await scan(workspaceRoot, deps.detectBrand);
  } catch {
    result = EMPTY_FINGERPRINT;
  }
  CACHE.set(workspaceRoot, { result, ts: Date.now() });
  return result;
}

async function scan(
  root: string,
  detectBrand: FingerprintDeps["detectBrand"],
): Promise<ProjectFingerprint> {
  const pkgPath = join(root, "package.json");
  const pkg = await readJson(pkgPath);
  const hasPackageJson = pkg !== null;
  const deps = collectDeps(pkg);

  const monorepo = await detectMonorepo(root, pkg);
  const [runtime, topDirs, entryPoints, packages, hasClaudeMd, hasRules] = await Promise.all([
    detectRuntime(root, hasPackageJson),
    detectTopDirs(root),
    detectEntryPoints(root),
    detectPackages(root, monorepo),
    pathExists(join(root, "CLAUDE.md")),
    dirHasEntries(join(root, ".claude", "rules")),
  ]);
  const platformMarkers = await detectPlatformMarkers(root);

  // In a monorepo the root package.json is usually just tooling (the real app
  // deps live in the packages), so enrich the dep map from the workspace packages
  // before detecting framework / key deps. Bounded by detectPackages' cap.
  const mergedDeps: Record<string, string> = { ...deps };
  if (monorepo && packages.length > 0) {
    const subs = await Promise.all(
      packages.map((rel) => readJson(join(root, rel, "package.json"))),
    );
    for (const sub of subs) Object.assign(mergedDeps, collectDeps(sub));
  }

  // Brand rides the surface's own detector (its own bounded/cached scan).
  const brand = await detectBrand(root);

  return {
    stack: {
      framework: detectFramework(mergedDeps),
      runtime,
      deps: detectKeyDeps(mergedDeps),
      monorepo,
      testCommand: realTestCommand(pkg),
    },
    brand,
    platformMarkers,
    map: { topDirs, entryPoints, packages },
    existing: { hasClaudeMd, hasRules },
  };
}

/** Marker files that prove a buildable platform.
 *
 *  Only the repo ROOT and one level of well-known app directories are checked: a deep scan
 *  would be the expensive thing this whole module avoids, and a project that keeps its
 *  xcodeproj five levels down is rare enough to answer with a question instead. */
async function detectPlatformMarkers(root: string): Promise<string[]> {
  const EXACT = [
    "Package.swift",
    "Podfile",
    "build.gradle",
    "build.gradle.kts",
    "pubspec.yaml",
    "app.json",
  ];
  const DIRS = ["", "ios", "android", "apps", "app", "mobile"];
  const found = new Set<string>();
  await Promise.all(
    DIRS.map(async (dir) => {
      const base = dir ? join(root, dir) : root;
      let entries: string[];
      try {
        entries = await fs.readdir(base);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (EXACT.includes(entry) || /\.(xcodeproj|xcworkspace)$/i.test(entry)) found.add(entry);
      }
    }),
  );
  return [...found].slice(0, 12);
}
