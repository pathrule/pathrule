#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Hosted ranking helper for the hook's cloud extension (pathrule-hook-cloud.cjs), shipped next
// to the hook in ~/.pathrule/bin/. The extension spawns it (bounded, best-effort) with the
// endpoint stamped into hook-index.json and the caller's bearer token.
//
// SELF-CONTAINED like the hook: no node_modules.
//
// Contract: reads the prompt from stdin (utf8) and prints
//   {"candidates":[{"id","similarity","affinity","title","node_path"}],"model":"..."}
// to stdout on exit 0. On failure / timeout / empty input it exits non-zero and the hook
// ranks locally. Never throws to the parent beyond exit code.
//
// Exit codes: 0 ok · 1 cloud failure/timeout · 3 no endpoint or token · 4 empty prompt.

"use strict";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

// ---------------------------------------------------------------------------
// Pathrule Cloud. A signed-in account never supplies an embedding key -- ranking is part of
// what Pathrule provides -- so the hook hands this helper the endpoint stamped into
// hook-index.json, and the helper asks the workspace's Project backend for its semantic
// candidates (`/v1/workspaces/:ws/foundation/project/semanticCandidates`) with the native
// session's token (`nativeSessionToken`) unless the caller passes one. It returns RANKED
// CANDIDATES rather than a raw vector: the relevance floor and the limit apply server-side.
//
// Precedence is cloud FIRST, local key second: the hook asks this helper before its own
// BYO-key helper, so a cloud account cannot substitute its own provider key for ours.
function resolveCloudConfig(env) {
  const url = String(env.PATHRULE_CLOUD_SEMANTIC_URL || "").trim();
  const token =
    String(env.PATHRULE_CLOUD_SEMANTIC_TOKEN || "").trim() || (url ? nativeSessionToken(env, url) : "");
  const workspaceId = String(env.PATHRULE_CLOUD_SEMANTIC_WORKSPACE || "").trim();
  if (!url || !token || !workspaceId) return null;
  const rawLimit = Number(env.PATHRULE_CLOUD_SEMANTIC_LIMIT || "8");
  const rawFloor = Number(env.PATHRULE_CLOUD_SEMANTIC_MIN_SIMILARITY || "0.45");
  // The cloud call carries its own budget: it embeds AND searches, which takes longer than
  // a bare provider embedding, so one shared number would either starve this path or make
  // the local one wait for nothing.
  const rawTimeout = Number(
    env.PATHRULE_CLOUD_SEMANTIC_TIMEOUT_MS || env.PATHRULE_EMBEDDING_TIMEOUT_MS || "2600",
  );
  return {
    url: url.replace(/\/+$/, ""),
    token,
    workspaceId,
    rootPath: String(env.PATHRULE_CLOUD_SEMANTIC_ROOT_PATH || ""),
    limit: Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 50) : 8,
    minSimilarity: Number.isFinite(rawFloor) ? Math.min(Math.max(rawFloor, 0), 1) : 0.45,
    timeoutMs:
      Number.isFinite(rawTimeout) && rawTimeout > 0
        ? Math.min(Math.max(rawTimeout, 200), 10000)
        : 5000,
  };
}

// The Pathrule Cloud (native) session's bearer token, read at call time from
// <PATHRULE_HOME>/native-session.json. It goes only to the session's own origin, which must be the
// endpoint the index names; an expired session, or one inside its last 30s, is no token. The helper
// never refreshes it: the CLI and the editors do.
function nativeSessionToken(env, endpoint) {
  try {
    const home = String(env.PATHRULE_HOME || "").trim() || require("node:path").join(require("node:os").homedir(), ".pathrule");
    const session = JSON.parse(require("node:fs").readFileSync(require("node:path").join(home, "native-session.json"), "utf8"));
    if (!session || session.schema_version !== 1 || typeof session.token !== "string" || !session.token) return "";
    if (new URL(session.base_url).origin !== new URL(endpoint).origin) return "";
    if (!(Date.parse(session.expires_at) - Date.now() >= 30_000)) return "";
    return session.token;
  } catch {
    return "";
  }
}

