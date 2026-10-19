// SPDX-License-Identifier: Apache-2.0
export interface CliRemediation {
  label: string;
  command?: string;
  url?: string;
}

export interface CliNextStep {
  label: string;
  command?: string;
  url?: string;
}

export interface CliJsonEnvelope<T = unknown> {
  schema_version: 1;
  ok: boolean;
  command: string;
  cwd: string;
  data?: T;
  error?: {
    code: string;
    message: string;
    remediation?: CliRemediation[];
  };
  next_steps?: CliNextStep[];
  /** What this run ran without, and why: a capability the person chose that is not available. */
  warnings?: CliWarning[];
}

export interface CliWarning {
  code: string;
  message: string;
}

export interface CliOutputMode {
  json: boolean;
  color: boolean;
  interactive: boolean;
  noOpen?: boolean;
}

export function jsonEnvelope<T>(input: {
  command: string;
  cwd: string;
  ok: boolean;
  data?: T;
  error?: CliJsonEnvelope<T>["error"];
  next_steps?: CliNextStep[];
}): CliJsonEnvelope<T> {
  return {
    schema_version: 1,
    ok: input.ok,
    command: input.command,
    cwd: input.cwd,
    ...(input.data === undefined ? {} : { data: input.data }),
    ...(input.error === undefined ? {} : { error: input.error }),
    ...(input.next_steps === undefined ? {} : { next_steps: input.next_steps }),
  };
}

export function renderJson(envelope: CliJsonEnvelope): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export function statusLabel(kind: "ok" | "warn" | "error" | "info", mode: CliOutputMode): string {
  const plain = {
    ok: "[ok]",
    warn: "[warn]",
    error: "[error]",
    info: "[info]",
  } as const;
  if (!mode.color) return plain[kind];

  const color = {
    ok: "\x1b[32m",
    warn: "\x1b[33m",
    error: "\x1b[31m",
    info: "\x1b[36m",
  } as const;
  return `${color[kind]}${plain[kind]}\x1b[0m`;
}

/** The stable code of an error: its own `code` when it carries one, else its message. */
export function cliErrorCode(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return err instanceof Error ? err.message : fallback;
}
