// SPDX-License-Identifier: Apache-2.0
// The Local Console builds to static files that `pathrule ui` serves from 127.0.0.1.
// Everything is bundled: the page loads nothing from the internet. The CLI package carries the
// build as it is (scripts/build-npm-package.mjs), so the licence notices of the packages it inlines
// are written into it, and a package without an approved licence fails the build.
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// @ts-expect-error - JS helper without types; rebuilds the licence notices of inlined packages.
import { thirdPartyNoticesVite } from "../../scripts/third-party-notices.mjs";

const pkg = (name: string) => fileURLToPath(new URL(`../${name}/src`, import.meta.url));
const viteDir = dirname(createRequire(import.meta.url).resolve("vite/package.json"));

export default defineConfig({
  plugins: [
    react(),
    thirdPartyNoticesVite({
      fileName: "THIRD_PARTY_NOTICES.md",
      product: "The Pathrule Local Console",
      viteDir,
    }),
  ],
  base: "/",
  resolve: {
    alias: [
      { find: /^@pathrule\/protocol\/(.*)\.js$/, replacement: `${pkg("protocol")}/$1.ts` },
      { find: /^@pathrule\/ui\/styles\.css$/, replacement: `${pkg("ui")}/styles.css` },
      { find: /^@pathrule\/ui\/signals$/, replacement: `${pkg("ui")}/signals/index.ts` },
      { find: /^@pathrule\/ui$/, replacement: `${pkg("ui")}/index.ts` },
    ],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 900,
  },
  server: {
    host: "127.0.0.1",
  },
});
