// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { agentFacingClaim } from "./claim-referent.js";

describe("an agent never reads 'the user' as two people", () => {
  it("renames the person in the measured case, so 'the user' can only be the end users", () => {
    expect(agentFacingClaim("The user prefers to solve problems internally without showing errors to the user."))
      .toBe("This person prefers to solve problems internally without showing errors to the user.");
  });

  it("works on Pathrule's sentence, so it is the same whatever language the person wrote in", () => {
    // The claim is English for everyone; nothing here looks at the person's words.
    expect(agentFacingClaim("User prefers concise answers.")).toBe("This person prefers concise answers.");
    expect(agentFacingClaim("  the user wants the plan first.")).toBe("This person wants the plan first.");
  });

  it("leaves a claim with no subject, and every later 'user', alone", () => {
    expect(agentFacingClaim("Prefers incremental refactors over rewrites.")).toBe("Prefers incremental refactors over rewrites.");
    expect(agentFacingClaim("Prefers protecting user data.")).toBe("Prefers protecting user data.");
    expect(agentFacingClaim("Users first: prefers asking before deleting.")).toBe("Users first: prefers asking before deleting.");
  });
});
