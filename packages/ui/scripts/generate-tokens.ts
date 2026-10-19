// SPDX-License-Identifier: Apache-2.0
// Writes src/styles/tokens.css from src/tokens/tokens.ts. A test fails when they drift.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderTokensCss } from "../src/tokens/css.js";

const target = fileURLToPath(new URL("../src/styles/tokens.css", import.meta.url));
writeFileSync(target, renderTokensCss());
console.log(`wrote ${target}`);
