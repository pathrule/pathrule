// SPDX-License-Identifier: Apache-2.0
// What a first look at a project finds, and the knowledge it suggests seeding. Pure shapes. The
// deterministic detection is the host's (`@pathrule/host/project/fingerprint.ts`); the seeds are the
// engine's (`KnowledgeProducer.suggestSeeds`); a renderer only type-imports them.
//
// Each seed is a structured, LANGUAGE-FREE descriptor: a stable `id` the renderer maps to an i18n
// title/body template, the target `nodePath` (path-first write; missing nodes auto-create), and the
// facts to interpolate. Keeping prose out of the producer is what lets the card localize every string.

/** The project's brand, as the surface's brand detector reports it. */
export interface ProjectBrandFacts {
  /** Distinct brand colours (hex / oklch / hsl), primary-first. */
  colors: string[];
  /** Font families the project already uses. */
  fonts: string[];
  /** Workspace-relative path of the detected logo, or null. */
  logoPath: string | null;
  /** True when the logo was small enough to inline verbatim in the prompt. */
  logoInlined: boolean;
  /** Verified icon package detected from the project's dependencies. */
  iconLib?: string | null;
  /** Geometry contract for the detected icon package. */
  iconStyle?: string | null;
}

export interface ProjectFingerprint {
  stack: {
    /** Most specific app framework marker present (e.g. "Next.js"), or null. */
    framework: string | null;
    /** Runtime the project targets ("Node.js" | "Bun" | "Deno"), or null. */
    runtime: string | null;
    /** Friendly labels for well-known dependencies actually in package.json. */
    deps: string[];
    /** True when the repo is a workspace/monorepo. */
    monorepo: boolean;
    /** The project's own `scripts.test`, when it's a real (non-placeholder) command. */
    testCommand: string | null;
  };
  brand: ProjectBrandFacts;
  /** Marker files that prove which platforms this repo can actually build
   *  (xcodeproj, build.gradle, pubspec.yaml, app.json). A design's own platform is
   *  negotiated against these, and a disagreement becomes a question rather than a guess.
   *  Names only, no paths: this is evidence, not a file listing. */
  platformMarkers: string[];
  map: {
    /** Meaningful top-level directories (skips build/vendor/dot dirs). */
    topDirs: string[];
    /** Detected entry-point files, workspace-relative. */
    entryPoints: string[];
    /** Monorepo package/app directory paths, workspace-relative. */
    packages: string[];
  };
  existing: {
    hasClaudeMd: boolean;
    hasRules: boolean;
  };
}

export type SeedSuggestion =
  | {
      id: "stack-overview";
      kind: "memory";
      nodePath: string;
      data: { framework: string | null; runtime: string | null; deps: string[]; monorepo: boolean };
    }
  | {
      id: "brand-summary";
      kind: "memory";
      nodePath: string;
      data: { colors: string[]; fonts: string[]; logoPath: string | null };
    }
  | {
      id: "test-command";
      kind: "memory";
      nodePath: string;
      data: { command: string };
    }
  | {
      id: "structure-map";
      kind: "memory";
      nodePath: string;
      data: { topDirs: string[]; packages: string[] };
    };

/** What a surface shows for a project: the fingerprint plus its seeds. Computed where the files are,
 *  so a renderer never bundles the node:fs-backed detector. */
export interface ProjectFingerprintResult {
  fingerprint: ProjectFingerprint;
  seeds: SeedSuggestion[];
}
