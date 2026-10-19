// SPDX-License-Identifier: Apache-2.0
// `pathrule embeddings`: which embedding provider semantic search uses on this machine, with no
// account. Without one, Pathrule ranks by keywords and nothing leaves the machine.
//
//   status                     the provider, model and vector space, what is sent where, and how
//                              many of this workspace's memories have a vector of that space
//   use <provider>             check a provider with one small embedding, then save it:
//                              local [--model m] [--base-url http://127.0.0.1:11434/v1]
//                              openai | voyage [--model m]
//                              cloudflare --account-id <id> [--model m]
//                              The key is asked for without echo, or read from stdin.
//   off                        remove the provider and its stored key
//   reindex                    re-embed this workspace's memories into the provider's space
//
// Keys never appear in output: status says only whether one is set and where it came from.
import { escapeTerminalControlChars } from "@pathrule/core/util/safe-name.js";

import {
  embeddingsOff,
  embeddingsStatus,
  EmbeddingsCommandError,
  providerNeedsKey,
  reasonText,
  reindexEmbeddings,
  REINDEX_HINT,
  RESTART_HINT,
  storedKeyFor,
  useEmbeddingProvider,
  type EmbeddingsStatusResult,
  type ReindexTotals,
  type UseResult,
} from "../local/embeddings-local.js";
import { jsonEnvelope, statusLabel, type CliOutputMode } from "../output.js";
import type { CliCommand, CliCommandContext, CliJsonResult, CliRuntime } from "../plugin.js";

const USAGE =
  "Usage: pathrule embeddings <status|use <local|openai|voyage|cloudflare>|off|reindex> [--model <name>] [--base-url <url>] [--account-id <id>] [--json]";

export const embeddingsCommand: CliCommand = {
  name: "embeddings",
  help: {
    section: "diagnostics",
    rank: 65,
    summary: "Choose the embedding provider for semantic search (status/use/off/reindex)",
    usage: [USAGE.slice("Usage: ".length)],
  },
  run: (ctx) => renderEmbeddings(ctx),
  json: (ctx) => embeddingsJson(ctx),
};

interface ParsedArgs {
  sub: string | undefined;
  provider: string | undefined;
  model?: string;
  baseUrl?: string;
  accountId?: string;
}

export function parseEmbeddingsArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const match = /^--(model|base-url|account-id)(?:=(.*))?$/.exec(arg);
    if (!match) {
      positionals.push(arg);
      continue;
    }
    const value = match[2] ?? args[++i];
    if (value === undefined || value.trim() === "") {
      throw new EmbeddingsCommandError(
        "invalid_option",
        `--${match[1]} needs a value. ${USAGE}`,
        64,
      );
    }
    options[match[1]!] = value.trim();
  }
  return {
    sub: positionals[0],
    provider: positionals[1]?.toLowerCase(),
    ...(options.model ? { model: options.model } : {}),
    ...(options["base-url"] ? { baseUrl: options["base-url"] } : {}),
    ...(options["account-id"] ? { accountId: options["account-id"] } : {}),
  };
}

const safe = (value: string | null | undefined): string => escapeTerminalControlChars(value ?? "");

// ── the key ──────────────────────────────────────────────────────────────

/** Reads all of stdin. */
export async function readAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

