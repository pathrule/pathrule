// SPDX-License-Identifier: Apache-2.0
/**
 * The release manifest: which Pathrule release each distribution channel has verifiably published,
 * and what an installed component needs to stay compatible. The Release Orchestrator produces it;
 * every surface that tells a person about updates (the CLI, the MCP server, the VS Code extension,
 * `pathrule doctor`) reads it. It is data, never instructions: nothing in it is ever executed.
 *
 * - **One signed document.** The served file is an envelope, `{ signed, signatures }`. A client
 *   trusts `signed` only after one signature by a key it pins verifies over
 *   `releaseManifestSigningPayload(signed)` (the Ed25519 side lives in
 *   `@pathrule/core/release/manifest-signature.js`). The host that serves it is not trusted.
 * - **Per channel, verified only.** `components.<id>.channels.<distribution>.<track>` holds the release
 *   that distribution has published AND the orchestrator has verified on the channel itself. A
 *   channel whose publish failed keeps its previous entry, so a person installed from that channel
 *   is never told about a release they cannot get yet.
 * - **Never backwards.** `sequence` rises with every publish. A client remembers the highest it
 *   accepted and refuses a lower one, so an old, validly signed manifest cannot be replayed to hide
 *   a release. `expires_at` bounds how long one signed manifest is believed.
 * - **Forward compatible.** A component, distribution or track this version does not know is kept
 *   out of the parsed manifest but stays under the signature, so a newer orchestrator never breaks
 *   an older client.
 *
 * Pure and dependency-free: it runs in Node, editors, Workers and browsers.
 */

export const RELEASE_MANIFEST_SCHEMA = 1;

/** Prefixed to the signed bytes, so a signature over this document means nothing anywhere else. */
export const RELEASE_MANIFEST_SIGNING_CONTEXT = "pathrule-release-manifest/v1";

/** Where the official manifest is served. `PATHRULE_RELEASE_MANIFEST_URL` overrides it. */
export const RELEASE_MANIFEST_URL = "https://releases.pathrule.io/v1/manifest.json";

/** A served manifest larger than this is refused before it is parsed. */
export const RELEASE_MANIFEST_MAX_BYTES = 512 * 1024;

/** The longest a manifest may claim to stay valid, from `generated_at` to `expires_at`. */
export const RELEASE_MANIFEST_MAX_LIFETIME_MS = 400 * 24 * 60 * 60 * 1000;

export const RELEASE_COMPONENTS = [
  "cli",
  "vscode",
  "claude-code-plugin",
  "codex-plugin",
  "cloud",
  "remote-mcp",
] as const;
export type ReleaseComponentId = (typeof RELEASE_COMPONENTS)[number];

/**
 * Where a person got the component: a package manager, an editor marketplace, an agent's plugin
 * marketplace, or `service` for what Pathrule runs itself (Cloud, Remote MCP).
 */
export const RELEASE_DISTRIBUTIONS = [
  "npm",
  "homebrew",
  "winget",
  "standalone",
  "vscode-marketplace",
  "open-vsx",
  "claude-marketplace",
  "codex-marketplace",
  "service",
] as const;
export type ReleaseDistributionId = (typeof RELEASE_DISTRIBUTIONS)[number];

/** `latest` is every release; `stable` lags it. A client never moves a stable install to `latest`. */
export const RELEASE_TRACKS = ["stable", "latest"] as const;
export type ReleaseTrack = (typeof RELEASE_TRACKS)[number];

/**
 * What it takes for a newly installed version to run:
 * - `none`: the next command uses it;
 * - `new-session`: running agent sessions and MCP servers keep the old one until they restart;
 * - `reload-window` / `restart-extensions`: the editor's own actions.
 */
export const RESTART_REQUIREMENTS = [
  "none",
  "new-session",
  "reload-window",
  "restart-extensions",
] as const;
export type RestartRequirement = (typeof RESTART_REQUIREMENTS)[number];

export interface ReleaseIntegrity {
  /** `sha512`: base64 of the digest, as npm's `integrity` carries it. `sha256`: lowercase hex. */
  algorithm: "sha512" | "sha256";
  digest: string;
}

