// SPDX-License-Identifier: Apache-2.0
/**
 * stdout is reserved for JSON-RPC traffic; every log line must go to
 * stderr to avoid corrupting the MCP protocol stream. Each log is a
 * single JSON object per line so a future log viewer can parse it.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  msg: string;
  ts: string;
  extra?: Record<string, unknown>;
}

export function log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
  const entry: LogEntry = {
    level,
    msg,
    ts: new Date().toISOString(),
    ...(extra && { extra }),
  };
  process.stderr.write(JSON.stringify(entry) + "\n");
}
