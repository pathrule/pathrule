// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import type { InitLocalResult } from "./local/init-local.js";
import type { CliOutputMode } from "./output.js";
import { renderLocalInstructions } from "./setup-render.js";

const plain: CliOutputMode = { json: false, color: false, interactive: false };

function render(instructions: InitLocalResult["instructions"]): string[] {
  const lines: string[] = [];
  renderLocalInstructions(instructions, { write: (chunk: string) => lines.push(chunk) > 0 }, plain);
  return lines.map((line) => line.trim());
}

describe("local instruction import output", () => {
  it("says what was imported and points at the local command for the rest", () => {
    const lines = render({
      imported: 3,
      failed: 1,
      inPathrule: ["CLAUDE.md"],
      notImported: ["AGENTS.md"],
    });
    expect(
      lines.some((l) => l.endsWith("Imported 3 sections from your existing instruction files.")),
    ).toBe(true);
    expect(
      lines.some((l) =>
        l.endsWith(
          "Not in Pathrule yet: AGENTS.md. Import them with: pathrule setup --local --import-instructions",
        ),
      ),
    ).toBe(true);
    expect(lines.some((l) => l.endsWith("1 sections could not be imported."))).toBe(true);
  });

  it("prints nothing for a folder without instruction files or with nothing new", () => {
    expect(render(null)).toEqual([]);
    expect(render({ imported: 0, failed: 0, inPathrule: ["CLAUDE.md"], notImported: [] })).toEqual(
      [],
    );
  });
});
