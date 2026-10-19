// SPDX-License-Identifier: Apache-2.0
// Terminal output for setup: what setup did with the project's instruction files.

import type { Writable } from "node:stream";
import type { InitLocalResult } from "./local/init-local.js";
import { statusLabel, type CliOutputMode } from "./output.js";

type Out = Pick<Writable, "write">;

/** What `init --local` / `setup --local` did with the project's instruction files. */
export function renderLocalInstructions(
  instructions: InitLocalResult["instructions"],
  stdout: Out,
  mode: CliOutputMode,
): void {
  if (!instructions) return;
  renderInstructionImport(
    instructions.imported,
    instructions.notImported,
    "pathrule setup --local --import-instructions",
    stdout,
    mode,
  );
  if (instructions.failed > 0) {
    stdout.write(
      `${statusLabel("warn", mode)} ${instructions.failed} sections could not be imported.\n`,
    );
  }
  if (instructions.skipped?.length) {
    stdout.write(
      `${statusLabel("info", mode)} Skipped ${instructions.skipped.length} file${instructions.skipped.length === 1 ? "" : "s"} Pathrule wrote or whose origin is uncertain.\n`,
    );
  }
}

/** The same words for an account and a local workspace; only the command differs. */
export function renderInstructionImport(
  imported: number,
  notImported: readonly string[],
  importCommand: string,
  stdout: Out,
  mode: CliOutputMode,
): void {
  if (imported > 0) {
    stdout.write(
      `${statusLabel("ok", mode)} Imported ${imported} sections from your existing instruction files.\n`,
    );
  }
  if (notImported.length > 0) {
    stdout.write(
      `${statusLabel("info", mode)} Not in Pathrule yet: ${notImported.join(", ")}. Import them with: ${importCommand}\n`,
    );
  }
}
