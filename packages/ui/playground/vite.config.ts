// SPDX-License-Identifier: Apache-2.0
// The component playground: a development app, never part of the published library.
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  base: "./",
  build: {
    outDir: fileURLToPath(new URL("../dist/playground", import.meta.url)),
    emptyOutDir: true,
  },
  server: { host: "127.0.0.1" },
});
