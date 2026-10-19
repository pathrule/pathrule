// SPDX-License-Identifier: Apache-2.0
// Navigation pages: tabs and chips, menus and popovers, the command palette.
import { Archive, Copy, Ellipsis, Pencil, Trash2, Users } from "lucide-react";
import { useState } from "react";
import {
  Breadcrumbs,
  Button,
  Checkbox,
  CommandPalette,
  FilterChip,
  Menu,
  Pagination,
  Popover,
  SegmentedControl,
  Tabs,
  Tooltip,
} from "../src/index.js";
import { Row, type Entry } from "./registry-entry.js";

function NavigationDemo() {
  const [tab, setTab] = useState("overview");
  const [segment, setSegment] = useState("all");
  const [chips, setChips] = useState(["verified"]);
  const [page, setPage] = useState(2);
  return (
    <div className="pr-stack pr-stack--5" style={{ width: "100%" }}>
      <Tabs
        label="Knowledge views"
        value={tab}
        onValueChange={setTab}
        items={[
          { value: "overview", label: "Overview" },
          { value: "revisions", label: "Revisions", count: 4 },
          { value: "evidence", label: "Evidence", count: 7 },
        ]}
      />
      <Row>
        <SegmentedControl
          label="Type"
          value={segment}
          onValueChange={setSegment}
          options={[
            { value: "all", label: "All" },
            { value: "memory", label: "Memories" },
            { value: "rule", label: "Rules" },
            { value: "skill", label: "Skills" },
          ]}
        />
      </Row>
      <Row>
        {["verified", "hypothesis", "retired"].map((chip) => (
          <FilterChip
            key={chip}
            selected={chips.includes(chip)}
            onSelectedChange={(on) =>
              setChips((c) => (on ? [...c, chip] : c.filter((x) => x !== chip)))
            }
            count={chip.length}
          >
            {chip}
          </FilterChip>
        ))}
      </Row>
      <Breadcrumbs
        items={[{ label: "acme" }, { label: "pathrule-web", href: "#" }, { label: "knowledge" }]}
      />
      <Pagination page={page} pageSize={25} total={312} onPageChange={setPage} />
    </div>
  );
}

function MenuDemo() {
  const [picked, setPicked] = useState("Pick an item. Disabled items explain why.");
  return (
    <Row>
      <Menu
        label="Knowledge actions"
        trigger={<Button trailingIcon={Ellipsis}>Actions</Button>}
        items={[
          {
            label: "Edit",
            icon: Pencil,
            shortcut: "E",
            onSelect: () => setPicked("Selected: Edit"),
          },
          {
            label: "Duplicate",
            icon: Copy,
            shortcut: "⌘ D",
            onSelect: () => setPicked("Selected: Duplicate"),
          },
          "separator",
          {
            label: "Publish to team",
            icon: Users,
            disabled: { reason: "Requires the Maintainer role" },
            onSelect: () => {},
          },
          { label: "Retire", icon: Archive, onSelect: () => setPicked("Selected: Retire") },
          "separator",
          {
            label: "Delete",
            icon: Trash2,
            tone: "danger",
            onSelect: () => setPicked("Selected: Delete"),
          },
        ]}
      />
      <Popover trigger={<Button>Filters</Button>} label="Filters">
        <div className="pr-stack pr-stack--2" style={{ width: 220 }}>
          <span className="pr-section-label">status</span>
          <Checkbox checked onCheckedChange={() => {}} label="Verified" />
          <Checkbox checked={false} onCheckedChange={() => {}} label="Hypothesis" />
        </div>
      </Popover>
      <Tooltip content="Tooltips open on hover after 400 ms and on focus at once">
        <Button variant="ghost">Hover or focus me</Button>
      </Tooltip>
      <span className="pr-note">{picked}</span>
    </Row>
  );
}

function CommandDemo() {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState("");
  const item = (id: string, title: string, hint?: string) => ({
    id,
    title,
    hint,
    onSelect: () => setPicked(title),
  });
  return (
    <Row>
      <Button onClick={() => setOpen(true)}>Open the palette</Button>
      <span className="pr-note">{picked ? `Selected: ${picked}` : "Try ↑ ↓ and ↵"}</span>
      <CommandPalette
        open={open}
        onOpenChange={setOpen}
        groups={[
          {
            heading: "Navigate",
            items: [
              item("o", "Overview", "G O"),
              item("s", "Signals", "G S"),
              item("k", "Knowledge", "G K"),
            ],
          },
          { heading: "Actions", items: [item("n", "New memory", "C"), item("i", "Invite member")] },
        ]}
      />
    </Row>
  );
}

export const NAVIGATION_ENTRIES: Entry[] = [
  {
    id: "navigation",
    category: "navigation",
    name: "Tabs, Segmented, Chips, Pagination",
    kind: "shared",
    imports: "Tabs, SegmentedControl, FilterChip, Breadcrumbs, Pagination",
    description:
      "Tabs switch views of one object; segmented switches a mode in place (the inverse pill); filter chips toggle independent facets.",
    a11y: "role=tablist with roving focus (arrows, Home, End); segmented is a radiogroup; chips use aria-pressed; the current page has aria-current.",
    render: () => <NavigationDemo />,
  },
  {
    id: "menu",
    category: "navigation",
    name: "Menu, Popover, Tooltip",
    kind: "shared",
    imports: "Menu, MenuRadio, Popover, Tooltip",
    description:
      "Row actions share one item anatomy: icon, label, shortcut. Disabled items stay visible with the reason; destructive items come last.",
    a11y: "role=menu with arrow keys, typeahead and Escape; focus returns to the trigger.",
    render: () => <MenuDemo />,
  },
  {
    id: "command",
    category: "navigation",
    name: "Command palette",
    kind: "shared",
    imports: "CommandPalette",
    description: "⌘K from anywhere: navigation and actions in one keyboard-first list.",
    a11y: "A dialog with a combobox and a listbox; Escape closes and restores focus.",
    render: () => <CommandDemo />,
  },
];
