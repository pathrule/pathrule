// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { isArchivedKnowledgePath } from "./knowledge-archive.js";

describe("isArchivedKnowledgePath", () => {
  it("marks every node under an `_archive` segment, top-level or nested", () => {
    expect(isArchivedKnowledgePath("/_archive")).toBe(true);
    expect(isArchivedKnowledgePath("/_archive/studio")).toBe(true);
    expect(isArchivedKnowledgePath("/_archive/reels/clips")).toBe(true);
    expect(isArchivedKnowledgePath("/packages/web/_archive")).toBe(true);
  });

  it("leaves live paths, look-alike names and missing paths alone", () => {
    for (const path of ["/", "", "/packages/archive", "/_archived", "/docs/archive", null, undefined]) {
      expect(isArchivedKnowledgePath(path)).toBe(false);
    }
  });
});