/** One verified release on one channel and track. */
export interface ChannelRelease {
  version: string;
  published_at: string;
  /** When the orchestrator confirmed the release on the channel itself (registry, marketplace). */
  verified_at: string;
  release_notes_url?: string;
  integrity?: ReleaseIntegrity;
  /** A direct download (a model manifest, a standalone tarball). Always https. */
  artifact_url?: string;
  size_bytes?: number;
  /** The channel's own name for it: npm package, extension id, `plugin@marketplace`, formula. */
  package?: string;
}

export interface ContractRange {
  min: number;
  max: number;
}

export interface ComponentRelease {
  /** Installs below this must update to keep working; above it an update is optional. */
  minimum_version?: string;
  restart: RestartRequirement;
  /** The contract versions the component's latest release speaks (`compatibility.ts`). */
  contracts?: Record<string, number>;
  /** A service: the client contract versions it accepts. Only a client outside a range must update. */
  accepts?: Record<string, ContractRange>;
  channels: Partial<Record<ReleaseDistributionId, Partial<Record<ReleaseTrack, ChannelRelease>>>>;
}

export interface ReleaseManifest {
  schema_version: typeof RELEASE_MANIFEST_SCHEMA;
  sequence: number;
  generated_at: string;
  expires_at: string;
  source_commit?: string;
  components: Partial<Record<ReleaseComponentId, ComponentRelease>>;
}

export interface ReleaseSignature {
  /** First 16 hex characters of the SHA-256 of the signing key's SPKI (DER). */
  keyid: string;
  /** Base64 Ed25519 signature over `releaseManifestSigningPayload(signed)`. */
  sig: string;
}

/** The served file. `signed` is kept exactly as received: the signature covers it, not the parse. */
export interface ReleaseManifestEnvelope {
  signed: unknown;
  signatures: ReleaseSignature[];
}

export type ReleaseManifestParse =
  | { ok: true; manifest: ReleaseManifest }
  | { ok: false; reason: "unsupported_schema" | "invalid"; detail: string };

// ---------------------------------------------------------------------------------------------
// Canonical bytes
// ---------------------------------------------------------------------------------------------

/**
 * The canonical JSON the signature covers: object keys sorted by UTF-16 code unit, no whitespace,
 * strings and numbers as `JSON.stringify` writes them, keys whose value is `undefined` dropped. A
 * value JSON cannot carry (a function, a non-finite number, a bigint) throws instead of being
 * silently changed into something that was not signed.
 */
export function canonicalReleaseJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON cannot carry a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalReleaseJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalReleaseJson(record[key])}`).join(",")}}`;
  }
  throw new Error(`canonical JSON cannot carry a ${typeof value}`);
}

/** The exact text an Ed25519 signature covers (encode it as UTF-8). */
export function releaseManifestSigningPayload(signed: unknown): string {
  return `${RELEASE_MANIFEST_SIGNING_CONTEXT}\n${canonicalReleaseJson(signed)}`;
}

// ---------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
}

const SEMVER =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** A Semantic Versioning 2.0 version, or null. Build metadata is accepted and ignored. */
export function parseVersion(value: string): ParsedVersion | null {
  if (typeof value !== "string" || value.length > 128) return null;
  const match = SEMVER.exec(value.trim());
  if (!match) return null;
  const numbers = [match[1], match[2], match[3]].map(Number);
  if (numbers.some((n) => !Number.isSafeInteger(n))) return null;
  return {
    major: numbers[0]!,
    minor: numbers[1]!,
    patch: numbers[2]!,
    prerelease: match[4]
      ? match[4].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      : [],
  };
}

/**
 * Semantic Versioning precedence: negative when `a` is older, positive when newer, 0 when equal,
 * null when either is not a version. A prerelease is older than its release (1.0.0-rc.1 < 1.0.0).
 */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  const lp = left.prerelease;
  const rp = right.prerelease;
  if (lp.length === 0 || rp.length === 0)
    return lp.length === rp.length ? 0 : lp.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(lp.length, rp.length); i += 1) {
    const l = lp[i];
    const r = rp[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    if (typeof l === "number" && typeof r === "number") return l > r ? 1 : -1;
    if (typeof l === "number") return -1;
    if (typeof r === "number") return 1;
    return l > r ? 1 : -1;
  }
  return 0;
}

/**
 * Whether `candidate` is strictly newer than `current`. Fails closed: anything it cannot compare is
 * not newer, so a malformed entry can never send a person to a downgrade or a guess.
 */
