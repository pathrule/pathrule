// SPDX-License-Identifier: Apache-2.0
// The Pathrule Cloud (the Cloudflare Worker) a build or a run names for its account.
// A build names it with __BUILD_NATIVE_CLOUD_URL__ and __BUILD_NATIVE_DEVICE_CLIENT_ID__
// (scripts/build-time-cli-defines.mjs); a run may override both with PATHRULE_NATIVE_CLOUD_URL and
// PATHRULE_NATIVE_DEVICE_CLIENT_ID. When neither names one, there is no account: the open CLI alone.
import { nativeOrigin } from "./credentials.js";

declare const __BUILD_NATIVE_CLOUD_URL__: string;
declare const __BUILD_NATIVE_DEVICE_CLIENT_ID__: string;

export interface NativeCloudConfig {
  /** The Cloud origin: https, or plain http only on this machine. */
  baseUrl: string;
  /** The first-party device client the Worker accepts (its DEVICE_CLIENT_ID). */
  clientId: string;
}

/** The native Cloud this run signs in to, or null when the build and the run name none. */
export function nativeCloudConfig(env: NodeJS.ProcessEnv = process.env): NativeCloudConfig | null {
  const url =
    env.PATHRULE_NATIVE_CLOUD_URL?.trim() ||
    (typeof __BUILD_NATIVE_CLOUD_URL__ === "string" ? __BUILD_NATIVE_CLOUD_URL__ : "");
  const clientId =
    env.PATHRULE_NATIVE_DEVICE_CLIENT_ID?.trim() ||
    (typeof __BUILD_NATIVE_DEVICE_CLIENT_ID__ === "string"
      ? __BUILD_NATIVE_DEVICE_CLIENT_ID__
      : "");
  if (!url || !clientId) return null;
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(clientId))
    throw new Error("the native device client id is not valid");
  return { baseUrl: nativeOrigin(url), clientId };
}
