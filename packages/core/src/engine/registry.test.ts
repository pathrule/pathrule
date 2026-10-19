// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";

import { engine, installEngine, uninstallEngine } from "./registry.js";

afterEach(() => uninstallEngine());

describe("the engine slot", () => {
  it("is empty until a composition root installs an engine", () => {
    expect(engine()).toEqual({});
  });

  it("keeps the parts an install does not name", () => {
    const intentRouter = { route: async () => null, available: () => false };
    installEngine({ intentRouter });
    installEngine({});
    expect(engine().intentRouter).toBe(intentRouter);
  });
});
