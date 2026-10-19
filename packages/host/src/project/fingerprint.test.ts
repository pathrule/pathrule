// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectBrandFacts } from "@pathrule/protocol/project-fingerprint.js";

import { detectProjectFingerprint as detect, type FingerprintDeps } from "./fingerprint.js";

// mkdtemp gives each test a unique root, so the per-root cache never crosses
// tests (mirrors project-brand.test.ts). No cleanup - OS tmp self-expires.
async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pathrule-fingerprint-"));
}

/** The surface's brand detector, recorded: the host only passes its answer through. */
const BRAND: ProjectBrandFacts = {
  colors: ["#1e5eff"],
  fonts: ["Space Grotesk"],
  logoPath: "public/logo.svg",
  logoInlined: true,
};
const brandCalls: string[] = [];
const deps: FingerprintDeps = {
  detectBrand: async (root) => {
    brandCalls.push(root);
    return BRAND;
  },
};
const detectProjectFingerprint = (root: string) => detect(root, deps);


describe("detectProjectFingerprint", () => {
  it("detects a Next.js + Supabase app, its structure, and takes the brand from the surface's detector", async () => {
    const root = await scratch();
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "app"), { recursive: true });
    await mkdir(join(root, "public"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "acme-web",
        scripts: { test: "vitest run", dev: "next dev" },
        dependencies: {
          next: "^15.0.0",
          react: "^19.0.0",
          "@supabase/supabase-js": "^2.0.0",
          tailwindcss: "^4.0.0",
        },
      }),
    );
    await writeFile(
      join(root, "app", "page.tsx"),
      "export default function Page() { return null; }\n",
    );
    await writeFile(
      join(root, "src", "globals.css"),
      `:root {\n  --primary: #1E5EFF;\n}\nbody { font-family: "Space Grotesk", sans-serif; }\n`,
    );
    await writeFile(
      join(root, "public", "logo.svg"),
      `<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>`,
    );

    const fp = await detectProjectFingerprint(root);

    // Stack: most-specific framework wins over the bare react marker.
    expect(fp.stack.framework).toBe("Next.js");
    expect(fp.stack.runtime).toBe("Node.js");
    expect(fp.stack.deps).toContain("Supabase");
    expect(fp.stack.deps).toContain("Tailwind CSS");
    expect(fp.stack.monorepo).toBe(false);
    expect(fp.stack.testCommand).toBe("vitest run");

    // Brand is the surface's detector's answer, asked once for the root.
    expect(fp.brand).toEqual(BRAND);
    expect(brandCalls).toContain(root);

    // Map + existing knowledge.
    expect(fp.map.topDirs).toEqual(expect.arrayContaining(["app", "public", "src"]));
    expect(fp.map.entryPoints).toContain("app/page.tsx");
    expect(fp.existing.hasClaudeMd).toBe(false);
  });

  it("detects a monorepo and derives package paths", async () => {
    const root = await scratch();
    await mkdir(join(root, "packages", "app"), { recursive: true });
    await mkdir(join(root, "packages", "shared"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "acme",
        workspaces: ["packages/*"],
        devDependencies: { electron: "^30.0.0" },
      }),
    );

    const fp = await detectProjectFingerprint(root);
    expect(fp.stack.monorepo).toBe(true);
    expect(fp.stack.framework).toBe("Electron");
    expect(fp.map.packages).toEqual(expect.arrayContaining(["packages/app", "packages/shared"]));
  });

  it("enriches stack from workspace packages when the root package.json is bare", async () => {
    const root = await scratch();
    await mkdir(join(root, "packages", "app"), { recursive: true });
    await mkdir(join(root, "packages", "shared"), { recursive: true });
    // Root is tooling-only (no app deps) - the real stack lives in the packages.
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "acme", workspaces: ["packages/*"] }),
    );
    await writeFile(
      join(root, "packages", "app", "package.json"),
      JSON.stringify({ dependencies: { next: "^15.0.0", "@supabase/supabase-js": "^2.0.0" } }),
    );

    const fp = await detectProjectFingerprint(root);
    expect(fp.stack.monorepo).toBe(true);
    expect(fp.stack.framework).toBe("Next.js");
    expect(fp.stack.deps).toContain("Supabase");
  });

  it("notices a CLAUDE.md that already documents the project", async () => {
    const root = await scratch();
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "docs"), { recursive: true });
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { vite: "^5.0.0" } }),
    );
    await writeFile(join(root, "CLAUDE.md"), "# Project\n");

    const fp = await detectProjectFingerprint(root);
    expect(fp.existing.hasClaudeMd).toBe(true);
  });

  it("returns a minimal fingerprint for an empty repo", async () => {
    const root = await scratch();
    await writeFile(join(root, "README.md"), "# just docs\n");

    const fp = await detectProjectFingerprint(root);
    expect(fp.stack.framework).toBeNull();
    expect(fp.stack.runtime).toBeNull();
    expect(fp.stack.deps).toEqual([]);
    expect(fp.stack.testCommand).toBeNull();
    expect(fp.map.topDirs).toEqual([]);
  });

  it("ignores the npm placeholder test script", async () => {
    const root = await scratch();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
        dependencies: { vue: "^3.0.0" },
      }),
    );
    const fp = await detectProjectFingerprint(root);
    expect(fp.stack.testCommand).toBeNull();
  });

  it("is empty, without a scan, for a root that is not absolute", async () => {
    const before = brandCalls.length;
    const fp = await detectProjectFingerprint("relative/path");
    expect(fp.stack.framework).toBeNull();
    expect(brandCalls.length).toBe(before);
  });
});
