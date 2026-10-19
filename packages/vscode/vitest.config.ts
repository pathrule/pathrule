// SPDX-License-Identifier: Apache-2.0
// The extension imports the CLI's modules by source through `#cli` (tsconfig paths, the esbuild
// alias); the tests resolve it the same way.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^#cli\/(.*)$/,
        replacement: fileURLToPath(new URL("../cli/src/$1", import.meta.url)),
      },
    ],
  },
});
