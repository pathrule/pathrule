// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@pathrule\/protocol\/(.+)\.js$/,
        replacement: path.resolve(__dirname, "../protocol/src/$1.ts"),
      },
      {
        find: /^@pathrule\/agent-ir\/(.+)\.js$/,
        replacement: path.resolve(__dirname, "../agent-ir/src/$1.ts"),
      },
      {
        find: /^@pathrule\/integrations\/(.+)\.js$/,
        replacement: path.resolve(__dirname, "../integrations/src/$1.ts"),
      },
      {
        find: /^@pathrule\/core\/(.+)\.js$/,
        replacement: path.resolve(__dirname, "../core/src/$1.ts"),
      },
      {
        find: "@pathrule/core",
        replacement: path.resolve(__dirname, "../core/src/index.ts"),
      },
    ],
  },
  test: {
    include: ["src/test/**/*.test.ts"],
    environment: "node",
  },
});
