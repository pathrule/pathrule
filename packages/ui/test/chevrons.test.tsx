// SPDX-License-Identifier: Apache-2.0
// Selects and disclosures turn with an icon, never a drawn triangle or the browser's marker; a meter can
// say what its numbers mean instead of a percentage.
import { afterEach, describe, expect, it } from "vitest";
import { Disclosure } from "../src/components/disclosure.js";
import { Select } from "../src/components/forms.js";
import { Meter } from "../src/components/spinner.js";
import { cleanup, render } from "./render.js";

afterEach(cleanup);

describe("chevrons", () => {
  it("draws the select's chevron as an icon", () => {
    const { container } = render(
      <Select
        aria-label="Sort"
        options={[
          { value: "edited", label: "Last edited" },
          { value: "title", label: "Title" },
        ]}
      />,
    );
    const chevron = container.querySelector(".pr-select-wrap__chevron")!;
    expect(chevron.querySelector("svg")).not.toBeNull();
    expect(chevron.textContent).toBe("");
  });

  it("opens a disclosure with an icon chevron, and keeps native details", () => {
    const { container } = render(<Disclosure summary="Show the stack">trace</Disclosure>);
    const details = container.querySelector("details.pr-disclosure")!;
    expect(details.querySelector("summary svg.pr-disclosure__icon")).not.toBeNull();
    expect(details.querySelector("summary")?.textContent).toBe("Show the stack");
  });
});

describe("Meter", () => {
  it("says its own detail under the bar in place of the percentage", () => {
    const { container } = render(
      <Meter
        label="Seats"
        value={1}
        max={1}
        detail="Granted by Pathrule"
        thresholds={{ warn: 101, danger: 101 }}
      />,
    );
    expect(container.querySelector(".pr-meter__note")?.textContent).toBe("Granted by Pathrule");
    expect(container.querySelector(".pr-progress--accent")).not.toBeNull();
  });
});
