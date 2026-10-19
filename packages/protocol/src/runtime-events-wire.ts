// SPDX-License-Identifier: Apache-2.0
// AUTO-GENERATED from packages/signals-sdk/src/protocol.ts: do not edit by hand.
// Regenerate: node scripts/gen-signals-protocol.mjs
// The Pathrule Signals wire protocol, version 1: what an SDK sends, and how a collector reads it.
//
// One envelope per request, JSON:
//
//   { schemaVersion?: 1, id?: string, key?: string, environment?, release?, connection?, items }
//
// - `items` holds at most 50 observations: `signal` items (an error or an event, grouped by its
//   fingerprint, `countDelta` occurrences since the last delivery) and `declaration` items (a point
//   the application instruments, with no occurrence).
// - `key` is the Pathrule Cloud ingest key. Other destinations authenticate outside the envelope
//   (a header, the local host's token) and send none.
// - `schemaVersion` and `id` are optional for compatibility: an envelope without them is version 1,
//   and the collectors that predate them ignore them. `id` lets a collector recognise a retried
//   envelope.
// - Older forms stay valid: a single item at the top level, `{ hello: true }` and
//   `{ declare: true, points }`.
//
// The content is untrusted: anyone holding a public ingest key can send any message. Collectors
// store it as data and never as instructions.
//
// This module has no imports: the SDK copied into a project carries it, and Pathrule's own packages
// carry a generated copy of it. Every implementation, in any language, is checked against
// `protocol/vectors.json`.

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
 * Reads one parsed envelope. `requireKey` (the default, as Pathrule Cloud reads it) refuses an
 * envelope without an ingest key; a collector that authenticates otherwise passes false. `bytes`,
 * when the caller knows the body's size, refuses a body over `MAX_BODY_BYTES`.
 *
 * For an envelope without the version 1 fields this is the reading Pathrule Cloud's ingestion has
 * always applied, item for item (`protocol/vectors.json` holds both to it).
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
  return `decl:${item.kind}:${item.flow ?? ""}:${item.label ?? ""}`;
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
  return fnv(0x811c9dc5, input) + fnv(0x811c9dc5, `${input}\u0001pr`);
}

/** Volatile parts out of a message or frame: UUIDs, hex addresses, numbers. */
export function normalizeForFingerprint(value: string): string {
  return value
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/0x[0-9a-f]+/gi, "<hex>")
    .replace(/\d+/g, "<n>")
    .trim();
}

/** Frames of a dependency rather than of the application, matched on the raw stack line. */
export const VENDOR_FRAME = /[/\\]node_modules[/\\]|[/\\]\.vite[/\\]deps[/\\]/;
export const MAX_TRACE_FRAMES = 5;

export function frameLines(stack: string | undefined): string[] {
  if (!stack) return [];
  return stack.split("\n").filter((candidate) => /\s+at\s+/.test(candidate));
}

/** A frame without its directories and query strings. */
export function formatFrame(line: string): string {
  return line
    .replace(/\(.*[/\\]/, "(")
    .replace(/\?[^):]*/g, "")
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
  return chosen.join("\n");
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
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>")
    .replace(/\b(?:sk|pk|ghp|ghs|xox[baprs])[-_][A-Za-z0-9]{8,}\b/g, "<redacted>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>");
}
