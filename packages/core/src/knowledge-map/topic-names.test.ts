// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";

import {
  cleanTopicName,
  createTopicNamer,
  mergeTopicNames,
  parseTopicNames,
  topicName,
  topicNamePrompt,
  topicsToName,
  type TopicNameRequest,
} from "./topic-names.js";

const deploy: TopicNameRequest = {
  id: "rg_1",
  terms: ["deploy", "release", "worktree"],
  homePath: "/",
  titles: ["Release every channel in order", "Verify a commit in a worktree"],
};
const billing: TopicNameRequest = {
  id: "rg_2",
  terms: ["stripe", "webhook", "plan"],
  homePath: "/apps/api",
  titles: ["Live Stripe billing", "Plan changes go through the portal"],
};

describe("topic names", () => {
  it("are cut to one safe line", () => {
    expect(cleanTopicName("  “Release &\n deploy”. ")).toBe("Release & deploy");
    expect(cleanTopicName("x".repeat(80))).toHaveLength(48);
    expect(cleanTopicName("\u0000\u0007")).toBeNull();
    expect(cleanTopicName(42)).toBeNull();
  });

  it("come only for the asked ids, from the JSON in an answer", () => {
    const text =
      'Sure! {"rg_1": "Release & deploy", "rg_9": "Not asked", "rg_2": ""} Hope it helps.';
    expect(parseTopicNames(text, new Set(["rg_1", "rg_2"]))).toEqual({ rg_1: "Release & deploy" });
    expect(parseTopicNames("no json here", new Set(["rg_1"]))).toEqual({});
    expect(parseTopicNames('{"rg_1": ["a"]}', new Set(["rg_1"]))).toEqual({});
    // An answer cut at the token limit keeps the pairs it finished.
    expect(
      parseTopicNames(
        '```json\n{ "t1": "Release & deploy", "t2": "Billing web',
        new Set(["t1", "t2"]),
      ),
    ).toEqual({ t1: "Release & deploy" });
  });

  it("are asked again only for new regions, changed terms or another model", () => {
    const cache = mergeTopicNames(
      {},
      [deploy, billing],
      { rg_1: "Release & deploy" },
      "anthropic/m",
    );
    expect(topicsToName([deploy, billing], cache, "anthropic/m").map((t) => t.id)).toEqual([
      "rg_2",
    ]);
    expect(topicsToName([deploy], cache, "openai/x").map((t) => t.id)).toEqual(["rg_1"]);
    const moved = { ...deploy, terms: ["deploy", "release", "staging"] };
    expect(topicsToName([moved], cache, "anthropic/m")).toHaveLength(1);
    expect(topicName(moved, cache)).toBeNull();
    expect(topicName(deploy, cache)).toBe("Release & deploy");
    // A region that is gone leaves the cache with the next merge.
    expect(Object.keys(mergeTopicNames(cache, [billing], {}, "anthropic/m"))).toEqual([]);
  });

  it("send words, folder and titles, never a body", () => {
    const prompt = JSON.parse(topicNamePrompt([deploy])) as Array<Record<string, unknown>>;
    expect(prompt).toEqual([
      { id: "rg_1", words: deploy.terms, folder: "/", titles: deploy.titles },
    ]);
  });
});

function answering(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe("the providers", () => {
  it("ask Claude with the key in its header", async () => {
    const fetchImpl = answering({
      content: [{ type: "text", text: '{"t1":"Release & deploy","t2":"Billing webhooks"}' }],
      stop_reason: "end_turn",
    });
    const namer = createTopicNamer(
      { provider: "anthropic", model: "claude-test", apiKey: "sk-ant" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(namer.model).toBe("anthropic/claude-test");
    // The model sees short aliases; the names come back under the regions' real ids.
    expect(await namer.name([deploy, billing])).toEqual({
      rg_1: "Release & deploy",
      rg_2: "Billing webhooks",
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("claude-test");
    // No thinking: a model that thinks by default would spend the answer on it.
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.max_tokens).toBeGreaterThanOrEqual(2048);
    expect(
      (JSON.parse(body.messages[0].content) as Array<{ id: string }>).map((t) => t.id),
    ).toEqual(["t1", "t2"]);
  });

  it("say when the model ran out of room before naming anything", async () => {
    const cut = createTopicNamer(
      { provider: "anthropic", model: "m", apiKey: "k" },
      answering({
        content: [{ type: "thinking", thinking: "…" }],
        stop_reason: "max_tokens",
      }) as unknown as typeof fetch,
    );
    await expect(cut.name([deploy])).rejects.toThrow("reached its answer limit");
  });

  it("ask a local OpenAI-compatible server without a key", async () => {
    const fetchImpl = answering({
      choices: [{ message: { content: '{"t1":"Yayın ve dağıtım"}' } }],
    });
    const namer = createTopicNamer(
      { provider: "local", model: "llama3.2" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(await namer.name([deploy])).toEqual({ rg_1: "Yayın ve dağıtım" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("ask Workers AI on the account it names", async () => {
    const fetchImpl = answering({ result: { response: '{"t1":"Billing"}' } });
    const namer = createTopicNamer(
      { provider: "cloudflare", model: "@cf/x/y", apiKey: "cf", accountId: "acc" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(await namer.name([billing])).toEqual({ rg_2: "Billing" });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/x/y",
    );
  });

  it("fail without echoing the provider's answer, and on an answer with no names", async () => {
    const refused = createTopicNamer(
      { provider: "openai", model: "m", apiKey: "k" },
      answering({ error: "your prompt was: secret" }, 401) as unknown as typeof fetch,
    );
    await expect(refused.name([deploy])).rejects.toThrow("The model answered HTTP 401.");
    const empty = createTopicNamer(
      { provider: "openai", model: "m", apiKey: "k" },
      answering({
        choices: [{ message: { content: "I cannot help" } }],
      }) as unknown as typeof fetch,
    );
    await expect(empty.name([deploy])).rejects.toThrow("held no names");
    await expect(
      createTopicNamer({ provider: "anthropic", model: "m" }).name([deploy]),
    ).rejects.toThrow("API key");
  });
});
