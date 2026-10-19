// SPDX-License-Identifier: Apache-2.0
export const TELEMETRY_ALLOWED_EVENT_FIELDS = [
  "event_name",
  "schema_version",
  "occurred_at",
  "surface",
  "host_kind",
  "app_version",
  "os_family",
  "country_iso",
  "pseudonymous_install_id",
  "session_local_id",
  "duration_ms",
  "result",
  "blocking_reason",
  "feature_tag",
  // A random id per event, so a batch delivered twice after a lost response is one event, not two.
  "event_id",
] as const;

export type TelemetryAllowedEventField = (typeof TELEMETRY_ALLOWED_EVENT_FIELDS)[number];

export const TELEMETRY_FORBIDDEN_EVENT_FIELDS = [
  "user_id",
  "org_id",
  "workspace_id",
  "email",
  "name",
  "local_path",
  "file_name",
  "env_keys",
  "error_message_text",
  "stack_trace",
  "query_string",
  "git_remote_url",
] as const;

export type TelemetryForbiddenEventField = (typeof TELEMETRY_FORBIDDEN_EVENT_FIELDS)[number];

export type TelemetrySurface = "web" | "desktop" | "cli" | "mcp";
export type TelemetryHostKind = "electron" | "web" | "cli-bridge";
export type TelemetryResult = "ok" | "failed" | "blocked";

export type TelemetryEventPayload = Partial<Record<TelemetryAllowedEventField, string | number>> & {
  event_name: string;
  schema_version: number;
  occurred_at: string;
  surface: TelemetrySurface;
  host_kind: TelemetryHostKind;
  pseudonymous_install_id: string;
  session_local_id: string;
  result: TelemetryResult;
};

export function assertTelemetryPayloadAllowed(payload: Record<string, unknown>): void {
  const allowed = new Set<string>(TELEMETRY_ALLOWED_EVENT_FIELDS);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      throw new Error(`telemetry_field_not_allowed:${key}`);
    }
  }
}
