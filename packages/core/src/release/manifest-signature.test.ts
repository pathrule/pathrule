// SPDX-License-Identifier: Apache-2.0
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ReleaseManifest } from "@pathrule/protocol/release-manifest.js";

import {
  RELEASE_SIGNING_KEYS,
  releaseKeyId,
  signReleaseManifest,
  verifyReleaseEnvelope,
  type ReleaseSigningKey,
} from "./manifest-signature.js";

function keyPair(): { privateKeyPem: string; key: ReleaseSigningKey } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    key: { keyid: releaseKeyId(publicKeyPem), publicKeyPem },
  };
}

const NOW = new Date("2026-10-13T12:00:00Z");

function manifest(sequence = 5): ReleaseManifest {
  return {
    schema_version: 1,
    sequence,
    generated_at: "2026-10-13T10:00:00Z",
    expires_at: "2027-04-11T10:00:00Z",
    components: {
      cli: {
        restart: "new-session",
        channels: {
          npm: {
            latest: {
              version: "1.0.1",
              published_at: "2026-10-13T09:00:00Z",
              verified_at: "2026-10-13T09:05:00Z",
            },
          },
        },
      },
    },
  };
}

/** A served envelope, round-tripped through JSON the way a client receives it. */
function served(value: unknown): any {
  return JSON.parse(JSON.stringify(value));
}

describe("release manifest signatures", () => {
  const signer = keyPair();
  const keys = [signer.key];

  it("verifies what the orchestrator signed, after a JSON round trip", () => {
    const envelope = served(signReleaseManifest(manifest(), signer.privateKeyPem));
    const result = verifyReleaseEnvelope(envelope, { keys, now: NOW });
    expect(result).toMatchObject({ ok: true, keyid: signer.key.keyid });
    expect(result.ok && result.manifest.components.cli?.channels.npm?.latest?.version).toBe(
      "1.0.1",
    );
  });

  it("does not depend on the served key order or indentation", () => {
    const envelope = signReleaseManifest(manifest(), signer.privateKeyPem);
    const reverse = (value: unknown): unknown =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .reverse()
              .map(([k, v]) => [k, reverse(v)]),
          )
        : value;
    const reordered = JSON.parse(
      JSON.stringify(
        { signatures: envelope.signatures, signed: reverse(envelope.signed) },
        null,
        4,
      ),
    );
    expect(Object.keys(reordered.signed)[0]).toBe("components");
    expect(verifyReleaseEnvelope(reordered, { keys, now: NOW }).ok).toBe(true);
  });

  it("refuses a manifest changed after signing", () => {
    const envelope = served(signReleaseManifest(manifest(), signer.privateKeyPem));
    envelope.signed.components.cli.channels.npm.latest.version = "9.9.9";
    expect(verifyReleaseEnvelope(envelope, { keys, now: NOW })).toMatchObject({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("refuses an added field, even one this client would ignore", () => {
    const envelope = served(signReleaseManifest(manifest(), signer.privateKeyPem));
    envelope.signed.components.cli.channels.npm.latest.artifact_url = "https://evil.example/x.tgz";
    expect(verifyReleaseEnvelope(envelope, { keys, now: NOW }).ok).toBe(false);
  });

  it("refuses a manifest signed by a key it does not pin", () => {
    const attacker = keyPair();
    const envelope = served(signReleaseManifest(manifest(), attacker.privateKeyPem));
    expect(verifyReleaseEnvelope(envelope, { keys, now: NOW })).toMatchObject({
      ok: false,
      reason: "unknown_key",
    });
  });

  it("refuses an attacker signature that claims a pinned key id", () => {
    const attacker = keyPair();
    const envelope = served(signReleaseManifest(manifest(), attacker.privateKeyPem));
    envelope.signatures[0].keyid = signer.key.keyid;
    expect(verifyReleaseEnvelope(envelope, { keys, now: NOW })).toMatchObject({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("accepts the pinned signature among others", () => {
    const attacker = keyPair();
    const good = signReleaseManifest(manifest(), signer.privateKeyPem);
    const bad = signReleaseManifest(manifest(), attacker.privateKeyPem);
    const envelope = served({
      signed: good.signed,
      signatures: [...bad.signatures, ...good.signatures],
    });
    expect(verifyReleaseEnvelope(envelope, { keys, now: NOW }).ok).toBe(true);
  });

  it("refuses an expired manifest and one from the far future", () => {
    const envelope = served(signReleaseManifest(manifest(), signer.privateKeyPem));
    expect(
      verifyReleaseEnvelope(envelope, { keys, now: new Date("2027-05-01T00:00:00Z") }),
    ).toMatchObject({
      ok: false,
      reason: "expired",
    });
    expect(
      verifyReleaseEnvelope(envelope, { keys, now: new Date("2026-10-10T00:00:00Z") }),
    ).toMatchObject({
      ok: false,
      reason: "not_yet_valid",
    });
  });

  it("refuses a replayed older manifest (rollback)", () => {
    const old = served(signReleaseManifest(manifest(4), signer.privateKeyPem));
    expect(verifyReleaseEnvelope(old, { keys, now: NOW, minSequence: 5 })).toMatchObject({
      ok: false,
      reason: "rollback",
    });
    expect(verifyReleaseEnvelope(old, { keys, now: NOW, minSequence: 4 }).ok).toBe(true);
  });

  it("refuses garbage without throwing", () => {
    for (const raw of [
      null,
      "x",
      [],
      { signed: "x", signatures: [] },
      { signed: {}, signatures: [{}] },
    ]) {
      expect(verifyReleaseEnvelope(raw, { keys, now: NOW }).ok).toBe(false);
    }
    const envelope = served(signReleaseManifest(manifest(), signer.privateKeyPem));
    envelope.signatures[0].sig = "not base64 at all ***";
    expect(verifyReleaseEnvelope(envelope, { keys, now: NOW }).ok).toBe(false);
  });

  it("will not sign an invalid manifest or with a non-Ed25519 key", () => {
    expect(() => signReleaseManifest({ ...manifest(), sequence: 0 }, signer.privateKeyPem)).toThrow(
      /invalid release manifest/,
    );
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    expect(() => signReleaseManifest(manifest(), rsa)).toThrow(/Ed25519/);
  });

  it("pins each key under the id its own public key gives", () => {
    for (const key of RELEASE_SIGNING_KEYS) {
      expect(createPublicKey(key.publicKeyPem).asymmetricKeyType).toBe("ed25519");
      expect(releaseKeyId(key.publicKeyPem)).toBe(key.keyid);
    }
  });

  // The private repository also holds the key the CLI distribution publishes; the open export
  // does not (packages/web stays private), so this cross-check runs only where the file exists.
  const published = fileURLToPath(
    new URL("../../../web/public/downloads/pathrule-cli-release.pub.pem", import.meta.url),
  );
  it.skipIf(!existsSync(published))("pins the published CLI distribution key", () => {
    expect(RELEASE_SIGNING_KEYS[0]!.publicKeyPem.trim()).toBe(
      readFileSync(published, "utf8").trim(),
    );
  });
});
