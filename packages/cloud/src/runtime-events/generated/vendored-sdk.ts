// SPDX-License-Identifier: Apache-2.0
// AUTO-GENERATED: do not edit by hand.
// Source of truth: packages/signals-sdk/src/protocol.ts and index.ts (Apache-2.0)
// Regenerate: node scripts/gen-vendored-signals-sdk.mjs

/** The exact single-file runtime events SDK source, copied into a user's project
 *  during instrumentation activation. */
export const VENDORED_RUNTIME_EVENTS_SDK = `// Pathrule runtime events SDK: a single-file copy of the @pathrule/signals package.
// This is a single, self-contained, failure-isolated runtime-context SDK.
// It is not analytics: no users, sessions, funnels, or raw event stream.
// To update it, install @pathrule/signals instead; the hash below identifies this copy.
// pathrule-sdk-integrity: sha256-7df76a082c79aee70dc6d687f3ed8cb7aaecaf317308b1b2f22a4fbdeb408072
// The Pathrule Signals wire protocol, version 1: what an SDK sends, and how a collector reads it.
//
// One envelope per request, JSON:
//
//   { schemaVersion?: 1, id?: string, key?: string, environment?, release?, connection?, items }
//
// - \`items\` holds at most 50 observations: \`signal\` items (an error or an event, grouped by its
//   fingerprint, \`countDelta\` occurrences since the last delivery) and \`declaration\` items (a point
//   the application instruments, with no occurrence).
// - \`key\` is the Pathrule Cloud ingest key. Other destinations authenticate outside the envelope
//   (a header, the local host's token) and send none.
// - \`schemaVersion\` and \`id\` are optional for compatibility: an envelope without them is version 1,
//   and the collectors that predate them ignore them. \`id\` lets a collector recognise a retried
//   envelope.
// - Older forms stay valid: a single item at the top level, \`{ hello: true }\` and
//   \`{ declare: true, points }\`.
//
// The content is untrusted: anyone holding a public ingest key can send any message. Collectors
// store it as data and never as instructions.
//
// This module has no imports: the SDK copied into a project carries it, and Pathrule's own packages
// carry a generated copy of it. Every implementation, in any language, is checked against
// \`protocol/vectors.json\`.

export const SIGNALS_PROTOCOL_VERSION = 1;

/** The largest envelope a collector accepts, in UTF-8 bytes. */
export const MAX_BODY_BYTES = 32_768;
/** The most items in one envelope. */
export const MAX_ITEMS = 50;
export const MAX_KEY_LENGTH = 128;
export const MAX_ENVELOPE_ID_LENGTH = 64;
export const MAX_RELEASE_LENGTH = 120;
export const MAX_FINGERPRINT_LENGTH = 200;
export const MAX_NODE_LENGTH = 512;
export const MAX_FLOW_LENGTH = 120;
export const MAX_LABEL_LENGTH = 120;
export const MAX_MESSAGE_LENGTH = 4_000;
export const MAX_METADATA_KEYS = 20;
export const MAX_METADATA_VALUE_LENGTH = 500;
export const MAX_COUNT_DELTA = 1_000_000;

export const SIGNAL_ENVIRONMENTS = ["development", "preview", "production"] as const;
export type SignalEnvironment = (typeof SIGNAL_ENVIRONMENTS)[number];
export type SignalKind = "error" | "event";

/** Metadata keys no implementation stores: credentials, and anything that tracks a person. */
export const RESERVED_METADATA_KEYS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "token",
  "access_token",
  "refresh_token",
  "secret",
  "apikey",
  "api_key",
  "session",
  "session_id",
  "sessionid",
  "user",
  "user_id",
  "userid",
  "distinct_id",
  "device_id",
  "email",
  "credit_card",
  "card",
]);

export type SignalMetadata = Record<string, string | number | boolean | null>;

export interface SignalItem {
  type: "signal";
  kind: SignalKind;
  fingerprint: string;
  countDelta: number;
  node: string | null;
  flow: string | null;
  label: string | null;
  message: string | null;
  metadata: SignalMetadata | null;
}

export interface DeclarationItem {
  type: "declaration";
  kind: SignalKind;
  flow: string | null;
  label: string | null;
  node: string | null;
}

export type SignalEnvelopeItem = SignalItem | DeclarationItem;

export interface SignalEnvelope {
  schemaVersion: typeof SIGNALS_PROTOCOL_VERSION;
  /** The sender's identity for this envelope, or null when it sent none. */
  id: string | null;
  connection: boolean;
  environment: SignalEnvironment;
  release: string | null;
  items: SignalEnvelopeItem[];
}

export type NormalizeEnvelopeResult =
  | { ok: true; key: string | null; envelope: SignalEnvelope }
  | { ok: false; error: NormalizeEnvelopeError; status: 400 | 401 | 413 };

export type NormalizeEnvelopeError =
  | "invalid_json"
  | "missing_key"
  | "unsupported_schema_version"
  | "invalid_environment"
  | "invalid_release"
  | "invalid_items"
  | "too_many_items"
  | "invalid_item"
  | "empty_envelope"
  | "payload_too_large";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

/** null for absent or empty, undefined for present and invalid. */
function optionalString(value: unknown, max: number): string | null | undefined {
  if (value == null || value === "") return null;
  return boundedString(value, max) ?? undefined;
}

/** Metadata as a collector keeps it: primitives only, bounded, reserved keys dropped. */
export function sanitizeMetadata(raw: unknown): SignalMetadata | null {
  if (!isRecord(raw)) return null;
  const out: SignalMetadata = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_METADATA_KEYS) break;
    if (RESERVED_METADATA_KEYS.has(key.toLowerCase())) continue;
    if (key.toLowerCase() === "outcome") {
      if (value === "success" || value === "failure") out.outcome = value;
      continue;
    }
    if (typeof value === "string") out[key] = value.slice(0, MAX_METADATA_VALUE_LENGTH);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function normalizeDeclaration(raw: Record<string, unknown>): DeclarationItem | null {
  if (raw.kind !== "error" && raw.kind !== "event") return null;
  const flow = optionalString(raw.flow, MAX_FLOW_LENGTH);
  const label = optionalString(raw.label, MAX_LABEL_LENGTH);
  const node = optionalString(raw.node, MAX_NODE_LENGTH);
  if (flow === undefined || label === undefined || node === undefined) return null;
  return { type: "declaration", kind: raw.kind, flow, label, node };
}

function normalizeSignal(raw: Record<string, unknown>): SignalItem | null {
  if (raw.kind !== "error" && raw.kind !== "event") return null;
  const fingerprint = boundedString(raw.fingerprint ?? raw.dedup_fingerprint, MAX_FINGERPRINT_LENGTH);
  if (!fingerprint) return null;
  const countValue = raw.countDelta ?? 1;
  if (
    typeof countValue !== "number" ||
    !Number.isSafeInteger(countValue) ||
    countValue < 1 ||
    countValue > MAX_COUNT_DELTA
  ) {
    return null;
  }
  const node = optionalString(raw.node, MAX_NODE_LENGTH);
  const flow = optionalString(raw.flow, MAX_FLOW_LENGTH);
  const label = optionalString(raw.label, MAX_LABEL_LENGTH);
  if (node === undefined || flow === undefined || label === undefined) return null;
  const message =
    typeof raw.message === "string" ? raw.message.slice(0, MAX_MESSAGE_LENGTH) : null;
  return {
    type: "signal",
    kind: raw.kind,
    fingerprint,
    countDelta: countValue,
    node,
    flow,
    label,
    message,
    metadata: sanitizeMetadata(raw.metadata),
  };
}

/**
 * Reads one parsed envelope. \`requireKey\` (the default, as Pathrule Cloud reads it) refuses an
 * envelope without an ingest key; a collector that authenticates otherwise passes false. \`bytes\`,
 * when the caller knows the body's size, refuses a body over \`MAX_BODY_BYTES\`.
 *
 * For an envelope without the version 1 fields this is the reading Pathrule Cloud's ingestion has
 * always applied, item for item (\`protocol/vectors.json\` holds both to it).
 */
export function normalizeEnvelope(
  raw: unknown,
  options: { requireKey?: boolean; bytes?: number } = {},
): NormalizeEnvelopeResult {
  if (options.bytes !== undefined && options.bytes > MAX_BODY_BYTES) {
    return { ok: false, error: "payload_too_large", status: 413 };
  }
  if (!isRecord(raw)) return { ok: false, error: "invalid_json", status: 400 };
  const key = boundedString(raw.key, MAX_KEY_LENGTH);
  if (!key && options.requireKey !== false) return { ok: false, error: "missing_key", status: 401 };
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== SIGNALS_PROTOCOL_VERSION) {
    return { ok: false, error: "unsupported_schema_version", status: 400 };
  }
  const id =
    typeof raw.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(raw.id) ? raw.id : null;

  const environment =
    raw.environment == null
      ? "production"
      : typeof raw.environment === "string" &&
          (SIGNAL_ENVIRONMENTS as readonly string[]).includes(raw.environment)
        ? (raw.environment as SignalEnvironment)
        : null;
  if (!environment) return { ok: false, error: "invalid_environment", status: 400 };
  const release = optionalString(raw.release, MAX_RELEASE_LENGTH);
  if (release === undefined) return { ok: false, error: "invalid_release", status: 400 };

  let connection = raw.connection === true || raw.hello === true;
  let sourceItems: unknown[];
  if (Array.isArray(raw.items)) {
    sourceItems = raw.items;
  } else if (raw.declare === true) {
    if (!Array.isArray(raw.points)) return { ok: false, error: "invalid_items", status: 400 };
    sourceItems = raw.points.map((point) =>
      isRecord(point) ? { ...point, type: "declaration" } : point,
    );
  } else if (raw.hello === true) {
    sourceItems = [];
  } else {
    sourceItems = [{ ...raw, type: "signal" }];
    connection = true;
  }

  if (sourceItems.length > MAX_ITEMS) return { ok: false, error: "too_many_items", status: 400 };

  const items: SignalEnvelopeItem[] = [];
  for (const item of sourceItems) {
    if (!isRecord(item)) return { ok: false, error: "invalid_item", status: 400 };
    const normalized =
      item.type === "declaration"
        ? normalizeDeclaration(item)
        : item.type === "signal" || item.type == null
          ? normalizeSignal(item)
          : null;
    if (!normalized) return { ok: false, error: "invalid_item", status: 400 };
    items.push(normalized);
  }

  if (!connection && items.length === 0) {
    return { ok: false, error: "empty_envelope", status: 400 };
  }
  return {
    ok: true,
    key,
    envelope: { schemaVersion: SIGNALS_PROTOCOL_VERSION, id, connection, environment, release, items },
  };
}

/** A declaration's group identity, as every collector computes it. */
export function declarationFingerprint(item: Pick<DeclarationItem, "kind" | "flow" | "label">): string {
  return \`decl:\${item.kind}:\${item.flow ?? ""}:\${item.label ?? ""}\`;
}

// ---------------------------------------------------------------------------
// Fingerprints: how an SDK groups occurrences. Deterministic, dependency-free.
// ---------------------------------------------------------------------------

/** A stable 64-bit-style digest: two salted 32-bit FNV-1a words, 16 lowercase hex characters. */
export function fingerprintHash(input: string): string {
  const fnv = (seed: number, value: string): string => {
    let result = seed;
    for (let i = 0; i < value.length; i++) {
      result = Math.imul(result ^ value.charCodeAt(i), 0x01000193);
    }
    return (result >>> 0).toString(16).padStart(8, "0");
  };
  return fnv(0x811c9dc5, input) + fnv(0x811c9dc5, \`\${input}\\u0001pr\`);
}

/** Volatile parts out of a message or frame: UUIDs, hex addresses, numbers. */
export function normalizeForFingerprint(value: string): string {
  return value
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/0x[0-9a-f]+/gi, "<hex>")
    .replace(/\\d+/g, "<n>")
    .trim();
}

/** Frames of a dependency rather than of the application, matched on the raw stack line. */
export const VENDOR_FRAME = /[/\\\\]node_modules[/\\\\]|[/\\\\]\\.vite[/\\\\]deps[/\\\\]/;
export const MAX_TRACE_FRAMES = 5;

export function frameLines(stack: string | undefined): string[] {
  if (!stack) return [];
  return stack.split("\\n").filter((candidate) => /\\s+at\\s+/.test(candidate));
}

/** A frame without its directories and query strings. */
export function formatFrame(line: string): string {
  return line
    .replace(/\\(.*[/\\\\]/, "(")
    .replace(/\\?[^):]*/g, "")
    .trim();
}

/**
 * The frame an error's fingerprint is built from: the first that names application code, or the
 * first frame when every frame is a dependency's (a minified bundle has no marker to read).
 */
export function topFrame(stack: string | undefined): string {
  const lines = frameLines(stack);
  const owned = lines.find((line) => !VENDOR_FRAME.test(line));
  return formatFrame(owned ?? lines[0] ?? "");
}

/** A few frames for whoever reads the group: the throw site, then frames of application code. */
export function traceFrames(stack: string | undefined): string {
  const lines = frameLines(stack);
  const [first] = lines;
  if (!first) return "";
  const chosen: string[] = [];
  const add = (line: string): void => {
    const frame = formatFrame(line);
    if (frame && !chosen.includes(frame)) chosen.push(frame);
  };
  add(first);
  for (const line of lines) {
    if (chosen.length >= MAX_TRACE_FRAMES) break;
    if (!VENDOR_FRAME.test(line)) add(line);
  }
  return chosen.join("\\n");
}

/** An error's group: its normalized message and top frame, with the node and flow it is linked to. */
export function errorFingerprint(input: {
  message: string;
  frame: string;
  node?: string | null;
  flow?: string | null;
}): string {
  return fingerprintHash(
    [
      normalizeForFingerprint(input.message),
      normalizeForFingerprint(input.frame),
      input.node ?? "",
      input.flow ?? "",
    ].join("|"),
  );
}

/** An event's group: its label, flow and node; feedback groups by its normalized text instead. */
export function eventFingerprint(input: {
  label: string;
  flow?: string | null;
  node?: string | null;
  text?: string | null;
}): string {
  return input.label === "feedback"
    ? fingerprintHash(["feedback", normalizeForFingerprint(input.text ?? "")].join("|"))
    : fingerprintHash([input.label, input.flow ?? "", input.node ?? ""].join("|"));
}

/** The redaction every SDK applies before a string leaves the application. */
export function redactSecrets(value: string): string {
  return value
    .replace(/Bearer\\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>")
    .replace(/\\b(?:sk|pk|ghp|ghs|xox[baprs])[-_][A-Za-z0-9]{8,}\\b/g, "<redacted>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/g, "<email>");
}

// @pathrule/signals - a small, failure-isolated runtime instrumentation SDK.
// It is intentionally not analytics: no users, sessions, funnels, or raw event stream.
//
// An application reports errors and events; the SDK groups them by fingerprint, counts repeats,
// scrubs secrets, and delivers bounded batches to one destination: Pathrule Cloud (an ingest key),
// your own HTTP collector, or Pathrule Local (\`@pathrule/signals/local\`, Node only). Nothing it
// does may throw into the application, and with no key and no destination it does nothing.



/** Pathrule Cloud's ingestion: the Signals ingest route of Pathrule Cloud itself. */
export const PATHRULE_CLOUD_ENDPOINT = "https://cloud.pathrule.io/runtime-signal-ingest";
/**
 * The dedicated ingestion host Pathrule Cloud moves to. Not active yet: pass it as \`endpoint\` only
 * once Pathrule announces it. Copies of this SDK keep working at the address they were built with.
 */
export const PATHRULE_CLOUD_INGEST_ENDPOINT_PLANNED = "https://ingest.pathrule.io/runtime-signal-ingest";

const MAX_FINGERPRINTS = 500;
const MAX_RETRY_ENVELOPES = 20;
const MAX_ATTEMPTS = 4;
const BACKOFF_STEPS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_FLUSH_TIMEOUT_MS = 5_000;
const MAX_FLUSH_TIMEOUT_MS = 30_000;
const MAX_CAUSE_DEPTH = 3;
const STORAGE_PREFIX = "pathrule:signals:backoff:";

export interface SignalLink {
  /** Workspace-relative node path, e.g. "/apps/web/checkout". */
  node?: string;
  /** Structural flow, e.g. "checkout". Never a user/session identifier. */
  flow?: string;
  /** Human-readable feedback or event detail. Stored as shared plaintext. */
  text?: string;
  /** Small primitive metadata. Tracking and secret-like keys are discarded. */
  meta?: Record<string, unknown>;
}

export interface DeclaredPoint {
  kind: "error" | "event";
  flow?: string;
  label?: string;
  node?: string;
}

/** What identifies a build. Use what your project already has; never invent one. */
export interface ReleaseIdentity {
  /** The application's version, e.g. "2.4.0". */
  version?: string;
  /** The commit it was built from. */
  commit?: string;
  /** The deployment's identifier on your platform. */
  deployment?: string;
}

/** What a destination answers for one envelope. A destination never throws. */
export type DeliveryOutcome =
  | { ok: true; retryAfterSeconds?: number }
  | {
      ok: false;
      /** True when the same envelope may succeed later (offline, timeout, 429, 5xx). */
      retryable: boolean;
      reason: string;
      retryAfterSeconds?: number;
      /** The destination refuses this configuration for good (an invalid or revoked key). */
      disable?: boolean;
    };

export interface SignalsDestination {
  /** "cloud", "http", "local", or a name of your own. */
  readonly kind: string;
  /** Fields the destination adds to every envelope (Pathrule Cloud: its ingest key). */
  readonly envelopeFields?: Readonly<Record<string, string>>;
  /** \`signal\` aborts the request at its deadline; absent where the runtime has no AbortController. */
  send(body: string, options: { keepalive: boolean; signal?: AbortSignal }): Promise<DeliveryOutcome>;
  /** Hands the body off during page unload (\`navigator.sendBeacon\`); true when it was. */
  beacon?(body: string): boolean;
}

export interface PathruleSignalsConfig {
  /** Per-workspace public ingest key for Pathrule Cloud. Empty, with no destination, keeps the SDK inert. */
  key?: string;
  /** Where observations go. Defaults to Pathrule Cloud when a key is given. */
  destination?: SignalsDestination;
  /**
   * The build's identity, used to tell whether a fixed issue came back. A string, or the parts you
   * have. Left out in Node, the SDK reads the build variables of common platforms (see
   * \`releaseFromEnvironment\`); null sends none.
   */
  release?: string | ReleaseIdentity | null;
  environment?: SignalEnvironment;
  /** Pathrule Cloud's ingestion address, for the key. */
  endpoint?: string;
  scrub?: (value: string) => string;
  /** Instrumented points, announced in development and preview only. */
  declare?: DeclaredPoint[];
  /** The longest one delivery may take, in milliseconds (default 10 000). */
  timeoutMs?: number;
}

export interface FlushResult {
  /** idle: nothing was waiting. inert: not initialised. suppressed: the destination asked to wait. */
  outcome: "idle" | "inert" | "delivered" | "partial" | "failed" | "suppressed" | "timeout";
  /** Observations the destination accepted. */
  delivered: number;
  /** Observations still waiting for a later attempt. */
  pending: number;
  /** Observations the destination refused for good, or that no longer fit. */
  dropped: number;
}

export interface SignalsStatus {
  active: boolean;
  destination: string | null;
  environment: SignalEnvironment | null;
  release: string | null;
  releaseSource: "config" | "environment" | null;
  /** Whether a fix can be verified across releases: it needs a release identity. */
  verification: "ready" | "no_release" | "inactive";
  pending: number;
  /** Until when the destination asked the SDK to wait, or null. */
  suppressedUntil: string | null;
  /** Why the destination stopped accepting this configuration, or null. */
  disabled: string | null;
  /** Observations dropped since init: refused, or past the bounds. */
  dropped: number;
}

interface EnvelopeItem {
  type: "signal" | "declaration";
  kind: "error" | "event";
  fingerprint?: string;
  countDelta?: number;
  node?: string | null;
  flow?: string | null;
  label?: string | null;
  message?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface PendingSignal {
  item: EnvelopeItem;
  countDelta: number;
  dueAt: number;
  backoffLevel: number;
  priority: number;
  createdAt: number;
  lastOutcome: "success" | "failure" | null;
}

/** An envelope that failed and may succeed later: retried byte for byte, under the same id. */
interface RetryEnvelope {
  body: string;
  observations: number;
  priority: number;
  attempts: number;
  dueAt: number;
}

interface Tally {
  /** Observations the destination accepted. */
  delivered: number;
  /** Observations refused for good. */
  dropped: number;
  /** Envelopes kept for a later attempt. */
  retained: number;
  /** A failure or the destination's guidance ends this pass. */
  stopped: boolean;
  attempted: boolean;
}

const newTally = (): Tally => ({ delivered: 0, dropped: 0, retained: 0, stopped: false, attempted: false });

interface ActiveConfig {
  options: PathruleSignalsConfig;
  destination: SignalsDestination;
  release: string | null;
  releaseSource: "config" | "environment" | null;
}

let config: ActiveConfig | null = null;
let queue = new Map<string, PendingSignal>();
let retries: RetryEnvelope[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let microtaskScheduled = false;
let connectionPending = false;
let suppressedUntil = 0;
let disabledReason: string | null = null;
let droppedCount = 0;
/** Observations every destination accepted since init: a flush reports the difference. */
let deliveredCount = 0;
/** Observations in a delivery that has not answered yet: still waiting, from the outside. */
let inFlightCount = 0;
let pagehideHandler: (() => void) | null = null;
let shutdownHookInstalled = false;
let shutdownFlushed = false;
let generation = 0;
let sendChain: Promise<unknown> = Promise.resolve();
const processSuppression = new Map<string, number>();

function newEnvelopeId(): string {
  try {
    const random = (globalThis.crypto as Crypto | undefined)?.randomUUID?.();
    if (random) return random;
  } catch {
    // Fall through to the time-based id.
  }
  return \`\${Date.now().toString(36)}-\${Math.random().toString(36).slice(2, 12)}\`;
}

function scrub(value: string | undefined, max = 4_000): string | undefined {
  if (value == null) return value;
  const redacted = redactSecrets(value);
  try {
    const custom = config?.options.scrub ? config.options.scrub(redacted) : redacted;
    return custom.slice(0, max);
  } catch {
    return redacted.slice(0, max);
  }
}

function bounded(value: string | undefined | null, max: number): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** Metadata as it leaves the application: like a collector keeps it, with every string scrubbed. */
function sanitizeClientMetadata(raw: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Object.keys(result).length >= MAX_METADATA_KEYS) break;
    if (RESERVED_METADATA_KEYS.has(key.toLowerCase())) continue;
    if (key.toLowerCase() === "outcome") {
      if (value === "success" || value === "failure") result.outcome = value;
      continue;
    }
    if (typeof value === "string") result[key] = scrub(value, MAX_METADATA_VALUE_LENGTH);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      result[key] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

/** "Name: message" of each cause, nearest first, without repeating one: a cycle stops the walk. */
function causeChain(error: Error): string | undefined {
  const seen = new Set<unknown>([error]);
  const parts: string[] = [];
  let cause: unknown = (error as { cause?: unknown }).cause;
  while (cause !== undefined && cause !== null && parts.length < MAX_CAUSE_DEPTH) {
    if (seen.has(cause)) break;
    seen.add(cause);
    if (cause instanceof Error) {
      parts.push(\`\${cause.name}: \${cause.message}\`);
      cause = (cause as { cause?: unknown }).cause;
    } else {
      if (typeof cause === "string") parts.push(cause);
      break;
    }
  }
  return parts.length > 0 ? scrub(parts.join(" <- "), MAX_METADATA_VALUE_LENGTH) : undefined;
}

function processEnv(): Record<string, string | undefined> | undefined {
  try {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  } catch {
    return undefined;
  }
}

function resolveEnvironment(): SignalEnvironment {
  if (config?.options.environment) return config.options.environment;
  try {
    if (typeof location !== "undefined" && location.hostname) {
      const hostname = location.hostname;
      if (
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname.endsWith(".local") ||
        hostname.endsWith(".test")
      ) {
        return "development";
      }
    }
    if (processEnv()?.NODE_ENV === "development") return "development";
  } catch {
    // Detection must never affect the host application.
  }
  return "production";
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function isOffline(): boolean {
  try {
    return typeof navigator !== "undefined" && (navigator as { onLine?: boolean }).onLine === false;
  } catch {
    return false;
  }
}

/** A release string from its parts: \`version+commit@deployment\`, bounded. */
function releaseString(identity: ReleaseIdentity): string | null {
  const version = bounded(identity.version, 60);
  const commit = bounded(identity.commit, 40)?.slice(0, 12);
  const deployment = bounded(identity.deployment, 60);
  const text = [version ?? "", commit ? \`+\${commit}\` : "", deployment ? \`@\${deployment}\` : ""]
    .join("")
    .replace(/^\\+/, "");
  return bounded(text, MAX_RELEASE_LENGTH) ?? null;
}

/**
 * The build identity a Node process can read from its platform, or null: the commit and deployment
 * variables of Vercel, Netlify, Cloudflare Pages, Render, Railway, Fly.io, Heroku and GitHub
 * Actions, and \`npm_package_version\` when started by an npm script. Never guessed.
 */
export function releaseFromEnvironment(
  env: Record<string, string | undefined> | undefined = processEnv(),
): ReleaseIdentity | null {
  if (!env) return null;
  const first = (...names: string[]) => names.map((name) => env[name]).find((v) => v && v.trim());
  const identity: ReleaseIdentity = {
    version: first("PATHRULE_RELEASE", "npm_package_version"),
    commit: first(
      "VERCEL_GIT_COMMIT_SHA",
      "COMMIT_REF",
      "CF_PAGES_COMMIT_SHA",
      "RENDER_GIT_COMMIT",
      "RAILWAY_GIT_COMMIT_SHA",
      "HEROKU_SLUG_COMMIT",
      "SOURCE_VERSION",
      "GITHUB_SHA",
    ),
    deployment: first("VERCEL_DEPLOYMENT_ID", "RAILWAY_DEPLOYMENT_ID", "FLY_MACHINE_VERSION"),
  };
  return identity.version || identity.commit || identity.deployment ? identity : null;
}

function resolveRelease(
  release: PathruleSignalsConfig["release"],
): Pick<ActiveConfig, "release" | "releaseSource"> {
  if (typeof release === "string") {
    const value = bounded(release, MAX_RELEASE_LENGTH) ?? null;
    return { release: value, releaseSource: value ? "config" : null };
  }
  if (release && typeof release === "object") {
    const value = releaseString(release);
    return { release: value, releaseSource: value ? "config" : null };
  }
  if (release === undefined && !isBrowser()) {
    const detected = releaseFromEnvironment();
    const value = detected ? releaseString(detected) : null;
    return { release: value, releaseSource: value ? "environment" : null };
  }
  return { release: null, releaseSource: null };
}

function fingerprintKey(): string | null {
  if (!config) return null;
  const identity = config.destination.envelopeFields?.key ?? config.destination.kind;
  return \`\${STORAGE_PREFIX}\${fingerprintHash(\`\${identity}|\${resolveEnvironment()}\`)}\`;
}

function loadSuppression(): void {
  suppressedUntil = 0;
  const key = fingerprintKey();
  if (!key) return;
  const processValue = processSuppression.get(key) ?? 0;
  if (processValue > Date.now()) suppressedUntil = processValue;
  if (!isBrowser()) return;
  try {
    const value = Number(globalThis.localStorage?.getItem(key) ?? "0");
    if (Number.isFinite(value) && value > Date.now()) {
      suppressedUntil = Math.max(suppressedUntil, value);
    }
  } catch {
    // Storage may be unavailable or blocked.
  }
}

function persistSuppression(until: number, key = fingerprintKey()): void {
  if (!key) return;
  const storedUntil = Math.max(processSuppression.get(key) ?? 0, until);
  processSuppression.set(key, storedUntil);
  if (key === fingerprintKey()) suppressedUntil = Math.max(suppressedUntil, storedUntil);
  if (processSuppression.size > 50) {
    const oldest = processSuppression.keys().next().value as string | undefined;
    if (oldest) processSuppression.delete(oldest);
  }
  if (!isBrowser()) return;
  try {
    globalThis.localStorage?.setItem(key, String(storedUntil));
  } catch {
    // Storage errors are non-fatal.
  }
}

function envelopeBody(items: EnvelopeItem[], connection: boolean): Record<string, unknown> {
  return {
    schemaVersion: SIGNALS_PROTOCOL_VERSION,
    ...(config?.destination.envelopeFields ?? {}),
    environment: resolveEnvironment(),
    release: config?.release ?? undefined,
    connection,
    items,
  };
}

function bodyBytes(value: Record<string, unknown>): number {
  return new TextEncoder().encode(JSON.stringify({ ...value, id: "x".repeat(36) })).byteLength;
}

function splitBatches(items: EnvelopeItem[], connection: boolean): EnvelopeItem[][] {
  const batches: EnvelopeItem[][] = [];
  let current: EnvelopeItem[] = [];
  for (const item of items) {
    const candidate = [...current, item];
    const candidateConnection = connection && batches.length === 0;
    const bytes = bodyBytes(envelopeBody(candidate, candidateConnection));
    if (current.length > 0 && (candidate.length > MAX_ITEMS || bytes > MAX_BODY_BYTES)) {
      batches.push(current);
      current = [item];
    } else if (bytes <= MAX_BODY_BYTES) {
      current = candidate;
    } else {
      droppedCount += item.countDelta ?? 1;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * A delivery's deadline. The timer bounds the delivery in every runtime; the abort signal that also
 * cancels the request exists only where the runtime has AbortController.
 */
function deadline(ms: number): { signal?: AbortSignal; expired: Promise<void>; done: () => void } {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      controller?.abort();
      resolve();
    }, Math.max(1, ms));
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  return {
    ...(controller ? { signal: controller.signal } : {}),
    expired,
    done: () => clearTimeout(timer),
  };
}

function observationsIn(items: EnvelopeItem[]): number {
  return items.reduce((total, item) => total + (item.type === "signal" ? (item.countDelta ?? 1) : 0), 0);
}

function priorityOfBatch(items: EnvelopeItem[]): number {
  return items.reduce((top, item) => Math.max(top, priorityOf(item)), 0);
}

function rememberForRetry(entry: RetryEnvelope): void {
  if (entry.attempts >= MAX_ATTEMPTS) {
    droppedCount += entry.observations;
    return;
  }
  retries.push(entry);
  while (retries.length > MAX_RETRY_ENVELOPES) {
    // Out of room: the lowest-priority, oldest envelope goes.
    let victim = 0;
    for (let i = 1; i < retries.length; i++) {
      if (retries[i]!.priority < retries[victim]!.priority) victim = i;
    }
    droppedCount += retries[victim]!.observations;
    retries.splice(victim, 1);
  }
}

function disable(reason: string): void {
  disabledReason = reason;
  for (const pending of queue.values()) droppedCount += pending.countDelta;
  for (const entry of retries) droppedCount += entry.observations;
  queue = new Map();
  retries = [];
  clearFlushTimer();
}

/** One delivery attempt of one body; what happened goes into the tally and the retry list. */
async function deliver(
  entry: RetryEnvelope,
  tally: Tally,
  options: { keepalive: boolean; timeoutMs: number },
  expectedGeneration: number,
): Promise<void> {
  if (!config || expectedGeneration !== generation || disabledReason) return;
  const backoff = BACKOFF_STEPS_MS[Math.min(entry.attempts, BACKOFF_STEPS_MS.length - 1)]!;
  if (isOffline()) {
    rememberForRetry({ ...entry, dueAt: Date.now() + backoff });
    tally.retained += 1;
    tally.stopped = true;
    return;
  }
  const suppressionKey = fingerprintKey();
  const { signal, expired, done } = deadline(options.timeoutMs);
  let outcome: DeliveryOutcome;
  try {
    // A destination that ignores the abort signal still cannot hold a delivery past its time.
    const timedOut = expired.then(
      (): DeliveryOutcome => ({ ok: false, retryable: true, reason: "timeout" }),
    );
    inFlightCount += entry.observations;
    outcome = await Promise.race([
      config.destination.send(entry.body, { keepalive: options.keepalive, signal }),
      timedOut,
    ]);
  } catch {
    outcome = { ok: false, retryable: true, reason: "destination_failed" };
  } finally {
    inFlightCount = Math.max(0, inFlightCount - entry.observations);
    done();
  }
  if (expectedGeneration !== generation) return;
  const retryAfter =
    typeof outcome.retryAfterSeconds === "number" && Number.isFinite(outcome.retryAfterSeconds)
      ? outcome.retryAfterSeconds
      : 0;
  if (retryAfter > 0) persistSuppression(Date.now() + retryAfter * 1_000, suppressionKey);
  if (outcome.ok) {
    tally.delivered += entry.observations;
    deliveredCount += entry.observations;
    if (retryAfter > 0) tally.stopped = true;
    return;
  }
  if (outcome.disable) {
    droppedCount += entry.observations;
    disable(outcome.reason);
    tally.dropped += entry.observations;
    tally.stopped = true;
    return;
  }
  if (outcome.retryable) {
    rememberForRetry({
      ...entry,
      attempts: entry.attempts + 1,
      dueAt: Date.now() + Math.max(backoff, retryAfter * 1_000),
    });
    tally.retained += 1;
    tally.stopped = true;
    return;
  }
  droppedCount += entry.observations;
  tally.dropped += entry.observations;
}

/** Runs one send pass after any pass in flight: deliveries never overlap. */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = sendChain.then(task, task);
  sendChain = run.catch(() => undefined);
  return run;
}

async function sendItems(
  items: EnvelopeItem[],
  tally: Tally,
  options: { keepalive: boolean; timeoutMs: number; deadline: number },
  expectedGeneration: number,
): Promise<void> {
  if (!config || expectedGeneration !== generation || disabledReason) return;
  const includeConnection = connectionPending;
  const batches = splitBatches(items, includeConnection);
  if (batches.length === 0 && includeConnection) batches.push([]);
  for (let index = 0; index < batches.length; index++) {
    if (expectedGeneration !== generation) return;
    const batch = batches[index]!;
    const connection = includeConnection && index === 0;
    const body = JSON.stringify({ ...envelopeBody(batch, connection), id: newEnvelopeId() });
    const entry: RetryEnvelope = {
      body,
      observations: observationsIn(batch),
      priority: priorityOfBatch(batch),
      attempts: 0,
      dueAt: Date.now(),
    };
    if (connection) connectionPending = false;
    const remaining = options.deadline - Date.now();
    if (tally.stopped || Date.now() < suppressedUntil || remaining <= 0) {
      // Not attempted now: the destination asked to wait, failed already, or time is up.
      rememberForRetry({ ...entry, dueAt: Math.max(Date.now(), suppressedUntil) });
      tally.retained += 1;
      continue;
    }
    await deliver(
      entry,
      tally,
      { keepalive: options.keepalive, timeoutMs: Math.min(options.timeoutMs, remaining) },
      expectedGeneration,
    );
  }
}

function clearFlushTimer(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
}

function scheduleFlush(): void {
  if (!config || disabledReason) return;
  clearFlushTimer();
  let earliest = Number.POSITIVE_INFINITY;
  for (const pending of queue.values()) {
    if (pending.countDelta > 0) earliest = Math.min(earliest, pending.dueAt);
  }
  for (const entry of retries) earliest = Math.min(earliest, entry.dueAt);
  if (!Number.isFinite(earliest)) return;
  earliest = Math.max(earliest, suppressedUntil);
  const delay = Math.max(0, earliest - Date.now());
  const expectedGeneration = generation;
  if (delay === 0) {
    if (microtaskScheduled) return;
    microtaskScheduled = true;
    queueMicrotask(() => {
      microtaskScheduled = false;
      void runPass(false, expectedGeneration).catch(() => undefined);
    });
    return;
  }
  flushTimer = setTimeout(
    () => {
      flushTimer = null;
      void runPass(false, expectedGeneration).catch(() => undefined);
    },
    Math.min(delay, 2_147_000_000),
  );
  (flushTimer as unknown as { unref?: () => void }).unref?.();
}

/** Takes what is due (or everything, when forced) out of the queue and the retry list, and sends it. */
function runPass(
  force: boolean,
  expectedGeneration: number,
  options: { timeoutMs?: number } = {},
): Promise<Tally> {
  return serialized(async () => {
    const tally = newTally();
    try {
      if (!config || expectedGeneration !== generation || disabledReason) return tally;
      const now = Date.now();
      const timeoutMs = Math.min(
        options.timeoutMs ?? config.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        MAX_FLUSH_TIMEOUT_MS,
      );
      const deadline = now + timeoutMs;
      if (now < suppressedUntil) return tally;
      const dueRetries = retries.filter((entry) => force || entry.dueAt <= now);
      retries = retries.filter((entry) => !dueRetries.includes(entry));
      for (const entry of dueRetries) {
        tally.attempted = true;
        const remaining = deadline - Date.now();
        if (tally.stopped || remaining <= 0 || Date.now() < suppressedUntil) {
          rememberForRetry(entry);
          tally.retained += 1;
          continue;
        }
        await deliver(entry, tally, { keepalive: true, timeoutMs: remaining }, expectedGeneration);
      }
      const due: EnvelopeItem[] = [];
      for (const pending of queue.values()) {
        if (pending.countDelta <= 0 || (!force && pending.dueAt > now)) continue;
        due.push({ ...pending.item, countDelta: pending.countDelta });
        pending.countDelta = 0;
        const step = BACKOFF_STEPS_MS[Math.min(pending.backoffLevel, BACKOFF_STEPS_MS.length - 1)]!;
        pending.dueAt = now + step;
        pending.backoffLevel = Math.min(pending.backoffLevel + 1, BACKOFF_STEPS_MS.length - 1);
      }
      if (due.length > 0 || connectionPending) {
        tally.attempted = true;
        await sendItems(due, tally, { keepalive: true, timeoutMs, deadline }, expectedGeneration);
      }
      return tally;
    } finally {
      if (expectedGeneration === generation) scheduleFlush();
    }
  });
}

function pendingObservations(): number {
  let total = inFlightCount;
  for (const pending of queue.values()) total += pending.countDelta;
  for (const entry of retries) total += entry.observations;
  return total;
}

function priorityOf(item: EnvelopeItem): number {
  if (item.kind === "error" || item.label === "feedback") return 3;
  if (item.metadata?.outcome === "success" || item.metadata?.outcome === "failure") return 2;
  return 1;
}

function makeRoom(priority: number): boolean {
  if (queue.size < MAX_FINGERPRINTS) return true;
  let candidate: [string, PendingSignal] | null = null;
  for (const entry of queue.entries()) {
    if (
      !candidate ||
      entry[1].priority < candidate[1].priority ||
      (entry[1].priority === candidate[1].priority && entry[1].createdAt < candidate[1].createdAt)
    ) {
      candidate = entry;
    }
  }
  if (!candidate || candidate[1].priority > priority) return false;
  droppedCount += candidate[1].countDelta;
  queue.delete(candidate[0]);
  return true;
}

function enqueue(fingerprint: string, item: EnvelopeItem): void {
  if (!config || disabledReason) return;
  const now = Date.now();
  const outcome =
    item.metadata?.outcome === "success" || item.metadata?.outcome === "failure"
      ? item.metadata.outcome
      : null;
  const existing = queue.get(fingerprint);
  if (existing) {
    const failureToSuccess = existing.lastOutcome === "failure" && outcome === "success";
    existing.item = item;
    existing.countDelta = Math.min(MAX_COUNT_DELTA, existing.countDelta + 1);
    existing.lastOutcome = outcome ?? existing.lastOutcome;
    if (failureToSuccess) {
      existing.backoffLevel = 0;
      existing.dueAt = now;
    }
    scheduleFlush();
    return;
  }

  const priority = priorityOf(item);
  if (!makeRoom(priority)) {
    droppedCount += 1;
    return;
  }
  queue.set(fingerprint, {
    item,
    countDelta: 1,
    dueAt: now,
    backoffLevel: 0,
    priority,
    createdAt: now,
    lastOutcome: outcome,
  });
  scheduleFlush();
}

/** Page unload: everything waiting goes now, through the beacon when the destination has one. */
function flushOnPagehide(): void {
  try {
    if (!config || disabledReason || Date.now() < suppressedUntil) return;
    const items: EnvelopeItem[] = [];
    for (const pending of queue.values()) {
      if (pending.countDelta <= 0) continue;
      items.push({ ...pending.item, countDelta: pending.countDelta });
      pending.countDelta = 0;
    }
    const bodies = retries.map((entry) => entry.body);
    retries = [];
    const includeConnection = connectionPending;
    splitBatches(items, includeConnection).forEach((batch, index) => {
      bodies.push(
        JSON.stringify({ ...envelopeBody(batch, includeConnection && index === 0), id: newEnvelopeId() }),
      );
    });
    if (bodies.length === 0) return;
    connectionPending = false;
    const destination = config.destination;
    for (const body of bodies) {
      let handed = false;
      try {
        handed = destination.beacon?.(body) ?? false;
      } catch {
        handed = false;
      }
      if (!handed) {
        // No beacon (a collector that needs headers): a keepalive request, not awaited.
        const { signal } = deadline(DEFAULT_TIMEOUT_MS);
        void destination.send(body, { keepalive: true, signal }).catch(() => undefined);
      }
    }
  } catch {
    // Unload delivery is best effort.
  }
}

function installPagehide(): void {
  if (!isBrowser() || pagehideHandler) return;
  pagehideHandler = flushOnPagehide;
  window.addEventListener("pagehide", pagehideHandler);
}

function uninstallPagehide(): void {
  if (pagehideHandler && typeof window !== "undefined") {
    window.removeEventListener("pagehide", pagehideHandler);
  }
  pagehideHandler = null;
}

/** Node: once, when the event loop empties, what is still waiting gets one bounded attempt. */
function installShutdownFlush(): void {
  if (isBrowser() || shutdownHookInstalled) return;
  try {
    const proc = (globalThis as { process?: { once?: (event: string, fn: () => void) => void } })
      .process;
    if (typeof proc?.once !== "function") return;
    shutdownHookInstalled = true;
    proc.once("beforeExit", () => {
      if (shutdownFlushed || !config || pendingObservations() === 0) return;
      shutdownFlushed = true;
      void pathrule.flush().catch(() => undefined);
    });
  } catch {
    // Lifecycle hooks are best effort.
  }
}

function declarationItem(point: DeclaredPoint): EnvelopeItem {
  return {
    type: "declaration",
    kind: point.kind,
    flow: bounded(point.flow, 120) ?? null,
    label: bounded(point.label, 120) ?? null,
    node: bounded(point.node, 512) ?? null,
  };
}

/** Pathrule Cloud: the ingest key in the envelope, a CORS-simple request, and the beacon on unload. */
export function pathruleCloud(options: { key: string; endpoint?: string }): SignalsDestination {
  const endpoint = options.endpoint || PATHRULE_CLOUD_ENDPOINT;
  return {
    kind: "cloud",
    envelopeFields: { key: options.key.slice(0, 128) },
    send: (body, init) =>
      postEnvelope(endpoint, body, { "content-type": "text/plain;charset=UTF-8" }, init),
    beacon: (body) => sendBeacon(endpoint, body),
  };
}

/**
 * Your own collector: an HTTPS endpoint (http only on localhost) that takes the envelope as JSON.
 * Headers go with every request and are never logged; a browser sends a CORS preflight for them,
 * which your collector must answer. Without headers, a page unload uses the beacon.
 */
export function httpCollector(options: {
  url: string;
  headers?: Record<string, string>;
  /** The request's credentials mode in a browser (default "omit"). */
  credentials?: RequestCredentials;
}): SignalsDestination {
  const url = validCollectorUrl(options.url);
  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (typeof value === "string") headers[name.toLowerCase()] = value;
  }
  const hasCustomHeaders = Object.keys(headers).length > 1;
  return {
    kind: "http",
    send: (body, init) =>
      url
        ? postEnvelope(url, body, headers, init, options.credentials ?? "omit")
        : Promise.resolve({ ok: false, retryable: false, reason: "invalid_collector_url", disable: true }),
    // text/plain: a beacon of another type needs a CORS preflight it cannot make.
    beacon: (body) => (url && !hasCustomHeaders ? sendBeacon(url, body) : false),
  };
}

function validCollectorUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password) return null;
    if (url.protocol === "https:" || (url.protocol === "http:" && local)) return url.toString();
  } catch {
    // An invalid URL disables the destination.
  }
  return null;
}

function sendBeacon(url: string, body: string, type = "text/plain;charset=UTF-8"): boolean {
  try {
    if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") return false;
    return navigator.sendBeacon(url, new Blob([body], { type }));
  } catch {
    return false;
  }
}

/** HTTP semantics every built-in destination shares. Never throws. */
export async function postEnvelope(
  url: string,
  body: string,
  headers: Record<string, string>,
  init: { keepalive: boolean; signal?: AbortSignal },
  credentials: RequestCredentials = "omit",
): Promise<DeliveryOutcome> {
  if (typeof fetch !== "function") return { ok: false, retryable: false, reason: "no_fetch" };
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body,
      keepalive: init.keepalive && body.length <= 60_000,
      signal: init.signal,
      credentials,
    });
  } catch {
    return { ok: false, retryable: true, reason: init.signal?.aborted ? "timeout" : "network" };
  }
  let guidance: { retryAfter?: unknown; status?: unknown } | null = null;
  try {
    guidance = (await response.json()) as { retryAfter?: unknown; status?: unknown } | null;
  } catch {
    guidance = null;
  }
  const headerSeconds = Number(response.headers.get("retry-after") ?? "0");
  const bodySeconds = Number(guidance?.retryAfter ?? "0");
  const retryAfterSeconds = Math.max(
    Number.isFinite(headerSeconds) ? headerSeconds : 0,
    Number.isFinite(bodySeconds) ? bodySeconds : 0,
  );
  const after = retryAfterSeconds > 0 ? { retryAfterSeconds } : {};
  if (response.ok) return guidance?.status === "paused" ? { ok: false, retryable: true, reason: "ingest_paused", ...after } : { ok: true, ...after };
  const status = response.status;
  if (status === 401 || status === 403) {
    return { ok: false, retryable: false, reason: \`http_\${status}\`, disable: true };
  }
  if (status === 408 || status === 429 || status >= 500) {
    return { ok: false, retryable: true, reason: \`http_\${status}\`, ...after };
  }
  return { ok: false, retryable: false, reason: \`http_\${status}\` };
}

export const pathrule = {
  init(options: PathruleSignalsConfig): void {
    try {
      this.reset();
      const key = typeof options?.key === "string" ? options.key.slice(0, 128) : "";
      const destination =
        options?.destination ?? (key ? pathruleCloud({ key, endpoint: options.endpoint }) : null);
      if (!destination) return;
      config = { options: { ...options, key }, destination, ...resolveRelease(options.release) };
      connectionPending = true;
      loadSuppression();
      installPagehide();
      installShutdownFlush();

      // A server process announces once. A browser stays network-idle; its first real envelope
      // carries the connection bit.
      if (!isBrowser()) {
        void runPass(true, generation).catch(() => undefined);
      }
      if (options.declare?.length) this.declare(options.declare);
    } catch {
      config = null;
    }
  },

  /**
   * Announces instrumented points, in development and preview only: a production page would send
   * them on every load, against the quota real errors need.
   */
  declare(points: DeclaredPoint[]): void {
    try {
      if (!config || points.length === 0 || resolveEnvironment() === "production") return;
      const items = points.slice(0, MAX_FINGERPRINTS).map(declarationItem);
      const expectedGeneration = generation;
      void serialized(async () => {
        await sendItems(
          items,
          newTally(),
          {
            keepalive: true,
            timeoutMs: config?.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            deadline: Date.now() + MAX_FLUSH_TIMEOUT_MS,
          },
          expectedGeneration,
        );
      }).catch(() => undefined);
    } catch {
      // Never into the host application.
    }
  },

  reset(): void {
    generation += 1;
    // A pass of the previous configuration may still be in flight; the new one does not wait for it.
    sendChain = Promise.resolve();
    clearFlushTimer();
    uninstallPagehide();
    queue = new Map();
    retries = [];
    config = null;
    connectionPending = false;
    suppressedUntil = 0;
    disabledReason = null;
    droppedCount = 0;
    deliveredCount = 0;
    inFlightCount = 0;
    microtaskScheduled = false;
    shutdownFlushed = false;
  },

  error(error: unknown, link: SignalLink = {}): void {
    try {
      if (!config) return;
      const normalized = error instanceof Error ? error : new Error(String(error));
      const message = scrub(\`\${normalized.name}: \${normalized.message}\`) ?? "";
      const frame = topFrame(normalized.stack);
      const node = bounded(link.node, 512);
      const flow = bounded(link.flow, 120);
      const fingerprint = errorFingerprint({ message, frame, node, flow });
      const metadata = sanitizeClientMetadata({
        ...(link.meta ?? {}),
        stack: scrub(traceFrames(normalized.stack), 500),
        ...(causeChain(normalized) ? { cause: causeChain(normalized) } : {}),
      });
      enqueue(fingerprint, {
        type: "signal",
        kind: "error",
        fingerprint,
        node,
        flow,
        label: normalized.name.slice(0, 120),
        message,
        metadata,
      });
    } catch {
      // Never into the host application.
    }
  },

  event(name: string, link: SignalLink = {}): void {
    try {
      if (!config) return;
      const label = bounded(name, 120);
      if (!label) return;
      const node = bounded(link.node, 512);
      const flow = bounded(link.flow, 120);
      const message = scrub(link.text);
      const fingerprint = eventFingerprint({ label, flow, node, text: message });
      enqueue(fingerprint, {
        type: "signal",
        kind: "event",
        fingerprint,
        node,
        flow,
        label,
        message,
        metadata: sanitizeClientMetadata(link.meta),
      });
    } catch {
      // Never into the host application.
    }
  },

  /**
   * Delivers everything waiting now, within \`timeoutMs\` (default 5 000, at most 30 000), and says
   * what happened. Never rejects. In a serverless function: \`waitUntil(pathrule.flush())\`; in a
   * script: \`await pathrule.flush()\` before it exits.
   */
  async flush(options: { timeoutMs?: number } = {}): Promise<FlushResult> {
    try {
      if (!config) return { outcome: "inert", delivered: 0, pending: 0, dropped: 0 };
      if (disabledReason) {
        return { outcome: "failed", delivered: 0, pending: 0, dropped: 0 };
      }
      const timeoutMs = Math.min(
        Math.max(1, options.timeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS),
        MAX_FLUSH_TIMEOUT_MS,
      );
      // What was waiting when the flush was asked for, and the totals to report the change from: a
      // pass already in flight may deliver some of it first, and the flush runs after that pass.
      const waiting = pendingObservations() + retries.length + (connectionPending ? 1 : 0);
      const deliveredBefore = deliveredCount;
      const droppedBefore = droppedCount;
      if (waiting === 0 && queue.size === 0) {
        return { outcome: "idle", delivered: 0, pending: 0, dropped: 0 };
      }
      if (Date.now() < suppressedUntil) {
        return { outcome: "suppressed", delivered: 0, pending: pendingObservations(), dropped: 0 };
      }
      const expectedGeneration = generation;
      const started = Date.now();
      const finished = await Promise.race([
        runPass(true, expectedGeneration, { timeoutMs }).then(() => true),
        new Promise<false>((resolve) => {
          const timer = setTimeout(() => resolve(false), timeoutMs + 50);
          (timer as unknown as { unref?: () => void }).unref?.();
        }),
      ]);
      const delivered = deliveredCount - deliveredBefore;
      const dropped = droppedCount - droppedBefore;
      const pending = pendingObservations();
      const retained = retries.length;
      let outcome: FlushResult["outcome"];
      if (!finished) outcome = "timeout";
      else if (disabledReason) outcome = "failed";
      else if (waiting === 0) outcome = "idle";
      else if (pending === 0 && retained === 0 && dropped === 0) outcome = "delivered";
      else if (delivered > 0) outcome = "partial";
      else if (Date.now() < suppressedUntil) outcome = "suppressed";
      else if (Date.now() - started >= timeoutMs) outcome = "timeout";
      else outcome = "failed";
      return { outcome, delivered, pending, dropped };
    } catch {
      return { outcome: "failed", delivered: 0, pending: 0, dropped: 0 };
    }
  },

  /** What the SDK is doing, for a diagnostics page or a test. */
  status(): SignalsStatus {
    return {
      active: Boolean(config) && !disabledReason,
      destination: config?.destination.kind ?? null,
      environment: config ? resolveEnvironment() : null,
      release: config?.release ?? null,
      releaseSource: config?.releaseSource ?? null,
      verification: !config ? "inactive" : config.release ? "ready" : "no_release",
      pending: pendingObservations(),
      suppressedUntil: suppressedUntil > Date.now() ? new Date(suppressedUntil).toISOString() : null,
      disabled: disabledReason,
      dropped: droppedCount,
    };
  },
};

export default pathrule;
`;
