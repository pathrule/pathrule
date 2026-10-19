// SPDX-License-Identifier: Apache-2.0
// Where Pathrule's product telemetry goes: PostHog's capture API, EU region.
//
// What an event may carry is the telemetry contract's decision (`contract.ts`): allowlisted fields, a
// pseudonymous install id, never an account, workspace, path or piece of content. This module only
// addresses those events. Each becomes one PostHog event keyed by the install id, personless
// (`$process_person_profile: false`, so PostHog builds no person profile from it), with the payload's
// `event_id` as the event uuid, so a batch sent twice after a lost response is the same events and
// not a second copy.
//
// Only Pathrule's own managed builds send. The callers decide that (`managedTelemetryTarget` in the
// CLI, the console's deployment check): a self-hosted deployment, a development build or a runtime
// pointed at another backend sends nothing to Pathrule.

import type { TelemetryEventPayload } from "./contract.js";

/** PostHog's EU ingestion host. */
export const POSTHOG_INGEST_HOST = "https://eu.i.posthog.com";

declare const __BUILD_POSTHOG_PROJECT_KEY__: string | undefined;

/**
 * Pathrule's PostHog project key, supplied by Pathrule's own builds. It is a public, write-only
 * ingestion key (it can add events to the project and read nothing), kept out of the source so a
 * build made from it carries none and sends nothing.
 */
export function posthogProjectKey(): string {
  return typeof __BUILD_POSTHOG_PROJECT_KEY__ === "string" ? __BUILD_POSTHOG_PROJECT_KEY__ : "";
}

export interface TelemetryTarget {
  /** The batch capture endpoint. */
  url: string;
  apiKey: string;
}

/** Pathrule's managed target, or an explicit host and key (a test stand-in, a staging project). */
export function posthogTarget(override?: { host?: string; key?: string }): TelemetryTarget {
  const host = (override?.host || POSTHOG_INGEST_HOST).replace(/\/+$/, "");
  return { url: `${host}/batch/`, apiKey: override?.key || posthogProjectKey() };
}

const PROPERTY_FIELDS = [
  "schema_version",
  "surface",
  "host_kind",
  "app_version",
  "os_family",
  "session_local_id",
  "duration_ms",
  "result",
  "blocking_reason",
  "feature_tag",
] as const satisfies readonly (keyof TelemetryEventPayload)[];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PostHogBatchBody {
  api_key: string;
  batch: Array<{
    event: string;
    distinct_id: string;
    timestamp: string;
    uuid?: string;
    properties: Record<string, string | number | boolean>;
  }>;
}

/** The capture body for a batch of contract payloads. `lib` names the sending surface. */
export function posthogBatch(
  events: readonly TelemetryEventPayload[],
  target: TelemetryTarget,
  lib: string,
): PostHogBatchBody {
  return {
    api_key: target.apiKey,
    batch: events.map((payload) => {
      const properties: Record<string, string | number | boolean> = {
        $lib: lib,
        $process_person_profile: false,
      };
      for (const field of PROPERTY_FIELDS) {
        const value = payload[field];
        if (value !== undefined && value !== "") properties[field] = value;
      }
      if (payload.app_version) properties.$lib_version = payload.app_version;
      return {
        event: payload.event_name,
        distinct_id: payload.pseudonymous_install_id,
        timestamp: payload.occurred_at,
        ...(typeof payload.event_id === "string" && UUID.test(payload.event_id)
          ? { uuid: payload.event_id }
          : {}),
        properties,
      };
    }),
  };
}
