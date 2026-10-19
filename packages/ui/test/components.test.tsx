// SPDX-License-Identifier: Apache-2.0
import { Archive } from "lucide-react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, IconButton } from "../src/components/button.js";
import {
  Checkbox,
  Combobox,
  FormField,
  SearchInput,
  Switch,
  TextInput,
} from "../src/components/forms.js";
import { SegmentedControl, Tabs } from "../src/components/navigation.js";
import { DataTable, RowTitle, type SortState } from "../src/components/table.js";
import { Meter, Progress } from "../src/components/spinner.js";
import { byRole, cleanup, click, key, render, type } from "./render.js";

afterEach(cleanup);

describe("Button", () => {
  it("is a native button that keeps its label and sets aria-busy while loading", () => {
    const onClick = vi.fn();
    const { container } = render(
      <Button loading onClick={onClick}>
        Publish to team
      </Button>,
    );
    const button = container.querySelector("button")!;
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent).toContain("Publish to team");
    click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("explains a permission-disabled state and stays focusable", () => {
    const onClick = vi.fn();
    const { container } = render(
      <Button disabled={{ reason: "Requires Maintainer role" }} onClick={onClick}>
        Publish
      </Button>,
    );
    const button = container.querySelector("button")!;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("icon buttons require a label that becomes the accessible name", () => {
    const { container } = render(<IconButton icon={Archive} label="Archive workspace" />);
    expect(byRole(container, "button", "Archive workspace")).toHaveLength(1);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("FormField", () => {
  it("wires the label, the message and aria-invalid to the control", () => {
    const { container } = render(
      <FormField label="Workspace name" error="Use 3 to 40 lowercase letters." required>
        <TextInput defaultValue="Bad Name" />
      </FormField>,
    );
    const input = container.querySelector("input")!;
    const label = container.querySelector("label")!;
    expect(label.getAttribute("for")).toBe(input.id);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-required")).toBe("true");
    const described = input.getAttribute("aria-describedby")!;
    expect(document.getElementById(described)?.textContent).toBe("Use 3 to 40 lowercase letters.");
  });

  it("reserves the message slot so validation never shifts layout", () => {
    const { container } = render(
      <FormField label="Name">
        <TextInput />
      </FormField>,
    );
    expect(container.querySelectorAll(".pr-field__message")).toHaveLength(1);
  });
});

describe("selection controls", () => {
  it("checkbox exposes the indeterminate state as mixed", () => {
    const { container } = render(
      <Checkbox checked="indeterminate" onCheckedChange={() => {}} label="All" />,
    );
    const input = container.querySelector("input")!;
    expect(input.indeterminate).toBe(true);
    expect(input.getAttribute("aria-checked")).toBe("mixed");
  });

  it("a locked switch says why and never toggles", () => {
    const onChange = vi.fn();
    const { container } = render(
      <Switch
        checked={false}
        onCheckedChange={onChange}
        label="Product telemetry"
        locked={{ reason: "Managed by organization policy" }}
      />,
    );
    const sw = container.querySelector('[role="switch"]')!;
    expect(sw.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(sw.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Managed by organization policy",
    );
    click(sw);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("search clear button empties the value and returns focus to the input", () => {
    function Harness() {
      const [value, setValue] = useState("graphql");
      return <SearchInput value={value} onValueChange={setValue} aria-label="Search knowledge" />;
    }
    const { container } = render(<Harness />);
    click(byRole(container, "button", "Clear search")[0]!);
    const input = container.querySelector("input")!;
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
  });

  it("combobox moves aria-activedescendant with arrows and selects with Enter", () => {
    const onChange = vi.fn();
    const { container } = render(
      <Combobox
        ariaLabel="Owner path"
        value=""
        onValueChange={onChange}
        options={[
          { value: "/src/", label: "/src/" },
          { value: "/src/api/", label: "/src/api/" },
        ]}
      />,
    );
    const input = container.querySelector('[role="combobox"]') as HTMLInputElement;
    type(input, "api");
    key(input, "ArrowDown");
    expect(input.getAttribute("aria-activedescendant")).toMatch(/opt-0$/);
    key(input, "Enter");
    expect(onChange).toHaveBeenCalledWith("/src/api/");
  });
});

describe("navigation", () => {
  it("tabs use roving focus: arrows move selection, Home and End jump", () => {
    function Harness() {
      const [value, setValue] = useState("overview");
      return (
        <Tabs
          label="Knowledge views"
          value={value}
          onValueChange={setValue}
          items={[
            { value: "overview", label: "Overview" },
            { value: "revisions", label: "Revisions", count: 4 },
            { value: "evidence", label: "Evidence" },
          ]}
        />
      );
    }
    const { container } = render(<Harness />);
    const tabs = () => byRole(container, "tab");
    expect(tabs().map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    key(tabs()[0]!, "ArrowRight");
    expect(tabs()[1]!.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs()[1]);
    key(tabs()[1]!, "End");
    expect(tabs()[2]!.getAttribute("aria-selected")).toBe("true");
    key(tabs()[2]!, "ArrowRight");
    expect(tabs()[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("segmented control is a radiogroup", () => {
    const onChange = vi.fn();
    const { container } = render(
      <SegmentedControl
        label="Type"
        value="all"
        onValueChange={onChange}
        options={[
          { value: "all", label: "All" },
          { value: "rule", label: "Rules" },
        ]}
      />,
    );
    expect(container.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe("Type");
    key(byRole(container, "radio")[0]!, "ArrowRight");
    expect(onChange).toHaveBeenCalledWith("rule");
  });
});

describe("DataTable", () => {
  interface Row {
    id: string;
    title: string;
    n: number;
  }
  const rows: Row[] = [
    { id: "a", title: "Use the api client", n: 3 },
    { id: "b", title: "React Query for data", n: 1 },
  ];

  it("sortable headers are buttons with aria-sort, and selection replaces the header with a bulk bar", () => {
    const onOpen = vi.fn();
    function Harness() {
      const [sort, setSort] = useState<SortState<"title" | "n"> | null>(null);
      const [selected, setSelected] = useState(new Set<string>());
      return (
        <DataTable<Row, "title" | "n">
          caption="Knowledge"
          rows={rows}
          rowKey={(r) => r.id}
          sort={sort}
          onSortChange={setSort}
          selectable
          selected={selected}
          onSelectedChange={setSelected}
          bulkActions={() => <button type="button">Retire</button>}
          onRowClick={onOpen}
          columns={[
            {
              key: "title",
              header: "Title",
              sortable: true,
              render: (r) => <RowTitle onOpen={() => onOpen(r)}>{r.title}</RowTitle>,
            },
            { key: "n", header: "Delivered", sortable: true, align: "end", render: (r) => r.n },
          ]}
        />
      );
    }
    const { container } = render(<Harness />);
    const header = () => container.querySelector("th[aria-sort]")!;
    expect(header().getAttribute("aria-sort")).toBe("none");
    click(header().querySelector("button"));
    expect(header().getAttribute("aria-sort")).toBe("ascending");
    click(header().querySelector("button"));
    expect(header().getAttribute("aria-sort")).toBe("descending");

    click(byRole(container, "checkbox", "Select row")[0]!);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("1 selected");
    expect(byRole(container, "button", "Retire")).toHaveLength(1);
    expect(onOpen).not.toHaveBeenCalled();

    click(byRole(container, "button", "Use the api client")[0]!);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("labels data cells for the card layout, and marks the actions cell instead of labelling it", () => {
    const { container } = render(
      <DataTable<Row>
        caption="Knowledge"
        rows={rows.slice(0, 1)}
        rowKey={(r) => r.id}
        columns={[
          { key: "title", header: "Title", render: (r) => r.title },
          { key: "n", header: "Delivered", render: (r) => r.n },
          {
            key: "actions",
            header: <span className="pr-sr-only">Actions</span>,
            label: "Actions",
            actions: true,
            render: () => <button type="button">More</button>,
          },
        ]}
      />,
    );
    const cells = [...container.querySelectorAll("tbody td")];
    expect(cells.map((td) => td.getAttribute("data-label"))).toEqual(["Title", "Delivered", null]);
    expect(cells[2]!.classList.contains("pr-table__cell--actions")).toBe(true);
    expect(cells[1]!.classList.contains("pr-table__cell--actions")).toBe(false);
  });

  it("renders the empty slot, not an empty table, when there are no rows", () => {
    const { container } = render(
      <DataTable<Row>
        caption="Knowledge"
        rows={[]}
        rowKey={(r) => r.id}
        empty={<p>No knowledge yet</p>}
        columns={[{ key: "t", header: "Title", render: (r) => r.title }]}
      />,
    );
    expect(container.textContent).toContain("No knowledge yet");
  });
});

describe("progress", () => {
  it("indeterminate progress shows no value", () => {
    const { container } = render(<Progress label="Importing" />);
    const bar = container.querySelector('[role="progressbar"]')!;
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
  });

  it("meters state the numbers in text and change tone at thresholds", () => {
    const { container } = render(<Meter label="Seats" value={9} max={10} />);
    expect(container.querySelector('[role="meter"]')?.getAttribute("aria-valuetext")).toBe(
      "9 of 10",
    );
    expect(container.textContent).toContain("approaching limit");
  });

  it("a meter for a resource that is not included says so rather than inventing a limit", () => {
    const { container } = render(<Meter label="Runtime events" value={0} max={null} />);
    expect(container.textContent).toContain("not included");
  });

  it("an unlimited meter keeps the meter's shape, says Unlimited and claims no maximum", () => {
    const { container } = render(<Meter label="Workspaces" value={4} max="unlimited" />);
    expect(container.querySelector(".pr-meter__head")?.textContent).toBe("Workspaces4");
    expect(container.querySelector(".pr-progress--unlimited")?.getAttribute("aria-label")).toBe(
      "Workspaces: 4 used, unlimited",
    );
    expect(container.querySelector('[role="meter"]')).toBeNull();
    expect(container.querySelector(".pr-meter__note")?.textContent).toBe("Unlimited");
  });
});
