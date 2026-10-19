// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "tsup";

// The open server as a standalone stdio bin for local development (`pnpm build:bin`, the dev
// harness): the local store, no plugins. The CLI builds its own entry with its plugins. The npm
// package is `pnpm build` (dist/).
export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist-bin",
  format: ["esm"],
  target: "node18",
  platform: "node",
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: false,
  // Bundle every runtime dependency EXCEPT better-sqlite3: it ships a native `.node` binary and
  // loads its CJS via dynamic require, which an ESM bundle cannot inline — the bundler's require
  // shim throws "Dynamic require of fs is not supported" at startup. Kept external and resolved
  // from node_modules at runtime. `external` alone is not enough — a blanket `noExternal: [/.*/]`
  // would force it back in, so the pattern must skip it too.
  external: ["better-sqlite3"],
  noExternal: [/^(?!better-sqlite3(\/|$)).+/],
  banner: { js: "#!/usr/bin/env node" },
});
