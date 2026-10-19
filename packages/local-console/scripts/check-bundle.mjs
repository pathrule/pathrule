#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Gate on the built Local Console: it must be self-contained (no request leaves 127.0.0.1),
// carry the style-nonce placeholder `pathrule ui` fills in, ship no source map, carry the licence
// notices of what it inlines, and stay within its size budget.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname: on Windows the pathname is `/D:/...`, which is no path at all.
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const BUDGET = { jsGzipKb: 450, cssGzipKb: 80, totalKb: 2500 };
const failures = [];

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else files.push(full);
  }
})(dist);

const html = readFileSync(join(dist, "index.html"), "utf8");
if (!html.includes('content="__PR_STYLE_NONCE__"'))
  failures.push("index.html lost the style nonce placeholder");
if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html))
  failures.push("index.html has an inline script; the CSP allows only same-origin script files");
if (/<style[\s>]/i.test(html))
  failures.push("index.html has an inline <style>; the CSP allows only same-origin style files");

// The CLI package carries this folder as it is: the notices the build writes travel with it.
if (!existsSync(join(dist, "THIRD_PARTY_NOTICES.md")))
  failures.push("THIRD_PARTY_NOTICES.md is missing (vite.config.ts writes it)");

let jsGzip = 0;
let cssGzip = 0;
let total = 0;
for (const file of files) {
  const bytes = readFileSync(file);
  total += bytes.length;
  if (file.endsWith(".js")) jsGzip += gzipSync(bytes).length;
  if (file.endsWith(".css")) cssGzip += gzipSync(bytes).length;
  // Source maps would publish the sources' layout and comments with every install.
  if (file.endsWith(".map")) failures.push(`${file.slice(dist.length)} is a source map`);
  if (/\.(js|css|html)$/.test(file)) {
    const text = bytes.toString("utf8");
    // Any absolute http(s) URL the page could fetch from. Links a person clicks are allowed.
    for (const match of text.matchAll(/\b(?:fetch|import|url)\(\s*["'`](https?:\/\/[^"'`]+)/g)) {
      failures.push(`${file.slice(dist.length)} requests ${match[1]}`);
    }
    if (/[#@]\s*sourceMappingURL=/.test(text))
      failures.push(`${file.slice(dist.length)} points at a source map`);
    if (/fonts\.googleapis|unpkg\.com|cdn\.jsdelivr|cdnjs\./.test(text))
      failures.push(`${file.slice(dist.length)} references a CDN`);
  }
}
const kb = (n) => Math.round((n / 1024) * 10) / 10;
if (kb(jsGzip) > BUDGET.jsGzipKb)
  failures.push(`JS is ${kb(jsGzip)} KB gzip, budget ${BUDGET.jsGzipKb}`);
if (kb(cssGzip) > BUDGET.cssGzipKb)
  failures.push(`CSS is ${kb(cssGzip)} KB gzip, budget ${BUDGET.cssGzipKb}`);
if (kb(total) > BUDGET.totalKb) failures.push(`dist is ${kb(total)} KB, budget ${BUDGET.totalKb}`);

console.log(
  `local-console bundle: js ${kb(jsGzip)} KB gzip, css ${kb(cssGzip)} KB gzip, total ${kb(total)} KB`,
);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