export function isNewerVersion(candidate: string | null | undefined, current: string): boolean {
  if (!candidate) return false;
  const order = compareVersions(candidate, current);
  return order !== null && order > 0;
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

class Invalid extends Error {}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const BASE64_SHA512 = /^[A-Za-z0-9+/]{86}==$/;
const KEY_ID = /^[0-9a-f]{16}$/;
const PACKAGE_NAME = /^[A-Za-z0-9@][A-Za-z0-9@._/:+-]{0,213}$/;
const CONTRACT_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const COMMIT = /^[0-9a-f]{7,64}$/;

function record(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Invalid(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function instant(value: unknown, where: string): string {
  if (typeof value !== "string" || !ISO_INSTANT.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Invalid(`${where} must be an ISO 8601 instant`);
  }
  return value;
}

function version(value: unknown, where: string): string {
  if (typeof value !== "string" || !parseVersion(value)) {
    throw new Invalid(`${where} must be a semantic version`);
  }
  return value;
}

function httpsUrl(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length > 2048) throw new Invalid(`${where} must be a URL`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Invalid(`${where} must be a URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Invalid(`${where} must be an https URL without credentials`);
  }
  return value;
}

function count(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Invalid(`${where} must be a non-negative integer`);
  }
  return value;
}

function integrity(value: unknown, where: string): ReleaseIntegrity {
  const v = record(value, where);
  if (v.algorithm === "sha256" && typeof v.digest === "string" && HEX_SHA256.test(v.digest)) {
    return { algorithm: "sha256", digest: v.digest };
  }
  if (v.algorithm === "sha512" && typeof v.digest === "string" && BASE64_SHA512.test(v.digest)) {
    return { algorithm: "sha512", digest: v.digest };
  }
  throw new Invalid(`${where} must be a sha256 (hex) or sha512 (base64) digest`);
}

function channelRelease(value: unknown, where: string): ChannelRelease {
  const v = record(value, where);
  const out: ChannelRelease = {
    version: version(v.version, `${where}.version`),
    published_at: instant(v.published_at, `${where}.published_at`),
    verified_at: instant(v.verified_at, `${where}.verified_at`),
  };
  if (Date.parse(out.verified_at) < Date.parse(out.published_at)) {
    throw new Invalid(`${where} was verified before it was published`);
  }
  if (v.release_notes_url !== undefined) {
    out.release_notes_url = httpsUrl(v.release_notes_url, `${where}.release_notes_url`);
  }
  if (v.integrity !== undefined) out.integrity = integrity(v.integrity, `${where}.integrity`);
  if (v.artifact_url !== undefined)
    out.artifact_url = httpsUrl(v.artifact_url, `${where}.artifact_url`);
  if (v.size_bytes !== undefined) out.size_bytes = count(v.size_bytes, `${where}.size_bytes`);
  if (v.package !== undefined) {
    if (typeof v.package !== "string" || !PACKAGE_NAME.test(v.package)) {
      throw new Invalid(`${where}.package must be a package name`);
    }
    out.package = v.package;
  }
  return out;
}

function contracts(value: unknown, where: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, n] of Object.entries(record(value, where))) {
    if (!CONTRACT_NAME.test(name)) throw new Invalid(`${where} has an invalid contract name`);
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) {
      throw new Invalid(`${where}.${name} must be a positive integer`);
    }
    out[name] = n;
  }
  return out;
}

function ranges(value: unknown, where: string): Record<string, ContractRange> {
  const out: Record<string, ContractRange> = {};
  for (const [name, raw] of Object.entries(record(value, where))) {
    if (!CONTRACT_NAME.test(name)) throw new Invalid(`${where} has an invalid contract name`);
    const range = contracts(raw, `${where}.${name}`);
    if (range.min === undefined || range.max === undefined || range.min > range.max) {
      throw new Invalid(`${where}.${name} must be { min, max } with min <= max`);
    }
    out[name] = { min: range.min, max: range.max };
  }
  return out;
}

function component(value: unknown, where: string): ComponentRelease {
  const v = record(value, where);
  if (!RESTART_REQUIREMENTS.includes(v.restart as RestartRequirement)) {
    throw new Invalid(`${where}.restart must be one of ${RESTART_REQUIREMENTS.join(", ")}`);
  }
  const out: ComponentRelease = { restart: v.restart as RestartRequirement, channels: {} };
  if (v.minimum_version !== undefined) {
    out.minimum_version = version(v.minimum_version, `${where}.minimum_version`);
  }
  if (v.contracts !== undefined) out.contracts = contracts(v.contracts, `${where}.contracts`);
  if (v.accepts !== undefined) out.accepts = ranges(v.accepts, `${where}.accepts`);
  for (const [distribution, tracks] of Object.entries(record(v.channels, `${where}.channels`))) {
    if (!RELEASE_DISTRIBUTIONS.includes(distribution as ReleaseDistributionId)) continue;
    const byTrack: Partial<Record<ReleaseTrack, ChannelRelease>> = {};
    for (const [track, release] of Object.entries(
      record(tracks, `${where}.channels.${distribution}`),
    )) {
      if (!RELEASE_TRACKS.includes(track as ReleaseTrack)) continue;
      byTrack[track as ReleaseTrack] = channelRelease(
        release,
        `${where}.channels.${distribution}.${track}`,
      );
    }
    out.channels[distribution as ReleaseDistributionId] = byTrack;
  }
  return out;
}

/**
 * Validate the `signed` part of a manifest. Only call it on a document whose signature has been
 * verified: validity says nothing about who wrote it.
 */
export function parseReleaseManifest(raw: unknown): ReleaseManifestParse {
  try {
    const v = record(raw, "manifest");
    if (v.schema_version !== RELEASE_MANIFEST_SCHEMA) {
      return typeof v.schema_version === "number" && v.schema_version > RELEASE_MANIFEST_SCHEMA
        ? {
            ok: false,
            reason: "unsupported_schema",
            detail: `schema ${v.schema_version} is newer than this client reads (${RELEASE_MANIFEST_SCHEMA})`,
          }
        : { ok: false, reason: "invalid", detail: "schema_version must be 1" };
    }
    if (typeof v.sequence !== "number" || !Number.isSafeInteger(v.sequence) || v.sequence < 1) {
      throw new Invalid("sequence must be a positive integer");
    }
    const generatedAt = instant(v.generated_at, "generated_at");
    const expiresAt = instant(v.expires_at, "expires_at");
    const lifetime = Date.parse(expiresAt) - Date.parse(generatedAt);
    if (lifetime <= 0 || lifetime > RELEASE_MANIFEST_MAX_LIFETIME_MS) {
      throw new Invalid("expires_at must be after generated_at and within 400 days of it");
    }
    const manifest: ReleaseManifest = {
      schema_version: RELEASE_MANIFEST_SCHEMA,
      sequence: v.sequence,
      generated_at: generatedAt,
      expires_at: expiresAt,
      components: {},
    };
    if (v.source_commit !== undefined) {
      if (typeof v.source_commit !== "string" || !COMMIT.test(v.source_commit)) {
        throw new Invalid("source_commit must be a hex commit id");
      }
      manifest.source_commit = v.source_commit;
    }
    for (const [id, entry] of Object.entries(record(v.components, "components"))) {
      if (!RELEASE_COMPONENTS.includes(id as ReleaseComponentId)) continue;
      manifest.components[id as ReleaseComponentId] = component(entry, `components.${id}`);
    }
    return { ok: true, manifest };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, reason: "invalid", detail: error.message };
    throw error;
  }
}

/** The envelope's shape, before any signature is checked. Null for anything else. */
export function parseReleaseEnvelope(raw: unknown): ReleaseManifestEnvelope | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (!v.signed || typeof v.signed !== "object" || Array.isArray(v.signed)) return null;
  if (!Array.isArray(v.signatures) || v.signatures.length === 0 || v.signatures.length > 8) {
    return null;
  }
  const signatures: ReleaseSignature[] = [];
  for (const entry of v.signatures) {
    const s = entry as Record<string, unknown> | null;
    if (!s || typeof s.keyid !== "string" || !KEY_ID.test(s.keyid) || typeof s.sig !== "string") {
      return null;
    }
    if (s.sig.length === 0 || s.sig.length > 256) return null;
    signatures.push({ keyid: s.keyid, sig: s.sig });
  }
  return { signed: v.signed, signatures };
}

// ---------------------------------------------------------------------------------------------
// What a manifest says about one installed component
// ---------------------------------------------------------------------------------------------

export type ComponentCompatibility =
  | { ok: true }
  | { ok: false; reason: "below_minimum"; detail: string; minimum: string };

export type UpdateStatus =
  /** The channel's verified release is not newer than what is installed. */
  | "up_to_date"
  | "update_available"
  /** The install is older than the component's minimum: it must update to keep working. */
  | "update_required"
  /** Newer than the channel's release (a prerelease, a local build). Nothing to say. */
  | "ahead"
  /** The manifest has no verified release on this channel and track. */
  | "unknown";

export interface ComponentAssessment {
  component: ReleaseComponentId;
  distribution: ReleaseDistributionId;
  track: ReleaseTrack;
  installed: string;
  status: UpdateStatus;
  /** The channel's verified release, when there is one. */
  latest: ChannelRelease | null;
  compatibility: ComponentCompatibility;
  restart: RestartRequirement;
}

/** The verified release one distribution channel offers on one track, or null. */
export function channelReleaseOf(
  manifest: ReleaseManifest,
  component: ReleaseComponentId,
  distribution: ReleaseDistributionId,
  track: ReleaseTrack,
): ChannelRelease | null {
  return manifest.components[component]?.channels[distribution]?.[track] ?? null;
}

/**
 * Compare an installed component with what its own channel has verifiably published. Only that
 * channel counts: an npm release says nothing to someone who installed from Open VSX.
 */
export function assessComponent(
  manifest: ReleaseManifest,
  input: {
    component: ReleaseComponentId;
    distribution: ReleaseDistributionId;
    track: ReleaseTrack;
    installedVersion: string;
  },
): ComponentAssessment {
  const entry = manifest.components[input.component];
  const latest = channelReleaseOf(manifest, input.component, input.distribution, input.track);
  const base = {
    component: input.component,
    distribution: input.distribution,
    track: input.track,
    installed: input.installedVersion,
    latest,
    restart: entry?.restart ?? "new-session",
  } as const;
  const minimum = entry?.minimum_version;
  const belowMinimum =
    minimum !== undefined && (compareVersions(input.installedVersion, minimum) ?? 0) < 0;
  const compatibility: ComponentCompatibility = belowMinimum
    ? {
        ok: false,
        reason: "below_minimum",
        minimum: minimum!,
        detail: `${input.installedVersion} is older than the minimum compatible ${minimum}`,
      }
    : { ok: true };
  if (!latest) return { ...base, status: "unknown", compatibility };
  const order = compareVersions(latest.version, input.installedVersion);
  if (order === null) return { ...base, status: "unknown", compatibility };
  if (order > 0) {
    // Required only when the channel can deliver a version that clears the minimum.
    const deliverable =
      minimum === undefined || (compareVersions(latest.version, minimum) ?? -1) >= 0;
    return {
      ...base,
      status: belowMinimum && deliverable ? "update_required" : "update_available",
      compatibility,
    };
  }
  return { ...base, status: order === 0 ? "up_to_date" : "ahead", compatibility };
}

export type ContractAssessment =
  | { ok: true }
  | {
      ok: false;
      /** `client_outdated`: the client must update. `service_outdated`: the client is newer. */
      reason: "client_outdated" | "service_outdated";
      contract: string;
      client: number;
      accepted: ContractRange;
      detail: string;
    };

/**
 * Whether a service (Cloud, Remote MCP) still accepts a client's contracts. Only a contract both
 * sides name is compared, so a service update that keeps accepting the client asks nothing of it.
 */
export function assessServiceContracts(
  manifest: ReleaseManifest,
  service: Extract<ReleaseComponentId, "cloud" | "remote-mcp">,
  client: Readonly<Record<string, number>>,
): ContractAssessment {
  const accepts = manifest.components[service]?.accepts ?? {};
  for (const [contract, accepted] of Object.entries(accepts)) {
    const mine = client[contract];
    if (mine === undefined) continue;
    if (mine < accepted.min) {
      return {
        ok: false,
        reason: "client_outdated",
        contract,
        client: mine,
        accepted,
        detail: `${service} needs ${contract} ${accepted.min} or newer; this client speaks ${mine}`,
      };
    }
    if (mine > accepted.max) {
      return {
        ok: false,
        reason: "service_outdated",
        contract,
        client: mine,
        accepted,
        detail: `${service} speaks ${contract} up to ${accepted.max}; this client speaks ${mine}`,
      };
    }
  }
  return { ok: true };
}
