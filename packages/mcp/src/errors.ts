// SPDX-License-Identifier: Apache-2.0
// Shapes tool-handler errors into the MCP response envelope we return over
// stdio. Claude reads the `text` field, so the message should be short and
// actionable.

import type { ToolError } from "@pathrule/core/tools/types.js";

export function formatToolError(err: ToolError): {
  ok: false;
  error: { code: string; message: string; detail?: unknown };
} {
  return err.detail !== undefined
    ? { ok: false, error: { code: err.code, message: err.message, detail: err.detail } }
    : { ok: false, error: { code: err.code, message: err.message } };
}

export function formatThrown(e: unknown): {
  ok: false;
  error: { code: string; message: string };
} {
  // Preserve a structured ToolError thrown from resolveContext or other helpers
  // (e.g. subscription_required) so the tool envelope keeps the typed code.
  if (e !== null && typeof e === "object" && "code" in e && "message" in e) {
    const obj = e as { code: unknown; message: unknown };
    return { ok: false, error: { code: String(obj.code), message: String(obj.message) } };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { ok: false, error: { code: "upstream_error", message: msg } };
}
