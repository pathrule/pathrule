// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { observableLiterals } from "./observable-literals.js";
import { attributeUsage } from "./outcome.js";

describe("observableLiterals", () => {
  it("reads the inline code out of a quoted span", () => {
    expect(observableLiterals(["wrap the parse in `safeParse()`"])).toEqual(["safeParse("]);
    expect(observableLiterals(["run `pnpm natives:node` and retry"])).toEqual(["pnpm natives:node"]);
    expect(observableLiterals(["use `formatMoney` instead of `Intl.NumberFormat`"])).toEqual(["formatMoney", "Intl.NumberFormat"]);
  });

  it("keeps a span with no inline code as it is, and adds nothing the span did not name", () => {
    expect(observableLiterals(["safeFoo()"])).toEqual(["safeFoo("]);
    expect(observableLiterals(["review the design before building"])).toEqual(["review the design before building"]);
    expect(observableLiterals(["`a()`", "`a()`"])).toEqual(["a("]);
  });

  it("lets a quoted call be attributed when the agent passes arguments, and still requires insertion", () => {
    const delivered = [{ atom_id: "a", scope: "/apps/web", action_literals: observableLiterals(["`safeParse()`"]), variant: "trouble" as const, condition_literals: [] }];
    expect(attributeUsage(delivered, { kind: "edit", path: "/apps/web/x.ts", before: "parse(b)", after: "safeParse(b)" })[0]!.status).toBe("ATTRIBUTED");
    expect(attributeUsage(delivered, { kind: "edit", path: "/apps/web/x.ts", before: "safeParse(a)", after: "safeParse(a); safeParse(b)" })[0]!.status).toBe("POSSIBLE");
    expect(attributeUsage(delivered, { kind: "edit", path: "/apps/api/x.ts", before: "", after: "safeParse(b)" })[0]!.status).toBe("NOT_OBSERVED");
  });
});