/** A hidden prompt on this terminal: nothing typed is echoed. Ctrl-C cancels. */
export function promptHidden(runtime: CliRuntime, prompt: string): Promise<string> {
  const stdin = process.stdin;
  runtime.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const done = (fn: () => void) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      runtime.stderr.write("\n");
      fn();
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return done(() => resolve(value));
        if (ch === "\u0003") {
          return done(() =>
            reject(new EmbeddingsCommandError("embeddings_canceled", "Canceled.", 130)),
          );
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/**
 * The key for `provider`: piped stdin when stdin is not a terminal, else a hidden prompt when this
 * run may ask. Empty keeps a key already stored for the provider. Never prompts under --json or CI.
 */
async function readKey(ctx: CliCommandContext, provider: string): Promise<string | null> {
  const { runtime, mode } = ctx;
  const stored = storedKeyFor(provider, runtime.env) !== null;
  const stdinIsTTY = runtime.stdinIsTTY ?? process.stdin.isTTY ?? false;
  if (!stdinIsTTY) {
    const piped = (await (runtime.readStdin ?? readAll)()).split(/\r?\n/)[0]!.trim();
    return piped !== "" ? piped : null;
  }
  const canAsk =
    mode.interactive &&
    !mode.json &&
    (runtime.promptSecret !== undefined ||
      (process.env.NODE_ENV !== "test" && Boolean(process.stdin.isTTY && process.stdout.isTTY)));
  if (!canAsk) {
    if (stored) return null;
    throw new EmbeddingsCommandError(
      "embedding_key_required",
      `${provider} needs an API key. Pipe it on stdin: pathrule embeddings use ${provider} < key-file`,
      64,
    );
  }
  const ask = runtime.promptSecret ?? ((prompt: string) => promptHidden(runtime, prompt));
  const answer = (
    await ask(`${provider} API key${stored ? " (Enter keeps the stored one)" : ""}: `)
  ).trim();
  return answer !== "" ? answer : null;
}

// ── running a subcommand ─────────────────────────────────────────────────

type Outcome =
  | { sub: "status"; data: EmbeddingsStatusResult }
  | { sub: "use"; data: UseResult }
  | { sub: "off"; data: { removed: boolean; overrides: string[] } }
  | { sub: "reindex"; data: ReindexTotals };

async function runSubcommand(
  ctx: CliCommandContext,
  onProgress?: (totals: ReindexTotals) => void,
): Promise<Outcome> {
  const { runtime } = ctx;
  const parsed = parseEmbeddingsArgs(ctx.args);
  switch (parsed.sub ?? "status") {
    case "status":
      return { sub: "status", data: await embeddingsStatus(runtime.cwd, runtime.env) };
    case "use": {
      if (!parsed.provider)
        throw new EmbeddingsCommandError("invalid_embeddings_command", USAGE, 64);
      const apiKey = providerNeedsKey(parsed.provider) ? await readKey(ctx, parsed.provider) : null;
      const data = await useEmbeddingProvider(
        {
          provider: parsed.provider,
          apiKey,
          ...(parsed.model ? { model: parsed.model } : {}),
          ...(parsed.baseUrl ? { baseUrl: parsed.baseUrl } : {}),
          ...(parsed.accountId ? { accountId: parsed.accountId } : {}),
          ...(runtime.fetch ? { fetchImpl: runtime.fetch } : {}),
        },
        runtime.env,
      );
      return { sub: "use", data };
    }
    case "off":
      return { sub: "off", data: await embeddingsOff(runtime.env) };
    case "reindex":
      return {
        sub: "reindex",
        data: await reindexEmbeddings(runtime.cwd, runtime.env, onProgress),
      };
    default:
      throw new EmbeddingsCommandError("invalid_embeddings_command", USAGE, 64);
  }
}

function failure(err: unknown): EmbeddingsCommandError {
  if (err instanceof EmbeddingsCommandError) return err;
  // Store and host errors carry no key: none is ever handed to them.
  const message = err instanceof Error ? err.message : String(err);
  return new EmbeddingsCommandError("embeddings_failed", message);
}

async function embeddingsJson(ctx: CliCommandContext): Promise<CliJsonResult> {
  const command = `embeddings ${ctx.args[0] ?? "status"}`;
  try {
    const outcome = await runSubcommand(ctx);
    return {
      exitCode: 0,
      envelope: jsonEnvelope({ command, cwd: ctx.runtime.cwd, ok: true, data: jsonData(outcome) }),
    };
  } catch (err) {
    const error = failure(err);
    return {
      exitCode: error.exitCode,
      envelope: jsonEnvelope({
        command,
        cwd: ctx.runtime.cwd,
        ok: false,
        error: { code: error.code, message: error.message },
      }),
    };
  }
}

function jsonData(outcome: Outcome): unknown {
  if (outcome.sub !== "status") return outcome.data;
  const { config, workspace } = outcome.data;
  return {
    provider: config.provider,
    model: config.model,
    configured: config.configured,
    reason: config.reason,
    space: config.space ?? workspace?.space ?? null,
    space_family: config.spaceFamily,
    endpoint_host: config.endpointHost,
    on_device: config.onDevice,
    key: config.key,
    sources: config.sources,
    descriptor: config.descriptor,
    sends: outcome.data.sends,
    overrides: outcome.data.overrides,
    settings_file: outcome.data.settingsFile,
    workspace,
    host_restart_needed: outcome.data.hostDiffers,
  };
}

async function renderEmbeddings(ctx: CliCommandContext): Promise<number> {
  const { runtime, mode } = ctx;
  const out = (line: string) => runtime.stdout.write(`${line}\n`);
  try {
    const outcome = await runSubcommand(ctx, (totals) => {
      if (totals.stopped === "limit" || totals.stopped === "time_budget") {
        out(`  re-embedded ${totals.reembedded}, ${totals.remaining} to go`);
      }
    });
    switch (outcome.sub) {
      case "status":
        renderStatus(outcome.data, out, mode);
        return 0;
      case "use":
        renderUse(outcome.data, out, mode);
        return 0;
      case "off":
        out(
          `${statusLabel("ok", mode)} ${outcome.data.removed ? "Removed the embedding provider and its stored key." : "No embedding provider was saved."} Pathrule ranks by keywords.`,
        );
        renderOverrides(outcome.data.overrides, out, mode);
        out(RESTART_HINT);
        return 0;
      case "reindex":
        return renderReindex(outcome.data, out, mode);
    }
  } catch (err) {
    const error = failure(err);
    runtime.stderr.write(`${statusLabel("error", mode)} ${error.message}\n`);
    return error.exitCode;
  }
}

function renderOverrides(
  overrides: string[],
  out: (line: string) => void,
  mode: CliOutputMode,
): void {
  if (overrides.length === 0) return;
  out(
    `${statusLabel("warn", mode)} Set in this environment, and used before the saved setting: ${overrides.join(", ")}`,
  );
}

function renderStatus(
  data: EmbeddingsStatusResult,
  out: (line: string) => void,
  mode: CliOutputMode,
): void {
  const { config, workspace } = data;
  if (config.configured) {
    out(`${statusLabel("ok", mode)} Embeddings: ${safe(config.provider)} (${safe(config.model)})`);
  } else {
    const label = config.reason === "no_provider" ? "info" : "warn";
    out(
      `${statusLabel(label, mode)} Embeddings: off${config.provider ? ` (${safe(config.provider)}: ${reasonText(config.reason)})` : ""}. Pathrule ranks by keywords.`,
    );
  }
  if (config.provider) {
    out(
      `  space:     ${safe(config.space ?? workspace?.space ?? `${config.spaceFamily} (dimension not measured yet)`)}`,
    );
    out(`  endpoint:  ${safe(config.endpointHost)}`);
    const key =
      config.key === "not_needed"
        ? "not needed"
        : config.key === "set"
          ? `set (****, ${config.sources.key === "env" ? "from PATHRULE_EMBEDDING_API_KEY" : "stored in embedding-credentials.json, 0600"})`
          : "missing";
    out(`  key:       ${key}`);
    if (config.descriptor?.minSimilarity !== undefined) {
      out(`  floor:     ${config.descriptor.minSimilarity} (this model's cosine scale)`);
    }
  }
  out(`  sends:     ${data.sends}`);
  renderOverrides(data.overrides, out, mode);
  if (workspace) {
    out(
      `  vectors:   ${workspace.current} current, ${workspace.stale} stale, ${workspace.missing} missing of ${workspace.memories} memories in this workspace`,
    );
    if (config.configured && workspace.stale + workspace.missing > 0 && !data.hostDiffers)
      out(REINDEX_HINT);
  } else {
    out("  vectors:   no local workspace covers this folder");
  }
  if (data.hostDiffers)
    out(
      `${statusLabel("warn", mode)} The running host still uses an earlier setting. ${RESTART_HINT}`,
    );
}

function renderUse(data: UseResult, out: (line: string) => void, mode: CliOutputMode): void {
  out(
    `${statusLabel("ok", mode)} Embeddings: ${safe(data.config.provider)} (${safe(data.config.model)}), checked with one embedding of ${data.dims} dimensions.`,
  );
  out(`  space:     ${safe(data.space)}`);
  out(`  sends:     ${data.sends}`);
  renderOverrides(data.overrides, out, mode);
  out(REINDEX_HINT);
  out(RESTART_HINT);
}

function renderReindex(
  data: ReindexTotals,
  out: (line: string) => void,
  mode: CliOutputMode,
): number {
  const summary = `re-embedded ${data.reembedded}${data.failed > 0 ? `, ${data.failed} failed` : ""}, ${data.remaining} without a vector of ${safe(data.space ?? "the current space")}`;
  if (data.stopped === "done" && data.remaining === 0) {
    out(`${statusLabel("ok", mode)} Reindex complete: ${summary}.`);
    return 0;
  }
  const why: Record<ReindexTotals["stopped"], string> = {
    done: "some memories could not be embedded; run it again to retry them",
    limit: "stopped early; run it again to continue",
    time_budget: "stopped early; run it again to continue",
    not_configured: "no embedding provider is configured",
    provider_failure: "the provider kept failing; run it again later to continue where it stopped",
    space_changed: `the provider now answers in another space. ${RESTART_HINT}, then run this again`,
  };
  out(`${statusLabel("warn", mode)} Reindex incomplete: ${summary}. ${why[data.stopped]}.`);
  return data.stopped === "done" ? 0 : 1;
}
