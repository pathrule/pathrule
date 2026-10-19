// SPDX-License-Identifier: Apache-2.0
/**
 * Signing and verifying the release manifest (`@pathrule/protocol/release-manifest.js`) with
 * Ed25519. The Release Orchestrator signs with `signReleaseManifest`; every client verifies with
 * `verifyReleaseEnvelope` against the keys pinned here, never against a key the server offers.
 *
 * Order of checks, each failing closed: the envelope's shape, a signature by a pinned key over the
 * exact `signed` value received, the manifest's schema and fields, its validity window, and its
 * sequence against the highest one this machine already accepted.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

import {
  parseReleaseEnvelope,
  parseReleaseManifest,
  releaseManifestSigningPayload,
  type ReleaseManifest,
  type ReleaseManifestEnvelope,
} from "@pathrule/protocol/release-manifest.js";

export interface ReleaseSigningKey {
  keyid: string;
  /** SPKI PEM of an Ed25519 public key. */
  publicKeyPem: string;
}

/**
 * The keys a release manifest may be signed with. Rotation adds the new key here one release
 * before the orchestrator signs with it, and removes the old one only after that.
 */
export const RELEASE_SIGNING_KEYS: readonly ReleaseSigningKey[] = Object.freeze([
  {
    // The CLI distribution key (scripts/produce-distribution-integrity.mjs), published as
    // app.pathrule.io/downloads/pathrule-cli-release.pub.pem. The signing context keeps a manifest
    // signature from meaning anything to the distribution manifest, and the reverse.
    keyid: "b07b4192b7ed05c8",
    publicKeyPem:
      "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEALuZF/ChDlec9RwvnNZBPZSsyD38RJLDFyGM8dQ4XYDI=\n-----END PUBLIC KEY-----\n",
  },
]);

let trustedKeys: readonly ReleaseSigningKey[] | null = null;

/**
 * Replace the pinned keys for this process: tests, and a staging harness that signs with its own
 * key. In-process only, on purpose: no environment variable or file can add a trusted key.
 */
export function setTrustedReleaseKeys(keys: readonly ReleaseSigningKey[] | null): void {
  trustedKeys = keys;
}

/** Generated-at may run ahead of this machine's clock by this much before the manifest is refused. */
export const RELEASE_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

/** First 16 hex characters of the SHA-256 of a public key's SPKI (DER). */
export function releaseKeyId(publicKey: string | KeyObject): string {
  const key = typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey;
  const der = key.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

/**
 * Sign a manifest. Refuses one that would not parse, so the orchestrator cannot publish a document
 * every client would reject.
 */
export function signReleaseManifest(
  signed: ReleaseManifest,
  privateKeyPem: string,
): ReleaseManifestEnvelope {
  const parsed = parseReleaseManifest(signed);
  if (!parsed.ok) throw new Error(`refusing to sign an invalid release manifest: ${parsed.detail}`);
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("the release signing key must be Ed25519");
  const payload = Buffer.from(releaseManifestSigningPayload(signed), "utf8");
  return {
    signed,
    signatures: [
      {
        keyid: releaseKeyId(createPublicKey(key)),
        sig: sign(null, payload, key).toString("base64"),
      },
    ],
  };
}

export type ReleaseVerificationFailure =
  | "malformed"
  | "unknown_key"
  | "bad_signature"
  | "unsupported_schema"
  | "invalid"
  | "not_yet_valid"
  | "expired"
  | "rollback";

export type ReleaseVerification =
  | { ok: true; manifest: ReleaseManifest; keyid: string }
  | { ok: false; reason: ReleaseVerificationFailure; detail: string };

export interface VerifyReleaseOptions {
  /** Defaults to `RELEASE_SIGNING_KEYS`. */
  keys?: readonly ReleaseSigningKey[];
  now?: Date;
  /** The highest sequence this machine accepted before; a lower one is a rollback. */
  minSequence?: number;
}

/** Verify a served envelope (already JSON-parsed). Never throws. */
export function verifyReleaseEnvelope(
  raw: unknown,
  options: VerifyReleaseOptions = {},
): ReleaseVerification {
  const envelope = parseReleaseEnvelope(raw);
  if (!envelope)
    return { ok: false, reason: "malformed", detail: "not a release manifest envelope" };

  const keys = options.keys ?? trustedKeys ?? RELEASE_SIGNING_KEYS;
  let payload: Buffer;
  try {
    payload = Buffer.from(releaseManifestSigningPayload(envelope.signed), "utf8");
  } catch {
    return { ok: false, reason: "malformed", detail: "the signed manifest is not plain JSON" };
  }
  let keyid: string | null = null;
  let knownKey = false;
  for (const signature of envelope.signatures) {
    const key = keys.find((k) => k.keyid === signature.keyid);
    if (!key) continue;
    knownKey = true;
    try {
      const publicKey = createPublicKey(key.publicKeyPem);
      if (publicKey.asymmetricKeyType !== "ed25519") continue;
      if (verify(null, payload, publicKey, Buffer.from(signature.sig, "base64"))) {
        keyid = key.keyid;
        break;
      }
    } catch {
      // A key or signature that does not decode verifies nothing.
    }
  }
  if (!keyid) {
    return knownKey
      ? { ok: false, reason: "bad_signature", detail: "no signature verifies over the manifest" }
      : { ok: false, reason: "unknown_key", detail: "the manifest is not signed by a pinned key" };
  }

  const parsed = parseReleaseManifest(envelope.signed);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, detail: parsed.detail };
  const manifest = parsed.manifest;

  const now = (options.now ?? new Date()).getTime();
  if (Date.parse(manifest.generated_at) - now > RELEASE_CLOCK_SKEW_MS) {
    return { ok: false, reason: "not_yet_valid", detail: `generated at ${manifest.generated_at}` };
  }
  if (Date.parse(manifest.expires_at) <= now) {
    return { ok: false, reason: "expired", detail: `expired at ${manifest.expires_at}` };
  }
  if (options.minSequence !== undefined && manifest.sequence < options.minSequence) {
    return {
      ok: false,
      reason: "rollback",
      detail: `sequence ${manifest.sequence} is older than the ${options.minSequence} already accepted`,
    };
  }
  return { ok: true, manifest, keyid };
}
