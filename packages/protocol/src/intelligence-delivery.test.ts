// SPDX-License-Identifier: Apache-2.0
// The item versions every surface shares. The profile block's is the formula the host's compiled turn
// used before it moved here, so a conversation's known versions stay valid.
import { describe, expect, it } from "vitest";

import {
  intelligenceItemVersion,
  intelligenceSurface,
  userGuidanceItemVersion,
} from "./intelligence-delivery.js";
import { stableHash } from "./versioning.js";

describe("intelligence delivery vocabulary", () => {
  it("versions a profile block exactly as the host turn always did", () => {
    const block = "## Team and personal profiles (human-managed)\n- [high · testing] Write tests.";
    expect(intelligenceItemVersion("chat", block)).toBe(
      `intelligence:${stableHash({ surface: "chat", intelligenceBlock: block })}`,
    );
    expect(intelligenceItemVersion("tasks", block)).not.toBe(
      intelligenceItemVersion("chat", block),
    );
  });

  it("versions the person's guidance by its text", () => {
    expect(userGuidanceItemVersion("a")).toBe(userGuidanceItemVersion("a"));
    expect(userGuidanceItemVersion("a")).not.toBe(userGuidanceItemVersion("b"));
    expect(userGuidanceItemVersion("a").startsWith("user-guidance:")).toBe(true);
  });

  it("reads any surface but tasks as chat, as the provider does", () => {
    expect(intelligenceSurface("tasks")).toBe("tasks");
    expect(intelligenceSurface("chat")).toBe("chat");
    expect(intelligenceSurface(undefined)).toBe("chat");
    expect(intelligenceSurface("review")).toBe("chat");
  });
});
