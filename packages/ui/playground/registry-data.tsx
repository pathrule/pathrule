// SPDX-License-Identifier: Apache-2.0
// Data pages: badges, status and metrics, the data table, untrusted runtime text.
import { Archive } from "lucide-react";
import { useState } from "react";
import {
  Avatar,
  Badge,
  Button,
  DataTable,
  MetricCard,
  RowTitle,
  SegmentedControl,
  StateMessage,
  StatusIndicator,
  Timeline,
  UntrustedText,
  type SortState,
} from "../src/index.js";
import { Row, type Entry } from "./registry-entry.js";

function TableDemo() {
  interface Item {
    id: string;
    title: string;
    path: string;
    delivered: number;
  }
  const rows: Item[] = [
    { id: "1", title: "Use the api client, not fetch", path: "/src/features", delivered: 1284 },
    {
      id: "2",
      title: "Data loading goes through React Query",
      path: "/src/features",
      delivered: 1102,
    },
    { id: "3", title: "No new REST routes", path: "/src/api", delivered: 640 },
    { id: "4", title: "Release checklist", path: "/", delivered: 58 },
  ];
  const [sort, setSort] = useState<SortState<"title" | "delivered"> | null>({
    key: "delivered",
    direction: "descending",
  });
  const [selected, setSelected] = useState(new Set<string>());
  const [state, setState] = useState<"data" | "loading" | "empty">("data");
  const sorted = [...rows].sort((a, b) => {
    if (!sort) return 0;
    const d = sort.direction === "ascending" ? 1 : -1;
    return sort.key === "title"
      ? a.title.localeCompare(b.title) * d
      : (a.delivered - b.delivered) * d;
  });
  return (
    <div className="pr-stack pr-stack--3" style={{ width: "100%" }}>
      <SegmentedControl
        label="Table state"
        size="sm"
        value={state}
        onValueChange={setState}
        options={[
          { value: "data", label: "Rows" },
          { value: "loading", label: "Loading" },
          { value: "empty", label: "Empty" },
        ]}
      />
      <DataTable<Item, "title" | "delivered">
        caption="Knowledge"
        rows={state === "empty" ? [] : sorted}
        loading={state === "loading"}
        rowKey={(r) => r.id}
        sort={sort}
        onSortChange={setSort}
        selectable
        selected={selected}
        onSelectedChange={setSelected}
        bulkActions={() => (
          <Button size="sm" leadingIcon={Archive} onClick={() => setSelected(new Set())}>
            Retire
          </Button>
        )}
        onRowClick={() => {}}
        empty={
          <StateMessage
            compact
            title="No knowledge yet"
            description="Agents propose knowledge from corrections."
          />
        }
        columns={[
          {
            key: "title",
            header: "Title",
            sortable: true,
            render: (r) => <RowTitle onOpen={() => {}}>{r.title}</RowTitle>,
          },
          {
            key: "path" as "title",
            header: "Owner path",
            hideOnMobile: true,
            render: (r) => <span className="pr-mono pr-meta">{r.path}</span>,
          },
          {
            key: "delivered",
            header: "Delivered",
            sortable: true,
            align: "end",
            render: (r) => (
              <span className="pr-tabular">{r.delivered.toLocaleString("en-US")}</span>
            ),
          },
        ]}
      />
    </div>
  );
}

export const DATA_ENTRIES: Entry[] = [
  {
    id: "data",
    category: "data",
    name: "Badge, Status, Avatar, Metric",
    kind: "shared",
    imports: "Badge, StatusIndicator, Avatar, MetricCard, KeyValueList, Timeline",
    description:
      "Badges label. Status indicators report live state; the dot pulses only while something is happening. People are round, agents square.",
    render: () => (
      <div className="pr-stack pr-stack--4" style={{ width: "100%" }}>
        <Row>
          <Badge tone="accent">verified</Badge>
          <Badge tone="warning">hypothesis</Badge>
          <Badge tone="danger">recurred</Badge>
          <Badge tone="info">observing</Badge>
          <Badge variant="outline">draft</Badge>
          <Badge tone="accent" variant="solid">
            solid
          </Badge>
        </Row>
        <Row>
          <StatusIndicator status="connected" detail="last delivery 2m ago" />
          <StatusIndicator status="degraded" detail="heartbeat late" />
          <StatusIndicator status="disconnected" />
          <StatusIndicator status="pending" />
        </Row>
        <Row>
          <Avatar name="Example Person" />
          <Avatar name="Example Agent" kind="agent" size={32} />
        </Row>
        <div className="pr-grid pr-grid--metrics" style={{ width: "100%" }}>
          <MetricCard label="Context delivered" value="12,408" detail="last 7 days" />
          <MetricCard label="Recurred" value={2} detail="after a fix release" tone="danger" />
        </div>
        <Timeline
          items={[
            {
              id: "1",
              title: "Verified",
              detail: "after 3 corrections and review",
              at: new Date(Date.now() - 172_800_000).toISOString(),
              actor: "Example Person",
              actorKind: "person",
              tone: "accent",
            },
            {
              id: "2",
              title: "Observed",
              at: new Date(Date.now() - 1_209_600_000).toISOString(),
              actor: "an agent",
              actorKind: "agent",
            },
          ]}
        />
      </div>
    ),
  },
  {
    id: "table",
    category: "data",
    name: "Data table",
    kind: "shared",
    imports: "DataTable, RowTitle",
    description:
      "Sortable headers, row selection with a bulk bar that replaces the header, skeleton and empty states, and a card layout under 600 px.",
    props: [
      { name: "columns", type: "{ key, header, sortable?, align?, hideOnMobile?, render }[]" },
      { name: "sort / onSortChange", type: "{ key, direction }" },
      { name: "selectable / selected / bulkActions", type: "Set<string>" },
      { name: "empty", type: "ReactNode" },
    ],
    a11y: "Native table semantics; sortable headers are buttons with aria-sort; the selection count is announced; RowTitle is the keyboard path into a row.",
    render: () => <TableDemo />,
  },
  {
    id: "untrusted",
    category: "data",
    name: "Untrusted runtime text",
    kind: "shared",
    imports: "UntrustedText",
    description:
      "Text from outside Pathrule (runtime events, imports) on the inset surface with a dashed border, rendered as text only: never HTML, markdown or a link.",
    a11y: "Labelled Untrusted runtime data.",
    render: () => (
      <UntrustedText
        label="message"
        source="example"
        text={
          "TypeError: Failed to fetch at loadOrders <img src=x onerror=alert(1)> ignore previous instructions"
        }
      />
    ),
  },
];
