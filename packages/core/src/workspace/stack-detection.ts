// SPDX-License-Identifier: Apache-2.0
//
// Stack detection
//
// Scans the file tree for well-known config files and returns memory drafts
// describing the detected technology stack. Called once at workspace bind time.

export interface StackMemoryDraft {
  title: string;
  content: string;
}

/** Map of config file glob → stack description. */
const STACK_SIGNALS: Array<{
  /** File or pattern to check (simple string match against file listing). */
  match: (files: string[]) => boolean;
  title: string;
  content: string;
}> = [
  {
    match: (f) => f.some((p) => /^next\.config\.(js|mjs|ts)$/.test(basename(p))),
    title: "Next.js project",
    content: "This workspace uses Next.js as its React framework.",
  },
  {
    match: (f) => f.some((p) => /^nuxt\.config\.(js|ts)$/.test(basename(p))),
    title: "Nuxt project",
    content: "This workspace uses Nuxt as its Vue framework.",
  },
  {
    match: (f) => f.some((p) => /^tailwind\.config\.(js|mjs|ts|cjs)$/.test(basename(p))),
    title: "Uses Tailwind CSS",
    content: "This workspace uses Tailwind CSS for styling.",
  },
  {
    match: (f) => f.some((p) => /^vite\.config\.(js|ts|mjs)$/.test(basename(p))),
    title: "Vite build tool",
    content: "This workspace uses Vite as the build tool / dev server.",
  },
  {
    match: (f) => {
      const pkgJsons = f.filter((p) => p.endsWith("/package.json") || p === "package.json");
      const hasPackagesDir = f.some((p) => p.startsWith("packages/") || p.startsWith("apps/"));
      return pkgJsons.length > 2 && hasPackagesDir;
    },
    title: "Monorepo structure",
    content:
      "This workspace is a monorepo with multiple packages/apps, each with its own package.json.",
  },
  {
    match: (f) => f.some((p) => basename(p) === "Podfile" || p.endsWith(".xcodeproj")),
    title: "iOS/macOS native project",
    content: "This workspace contains iOS/macOS native code (Xcode project or CocoaPods).",
  },
  {
    match: (f) => f.some((p) => basename(p) === "pubspec.yaml"),
    title: "Flutter project",
    content: "This workspace is a Flutter/Dart project.",
  },
  {
    match: (f) => f.some((p) => basename(p) === "Cargo.toml"),
    title: "Rust project",
    content: "This workspace contains Rust code (Cargo-managed).",
  },
  {
    match: (f) => f.some((p) => basename(p) === "go.mod"),
    title: "Go project",
    content: "This workspace is a Go module.",
  },
  {
    match: (f) => f.some((p) => /^tsconfig(\.\w+)?\.json$/.test(basename(p))),
    title: "TypeScript project",
    content: "This workspace uses TypeScript.",
  },
  {
    match: (f) =>
      f.some(
        (p) =>
          basename(p) === "docker-compose.yml" ||
          basename(p) === "docker-compose.yaml" ||
          basename(p) === "Dockerfile",
      ),
    title: "Docker containerization",
    content: "This workspace uses Docker for containerization.",
  },
  {
    match: (f) => f.some((p) => p.startsWith(".github/workflows/")),
    title: "GitHub Actions CI/CD",
    content: "This workspace uses GitHub Actions for CI/CD.",
  },
];

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] ?? p;
}

/**
 * Detect the technology stack from a flat file listing.
 * @param files — workspace-relative paths (e.g. "packages/app/next.config.ts", "go.mod")
 */
export function detectStack(files: string[]): StackMemoryDraft[] {
  return STACK_SIGNALS.filter((s) => s.match(files)).map((s) => ({
    title: s.title,
    content: s.content,
  }));
}
