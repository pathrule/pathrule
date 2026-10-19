// SPDX-License-Identifier: Apache-2.0
// `pathrule topics`: the model that names knowledge topics in the Local Console, with no account.
// Topics are grouped on this machine without any model; a model only names them. Without one, the
// console shows each topic's words.
//
//   status                     the provider and model, whether a key is set, and what is sent where
//   use <provider>             check a model by naming one sample topic, then save it:
//                              anthropic [--model m]            (default: a Claude Haiku model)
//                              openai --model m
//                              cloudflare --account-id <id> [--model m]
//                              local --model m [--base-url http://127.0.0.1:11434/v1]
//                              The key is asked for without echo, or read from stdin.
//   off                        remove the model and its stored key
//
// Keys never appear in output: status says only whether one is set.
import {
  createTopicNamer,
  LOCAL_MODEL_BASE_URL,
  TopicNamingError,
  type TopicModelConfig,
  type TopicModelProvider,
} from "@pathrule/core/knowledge-map/topic-names.js";
import {
  clearTopicModelSettings,
  defaultTopicModel,
  isTopicModelProvider,
  readTopicModelKey,
  readTopicModelSettings,
  topicModelFiles,
  writeTopicModelSettings,
} from "@pathrule/core/storage/topic-model-settings.js";
import { escapeTerminalControlChars } from "@pathrule/core/util/safe-name.js";

import { jsonEnvelope, statusLabel } from "../output.js";
import type { CliCommand, CliCommandContext, CliJsonResult } from "../plugin.js";
import { promptHidden, readAll } from "./embeddings.js";

const USAGE =
  "Usage: pathrule topics <status|use <anthropic|openai|cloudflare|local>|off> [--model <name>] [--base-url <url>] [--account-id <id>] [--json]";

export const SENDS =
  "each topic's words, its folder and up to six item titles, never an item's text";

export class TopicsCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

export const topicsCommand: CliCommand = {
  name: "topics",
  help: {
    section: "diagnostics",
    rank: 66,
    summary: "Choose the model that names knowledge topics in the console (status/use/off)",
    usage: [USAGE.slice("Usage: ".length)],
  },
  run: (ctx) => renderTopics(ctx),
  json: (ctx) => topicsJson(ctx),
};

interface ParsedArgs {
  sub: string | undefined;
  provider: string | undefined;
  model?: string;
  baseUrl?: string;
  accountId?: string;
}

