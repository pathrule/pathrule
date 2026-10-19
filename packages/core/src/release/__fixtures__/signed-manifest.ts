// SPDX-License-Identifier: Apache-2.0
// Test support: a throwaway Ed25519 key, trusted for this process only, and signed release
// manifests built from a few facts. Never shipped (`__fixtures__` is outside every npm package).
import { generateKeyPairSync } from "node:crypto";

import type {
  ChannelRelease,
  ComponentRelease,
  ReleaseManifest,
} from "@pathrule/protocol/release-manifest.js";

import { releaseKeyId, setTrustedReleaseKeys, signReleaseManifest } from "../manifest-signature.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

/** Trust the test key in this process (and only it). Returns the undo. */
export function trustTestReleaseKey(): () => void {
  setTrustedReleaseKeys([{ keyid: releaseKeyId(publicKeyPem), publicKeyPem }]);
  return () => setTrustedReleaseKeys(null);
}

export const SAMPLE_SHA512 = `${"Q".repeat(86)}==`;

export function release(version: string, extra: Partial<ChannelRelease> = {}): ChannelRelease {
  return {
    version,
    published_at: "2026-10-13T09:00:00Z",
    verified_at: "2026-10-13T09:05:00Z",
    ...extra,
  };
}

export function testManifest(
  components: ReleaseManifest["components"],
  overrides: Partial<Omit<ReleaseManifest, "components">> = {},
): ReleaseManifest {
  return {
    schema_version: 1,
    sequence: 1,
    generated_at: "2026-10-13T10:00:00Z",
    expires_at: "2027-04-11T10:00:00Z",
    components,
    ...overrides,
  };
}

export function cliComponent(
  channels: ComponentRelease["channels"],
  extra: Partial<ComponentRelease> = {},
): ComponentRelease {
  return { restart: "new-session", channels, ...extra };
}

/** The served body of a manifest signed with the test key. */
export function signedBody(manifest: ReleaseManifest): string {
  return JSON.stringify(signReleaseManifest(manifest, privateKeyPem));
}

/** A fetch that serves this body for the manifest URL and records each request. */
export function serving(body: string | (() => string), calls: string[] = []): typeof fetch {
  return (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(typeof body === "function" ? body() : body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

export const offline: typeof fetch = (async () => {
  throw new TypeError("fetch failed");
}) as typeof fetch;
