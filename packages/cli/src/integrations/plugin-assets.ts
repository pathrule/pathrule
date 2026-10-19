// SPDX-License-Identifier: Apache-2.0
// The provider plugin's own files (the launcher, the setup script, the licence texts), which this
// runtime writes into the plugin marketplace it materializes. A build bakes them in
// (`__BUILD_NATIVE_PLUGIN_ASSETS__`, scripts/build-time-cli-defines.mjs) so they do not depend on
// where the CLI is installed; run from source, they are read from this checkout.
import { readFile } from "node:fs/promises";

import type { PluginBundleInput } from "@pathrule/integrations/native/plugin-bundle.js";

declare const __BUILD_NATIVE_PLUGIN_ASSETS__: PluginBundleInput["assets"] | undefined;

async function fromCheckout(rel: string): Promise<string> {
  return readFile(new URL(`../../../integrations/${rel}`, import.meta.url), "utf8");
}

export async function nativePluginAssets(): Promise<PluginBundleInput["assets"]> {
  if (typeof __BUILD_NATIVE_PLUGIN_ASSETS__ === "object" && __BUILD_NATIVE_PLUGIN_ASSETS__ !== null) {
    return __BUILD_NATIVE_PLUGIN_ASSETS__;
  }
  const [launcher, setup, license, notice] = await Promise.all([
    fromCheckout("src/native/assets/pathrule-launch.cjs"),
    fromCheckout("src/native/assets/pathrule-setup.cjs"),
    fromCheckout("LICENSE"),
    fromCheckout("NOTICE"),
  ]);
  return { launcher, setup, license, notice };
}