export function parseTopicsArgs(args: readonly string[]): ParsedArgs {
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
      throw new TopicsCommandError("invalid_option", `--${match[1]} needs a value. ${USAGE}`, 64);
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

/** Where a provider's requests go, for status and the confirmation line. */
export function endpointHost(provider: TopicModelProvider, baseUrl?: string): string {
  if (provider === "anthropic") return "api.anthropic.com";
  if (provider === "cloudflare") return "api.cloudflare.com";
  const url =
    baseUrl ?? (provider === "local" ? LOCAL_MODEL_BASE_URL : "https://api.openai.com/v1");
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The key: piped stdin, else a hidden prompt when this run may ask. Empty keeps a stored key. */
async function readKey(
  ctx: CliCommandContext,
  provider: TopicModelProvider,
): Promise<string | null> {
  const { runtime, mode } = ctx;
  const stored = readTopicModelKey(provider, runtime.env);
  const stdinIsTTY = runtime.stdinIsTTY ?? process.stdin.isTTY ?? false;
  if (!stdinIsTTY) {
    const piped = (await (runtime.readStdin ?? readAll)()).split(/\r?\n/)[0]!.trim();
    return piped !== "" ? piped : stored;
  }
  const canAsk =
    mode.interactive &&
    !mode.json &&
    (runtime.promptSecret !== undefined ||
      (process.env.NODE_ENV !== "test" && Boolean(process.stdin.isTTY && process.stdout.isTTY)));
  if (!canAsk) {
    if (stored) return stored;
    throw new TopicsCommandError(
      "topics_key_required",
      `${provider} needs an API key. Pipe it on stdin: pathrule topics use ${provider} < key-file`,
      64,
    );
  }
  const ask = runtime.promptSecret ?? ((prompt: string) => promptHidden(runtime, prompt));
  const answer = (
    await ask(`${provider} API key${stored ? " (Enter keeps the stored one)" : ""}: `)
  ).trim();
  return answer !== "" ? answer : stored;
}

type Outcome =
  | {
      sub: "status";
      data: {
        provider: TopicModelProvider | null;
        model: string | null;
        endpoint: string | null;
        key: "set" | "missing" | "not_needed" | null;
        sends: string;
        settingsFile: string;
      };
    }
  | {
      sub: "use";
      data: { provider: TopicModelProvider; model: string; endpoint: string; sample: string };
    }
  | { sub: "off"; data: { removed: boolean } };

async function use(ctx: CliCommandContext, parsed: ParsedArgs): Promise<Outcome> {
  const { runtime } = ctx;
  const provider = parsed.provider;
  if (!isTopicModelProvider(provider)) {
    throw new TopicsCommandError("invalid_topics_command", USAGE, 64);
  }
  const model = parsed.model ?? defaultTopicModel(provider);
  if (!model) {
    throw new TopicsCommandError(
      "topics_model_required",
      `${provider} needs a model: pathrule topics use ${provider} --model <name>`,
      64,
    );
  }
  if (provider === "cloudflare" && !parsed.accountId) {
    throw new TopicsCommandError(
      "topics_account_required",
      "cloudflare needs your account id: pathrule topics use cloudflare --account-id <id>",
      64,
    );
  }
  const apiKey = provider === "local" ? null : await readKey(ctx, provider);
  if (provider !== "local" && !apiKey) {
    throw new TopicsCommandError("topics_key_required", `${provider} needs an API key.`, 64);
  }
  const config: TopicModelConfig = {
    provider,
    model,
    ...(parsed.baseUrl ? { baseUrl: parsed.baseUrl } : {}),
    ...(parsed.accountId ? { accountId: parsed.accountId } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
  // One sample topic proves the key, the model and the answer's shape before anything is saved.
  let sample: string | undefined;
  try {
    const names = await createTopicNamer(config, runtime.fetch ?? fetch).name([
      {
        id: "sample",
        terms: ["deploy", "release", "worktree"],
        homePath: "/",
        titles: [
          "Release every channel in order",
          "Verify a commit in a worktree",
          "Deploy staging after the owner approves",
        ],
      },
    ]);
    sample = names.sample;
  } catch (err) {
    const reason =
      err instanceof TopicNamingError ? err.message : "The model could not be reached.";
    throw new TopicsCommandError("topics_check_failed", `Nothing was saved. ${reason}`, 1);
  }
  if (!sample) {
    throw new TopicsCommandError(
      "topics_check_failed",
      "Nothing was saved. The model answered without a name.",
      1,
    );
  }
  await writeTopicModelSettings(
    {
      provider,
      model,
      ...(parsed.baseUrl ? { base_url: parsed.baseUrl } : {}),
      ...(parsed.accountId ? { account_id: parsed.accountId } : {}),
    },
    apiKey,
    runtime.env,
  );
  return {
    sub: "use",
    data: { provider, model, endpoint: endpointHost(provider, parsed.baseUrl), sample },
  };
}

async function runSubcommand(ctx: CliCommandContext): Promise<Outcome> {
  const parsed = parseTopicsArgs(ctx.args);
  const env = ctx.runtime.env;
  switch (parsed.sub ?? "status") {
    case "status": {
      const settings = readTopicModelSettings(env);
      return {
        sub: "status",
        data: {
          provider: settings?.provider ?? null,
          model: settings?.model ?? null,
          endpoint: settings ? endpointHost(settings.provider, settings.base_url) : null,
          key: !settings
            ? null
            : settings.provider === "local"
              ? "not_needed"
              : readTopicModelKey(settings.provider, env)
                ? "set"
                : "missing",
          sends: SENDS,
          settingsFile: topicModelFiles(env).settings,
        },
      };
    }
    case "use":
      return use(ctx, parsed);
    case "off":
      return { sub: "off", data: { removed: await clearTopicModelSettings(env) } };
    default:
      throw new TopicsCommandError("invalid_topics_command", USAGE, 64);
  }
}

function failure(err: unknown): TopicsCommandError {
  if (err instanceof TopicsCommandError) return err;
  return new TopicsCommandError("topics_failed", err instanceof Error ? err.message : String(err));
}

async function topicsJson(ctx: CliCommandContext): Promise<CliJsonResult> {
  const command = `topics ${ctx.args[0] ?? "status"}`;
  try {
    const outcome = await runSubcommand(ctx);
    return {
      exitCode: 0,
      envelope: jsonEnvelope({ command, cwd: ctx.runtime.cwd, ok: true, data: outcome.data }),
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

async function renderTopics(ctx: CliCommandContext): Promise<number> {
  const { runtime, mode } = ctx;
  const out = (line: string) => runtime.stdout.write(`${line}\n`);
  try {
    const outcome = await runSubcommand(ctx);
    if (outcome.sub === "status") {
      const data = outcome.data;
      if (!data.provider) {
        out(
          `${statusLabel("info", mode)} Topic names: off. The console shows each topic's words. Connect a model with: pathrule topics use <anthropic|openai|cloudflare|local>`,
        );
        return 0;
      }
      const ready = data.key !== "missing";
      out(
        `${statusLabel(ready ? "ok" : "warn", mode)} Topic names: ${safe(data.provider)} (${safe(data.model)})${ready ? "" : ", key missing"}`,
      );
      out(`  endpoint:  ${safe(data.endpoint)}`);
      out(
        `  key:       ${data.key === "not_needed" ? "not needed" : data.key === "set" ? "set (****, stored in topic-model-credentials.json, 0600)" : "missing"}`,
      );
      out(`  sends:     ${data.sends}`);
      return 0;
    }
    if (outcome.sub === "use") {
      const data = outcome.data;
      out(
        `${statusLabel("ok", mode)} Topic names: ${safe(data.provider)} (${safe(data.model)}), checked: it named a sample topic “${safe(data.sample)}”.`,
      );
      out(`  sends:     ${SENDS}, to ${safe(data.endpoint)}`);
      out("  The Local Console names topics the next time it shows them.");
      return 0;
    }
    out(
      `${statusLabel("ok", mode)} ${outcome.data.removed ? "Removed the topic model and its stored key." : "No topic model was saved."} The console shows each topic's words.`,
    );
    return 0;
  } catch (err) {
    const error = failure(err);
    runtime.stderr.write(`${statusLabel("error", mode)} ${safe(error.message)}\n`);
    return error.exitCode;
  }
}
