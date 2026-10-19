// Build-time `define` constants for the CLI and its plugins. Anything they write to disk at runtime
// (the hook script, its helper, the hook's extensions) is baked into the build here, so it does not
// depend on where the files are installed.
//
// Every CLI bundle (scripts/bundle-cli.mjs: npm, standalone, Homebrew, the VS Code extension's copy)
// takes the same defines: the hook and its embed helper, the provider plugin's assets, and Pathrule
// Cloud's (the hook's cloud extensions, the production Cloud and its device client, and the product
// telemetry key). They are publishable values only.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const HOOK_SCRIPT_SOURCE_PATH = resolve(
  REPO_ROOT,
  "packages",
  "integrations",
  "src",
  "hook-supervisor",
  "pathrule-hook.js",
);
// The hook spawns this helper to embed the prompt for relevance ranking; it
// must land next to pathrule-hook.js or semantic injection silently falls back
// to lexical. Like the hook, it ships as a baked-in source string.
const EMBED_HELPER_SOURCE_PATH = resolve(
  REPO_ROOT,
  "packages",
  "integrations",
  "src",
  "hook-supervisor",
  "embed-query.cjs",
);

/**
 * The hook's extensions and their helper, written next to the hook when Pathrule Cloud is composed
 * (contract: packages/protocol/src/hook-extension.ts): the cloud extension and its ranking helper,
 * which the cloud plugin ships. Without Cloud the hook runs its local defaults.
 */
export const CLOUD_HOOK_EXTENSIONS = {
  "pathrule-hook-cloud.cjs": resolve(REPO_ROOT, "packages/cloud/src/hook-supervisor/pathrule-hook-cloud.cjs"),
  "cloud-semantic-query.cjs": resolve(REPO_ROOT, "packages/cloud/src/hook-supervisor/cloud-semantic-query.cjs"),
};

const CLI_PACKAGE_JSON_PATH = resolve(REPO_ROOT, "packages", "cli", "package.json");
// The provider plugin's own files the runtime writes into the marketplace it materializes
// (packages/cli/src/integrations/plugin-assets.ts). Open source only: the launcher and the setup
// script are Node built-ins, the licence texts are the open package's, the icon is base64.
const NATIVE_PLUGIN_ICON_PATH = resolve(REPO_ROOT, "packages/integrations/src/native/assets/icon.png");
const NATIVE_PLUGIN_ASSET_PATHS = {
  launcher: resolve(REPO_ROOT, "packages/integrations/src/native/assets/pathrule-launch.cjs"),
  setup: resolve(REPO_ROOT, "packages/integrations/src/native/assets/pathrule-setup.cjs"),
  license: resolve(REPO_ROOT, "packages/integrations/LICENSE"),
  notice: resolve(REPO_ROOT, "packages/integrations/NOTICE"),
};

/** The defines of every CLI bundle. */
export function cliBuildDefines() {
  return { ...cliPackageDefines(), ...cloudPackageDefines() };
}

/** The same, for a build script that logs what it bakes in (the VS Code extension's). */
export function loadBuildTimeCliDefines() {
  return { define: cliBuildDefines() };
}

// The same defines, split by the package whose sources read them.

/** The CLI's: its version, and the hook and embed helper `pathrule install` writes. */
export function cliPackageDefines() {
  return {
    // The bundle may not sit beside packages/cli/package.json (the VS Code extension's does not).
    __PATHRULE_CLI_VERSION__: JSON.stringify(JSON.parse(readFileSync(CLI_PACKAGE_JSON_PATH, "utf8")).version),
    __BUILD_HOOK_SCRIPT_SOURCE__: JSON.stringify(readFileSync(HOOK_SCRIPT_SOURCE_PATH, "utf8")),
    __BUILD_EMBED_HELPER_SOURCE__: JSON.stringify(readFileSync(EMBED_HELPER_SOURCE_PATH, "utf8")),
    __BUILD_NATIVE_PLUGIN_ASSETS__: JSON.stringify({
      ...Object.fromEntries(Object.entries(NATIVE_PLUGIN_ASSET_PATHS).map(([k, p]) => [k, readFileSync(p, "utf8")])),
      icon: readFileSync(NATIVE_PLUGIN_ICON_PATH).toString("base64"),
      opencode: readFileSync(resolve(REPO_ROOT, "packages/integrations/src/native/assets/opencode-plugin.js"), "utf8"),
    }),
  };
}

function readSources(files) {
  return Object.fromEntries(Object.entries(files).map(([name, path]) => [name, readFileSync(path, "utf8")]));
}

/** Pathrule Cloud in production. */
export const NATIVE_CLOUD_URL = "https://cloud.pathrule.io";
export const NATIVE_DEVICE_CLIENT_ID = "pathrule-cli-production";

/**
 * The cloud's: the account's client configuration and the hook's cloud extensions. No PostHog key:
 * Pathrule on a person's machine sends no product telemetry (owner decision 2026-10-19), and PostHog
 * serves Pathrule Cloud's own analytics only. So nothing in the environment changes what the CLI,
 * the MCP server or the extension is built from, and a local build and CI build the same bytes.
 */
export function cloudPackageDefines() {
  return {
    __BUILD_CLOUD_HOOK_EXTENSIONS__: JSON.stringify(readSources(CLOUD_HOOK_EXTENSIONS)),
    // Pathrule Cloud (the Cloudflare Worker) is the account's backend from v1 on: the production
    // origin and its first-party device client. A staging or shadow build names its own with
    // PATHRULE_NATIVE_CLOUD_URL and PATHRULE_NATIVE_DEVICE_CLIENT_ID.
    __BUILD_NATIVE_CLOUD_URL__: JSON.stringify(
      (process.env.PATHRULE_NATIVE_CLOUD_URL ?? NATIVE_CLOUD_URL).trim(),
    ),
    __BUILD_NATIVE_DEVICE_CLIENT_ID__: JSON.stringify(
      (process.env.PATHRULE_NATIVE_DEVICE_CLIENT_ID ?? NATIVE_DEVICE_CLIENT_ID).trim(),
    ),
  };
}
