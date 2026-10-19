// SPDX-License-Identifier: Apache-2.0
// normalize_workspace_path fixture-driven tests.
// Every case in the fixture corpus must pass.
import { describe, it, expect } from "vitest";
import { normalize_workspace_path } from "./normalize-workspace-path.js";
import { FIXTURES } from "./__fixtures__/normalize-workspace-path.fixtures.js";

describe("normalize_workspace_path", () => {
  for (const fixture of FIXTURES) {
    it(fixture.label, () => {
      const result = normalize_workspace_path(fixture.input);
      expect(result).toEqual(fixture.expected);
    });
  }
});
