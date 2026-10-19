// SPDX-License-Identifier: Apache-2.0
// Cloud query decomposition (2026-08-23) — the helper against a real HTTP server.
//
// What this pins. A prompt with two asks in it embeds as a BLEND that is close to
// neither ask. Measured on three deliberately two-part prompts before this change:
// "yetki alınmasına rağmen fonksiyon çağrılabiliyor + testler sürüm uyuşmazlığı
// veriyor" came back with ONE candidate and 5.385 of the 12.000-char budget spent,
// dropping nothing — the second memory was never a candidate at all. That is a RECALL
// failure, and neither the floor nor the budget fixes it: raising the budget from
// 12.000 to 16.000 left two-fact coverage at 67% both times.
//
// Querying per clause took two-fact coverage from 67% to 100% (TR) and 67% to 83% (EN)
// with single-fact coverage unchanged at 100%/100% and end-to-end latency flat
// (p50 2.045 → 2.126 ms), because the clause queries run concurrently.
//
// Why a real server and not a mocked fetch: the seam under test is the HTTP fan-out and
// the merge, so the assertions are about what requests actually leave and what one
// stdout payload comes back.

import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HELPER = join(dirname(fileURLToPath(import.meta.url)), "cloud-semantic-query.cjs");

interface Seen {
  intents: string[];
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

/**
 * @param reply called per request with the `userIntent` it carried; return the
 *   candidate list for that query, or `null` to answer 500 (a failing clause).
 */
async function startServer(
  reply: (intent: string) => Array<Record<string, unknown>> | null,
): Promise<{ url: string; seen: Seen }> {
  const seen: Seen = { intents: [] };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const intent = String(body.args?.[0]?.userIntent ?? "");
      seen.intents.push(intent);
      const candidates = reply(intent);
      if (candidates === null) {
        res.writeHead(500).end("nope");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ payload: { candidates, model: "test-model" } }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, seen };
}

function runHelper(url: string, prompt: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [HELPER],
      {
        env: {
          ...process.env,
          PATHRULE_CLOUD_SEMANTIC_URL: url,
          PATHRULE_CLOUD_SEMANTIC_TOKEN: "tok-test",
          PATHRULE_CLOUD_SEMANTIC_WORKSPACE: "11111111-1111-1111-1111-111111111111",
          PATHRULE_CLOUD_SEMANTIC_LIMIT: "8",
          PATHRULE_CLOUD_SEMANTIC_MIN_SIMILARITY: "0.4",
          PATHRULE_CLOUD_SEMANTIC_TIMEOUT_MS: "5000",
        },
        timeout: 15_000,
      },
      (error, stdout) => {
        resolve({ code: error && typeof error.code === "number" ? error.code : 0, stdout });
      },
    );
    child.stdin!.end(prompt);
  });
}

const cand = (id: string, similarity: number) => ({
  id,
  similarity,
  affinity_decayed_weight: 0,
  title: `Memory ${id}`,
  node_path: "/lib",
});

const TWO_ASKS =
  "A database function still runs for outside callers after I revoked execute from the anonymous role. " +
  "Separately the tests fail with a NODE_MODULE_VERSION mismatch on the native database module.";

describe("cloud query decomposition", () => {
  it("sends exactly one query for a single-ask prompt", async () => {
    const { url, seen } = await startServer(() => [cand("a", 0.6)]);
    const { code, stdout } = await runHelper(
      url,
      "A database function still runs for outside callers after I revoked execute from the anonymous role.",
    );
    expect(code).toBe(0);
    // One ask, one query: a single-topic prompt must behave exactly as it did before.
    expect(seen.intents).toHaveLength(1);
    expect(JSON.parse(stdout).candidates.map((c: { id: string }) => c.id)).toEqual(["a"]);
  });

  it("queries per clause and unions what each clause alone can find", async () => {
    // The shape of the measured failure: each memory is reachable from ITS OWN clause and
    // from neither the other clause nor the blend.
    const { url, seen } = await startServer((intent) => {
      if (intent === TWO_ASKS) return [cand("revoke", 0.52)]; // the blend finds only one
      if (intent.includes("anonymous role")) return [cand("revoke", 0.61)];
      if (intent.includes("NODE_MODULE_VERSION")) return [cand("sqlite", 0.58)];
      return [];
    });
    const { code, stdout } = await runHelper(url, TWO_ASKS);
    expect(code).toBe(0);
    expect(seen.intents).toHaveLength(3); // whole prompt + both clauses
    expect(seen.intents[0]).toBe(TWO_ASKS); // the whole prompt stays a first-class query
    const ids = JSON.parse(stdout).candidates.map((c: { id: string }) => c.id);
    // Without the fan-out this list is ["revoke"] and the second answer is simply absent.
    expect(new Set(ids)).toEqual(new Set(["revoke", "sqlite"]));
  });

  it("keeps the highest similarity when two queries return the same memory", async () => {
    // A clause that is a strong match must not have its score diluted by the blended
    // query that half-missed it — the merged score is what the hook ranks on.
    const { url } = await startServer((intent) =>
      intent === TWO_ASKS ? [cand("shared", 0.41)] : [cand("shared", 0.77)],
    );
    const { stdout } = await runHelper(url, TWO_ASKS);
    const parsed = JSON.parse(stdout);
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.candidates[0].similarity).toBeCloseTo(0.77, 5);
  });

  it("survives a clause query that fails outright", async () => {
    // Losing the whole call because one of three requests 500s would be strictly worse
    // than the blended query alone, which is still better than keyword overlap.
    const { url } = await startServer((intent) =>
      intent.includes("NODE_MODULE_VERSION") && intent !== TWO_ASKS ? null : [cand("revoke", 0.6)],
    );
    const { code, stdout } = await runHelper(url, TWO_ASKS);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).candidates.map((c: { id: string }) => c.id)).toEqual(["revoke"]);
  });

  it("reports 'nothing is relevant' as an empty list, never as an error", async () => {
    // The hook tells these two apart: an empty list is `cloud_below_threshold` and costs
    // nothing, while an error TRIPS THE BREAKER and drops the next 10 minutes of prompts
    // to keyword overlap. Collapsing them would make a quiet workspace look like an outage.
    const { url } = await startServer(() => []);
    const { code, stdout } = await runHelper(url, TWO_ASKS);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).candidates).toEqual([]);
  });
});