// A prompt with two asks in it embeds as a BLEND that is close to neither ask, so the second
// ask's knowledge may never become a candidate at all. That is a RECALL failure, and no
// budget or floor fixes it.
//
// So query per clause and union the results. The whole prompt stays one of the queries, so
// a single-topic prompt behaves exactly as before; the clause queries only ADD reach. They
// run concurrently, which keeps the wall clock at roughly one call, and `limit` still caps
// what comes back, so the context cost is flat.
//
// Merge is by id keeping the HIGHEST similarity any query gave it: a clause that is a strong
// match for one memory must not have its score diluted by the blended query that missed it.
function splitQueries(text) {
  const whole = text.trim();
  const queries = [whole];
  // Sentence boundaries first; a two-ask prompt is usually two sentences.
  let parts = whole
    .split(/(?<=[.!?])\s+|\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 25);
  // One long sentence carrying two asks: fall back to the conjunctions that join them,
  // in Turkish ("ayrıca", "bir de") and English ("and separately", "plus").
  if (parts.length < 2) {
    parts = whole
      .split(/;|,\s*(?:ayrıca|bir de|ve ayrıca)\s+|\s+(?:and separately|and also|plus)\s+/i)
      .map((p) => p.trim())
      .filter((p) => p.length >= 25);
  }
  if (parts.length < 2 && whole.length >= 120) {
    // Bare coordinating conjunction, fenced the same way as in pathrule-hook.js: only for a
    // long prompt with a substantial clause on each side. See the note there.
    parts = whole
      .split(/,\s+(?:and|ve|ayrıca|bir de)\s+/i)
      .map((p) => p.trim())
      .filter((p) => p.length >= 40);
  }
  if (parts.length < 2) return queries; // genuinely one ask -- one query, as before
  // Cap at 2 extra queries: three concurrent calls is the point where the tail latency of
  // the slowest starts to matter more than the recall the third one adds.
  for (const part of parts.slice(0, 2)) if (part !== whole) queries.push(part);
  return queries;
}

async function cloudQuery(text, config, signal) {
  const queries = splitQueries(text);
  if (queries.length === 1) return cloudQueryOne(queries[0], config, signal);
  const results = await Promise.all(
    queries.map((q) =>
      // A failing clause query must not lose the whole call: the blended query alone is
      // still strictly better than falling back to keyword overlap.
      cloudQueryOne(q, config, signal).catch(() => ({ candidates: [], model: "" })),
    ),
  );
  if (results.every((r) => r.candidates.length === 0)) {
    // Every query agreed nothing is relevant. That is a verdict, and it must stay
    // distinguishable from an error, so return it as an empty list rather than throw.
    return { candidates: [], model: results[0].model };
  }
  const best = new Map();
  for (const r of results) {
    for (const c of r.candidates) {
      const prev = best.get(c.id);
      if (!prev || c.similarity > prev.similarity) best.set(c.id, c);
    }
  }
  const candidates = [...best.values()]
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, config.limit);
  return { candidates, model: results.find((r) => r.model)?.model ?? "" };
}

// Pathrule Cloud's Project backend: the same candidates, floor and limit, over its own index.
async function nativeQueryOne(text, config, signal) {
  const ws = encodeURIComponent(config.workspaceId);
  const res = await fetch(`${config.url}/v1/workspaces/${ws}/foundation/project/semanticCandidates`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
    body: JSON.stringify({
      args: [
        {
          workspaceId: config.workspaceId,
          userIntent: text.slice(0, 1024),
          matchedNodePath: config.rootPath || "/",
          limit: config.limit,
          minSimilarity: config.minSimilarity,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`cloud_http_${res.status}`);
  const json = await res.json();
  if (!json || typeof json !== "object") throw new Error("cloud_bad_payload");
  // No payload is the server's own "nothing to rank" (unconfigured, no candidates), not an error.
  const payload = json.payload;
  if (payload !== undefined && (!payload || !Array.isArray(payload.candidates))) {
    throw new Error("cloud_bad_payload");
  }
  const candidates = (payload ? payload.candidates : [])
    .filter((c) => c && typeof c.id === "string" && typeof c.similarity === "number")
    .map((c) => ({
      id: c.id,
      similarity: c.similarity,
      affinity: 0,
      title: typeof c.title === "string" ? c.title : "",
      node_path: typeof c.node_path === "string" ? c.node_path : "",
    }));
  return { candidates, model: payload && typeof payload.model === "string" ? payload.model : "" };
}

async function cloudQueryOne(text, config, signal) {
  return nativeQueryOne(text, config, signal);
}

async function main() {
  const cloud = resolveCloudConfig(process.env);
  // No endpoint or token: exit 3 so the hook ranks locally.
  if (!cloud) process.exit(3);

  const prompt = (await readStdin()).trim();
  if (prompt.length === 0) process.exit(4);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cloud.timeoutMs);
  try {
    const result = await cloudQuery(prompt, cloud, controller.signal);
    process.stdout.write(JSON.stringify(result));
    process.exit(0);
  } catch {
    process.exit(1); // cloud failure, timeout, or bad payload
  } finally {
    clearTimeout(timer);
  }
}

main().catch(() => process.exit(1));
