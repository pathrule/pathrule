// SPDX-License-Identifier: Apache-2.0
// Automated accessibility scan of composed screens with axe-core. jsdom has no layout,
// so color contrast is checked from the token values in tokens.test.ts instead.
import axe from "axe-core";
import { Archive, Gauge, Layers, Settings } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";
import { Button, IconButton } from "../src/components/button.js";
import { Badge, StatusIndicator } from "../src/components/badge.js";
import {
  Checkbox,
  FormField,
  RadioGroup,
  SearchInput,
  Select,
  Switch,
  TextInput,
  Textarea,
} from "../src/components/forms.js";
import { Breadcrumbs, Pagination, SegmentedControl, Tabs } from "../src/components/navigation.js";
import {
  Alert,
  Card,
  CardHeader,
  KeyValueList,
  MetricCard,
  StateMessage,
} from "../src/components/surface.js";
import { CodeBlock, CommandChip, Timeline, UntrustedText } from "../src/components/data.js";
import { DataTable, RowTitle } from "../src/components/table.js";
import { ToastProvider } from "../src/components/toast.js";
import { AppShell, Brand, PageHeader } from "../src/layouts/app-shell.js";
import {
  BrokenByArea,
  brokenByArea,
  IssueBrowser,
  SignalIssueDetail,
  VerificationLegend,
} from "../src/signals/components.js";
import { issue } from "./fixtures.js";
import { cleanup, flush, render } from "./render.js";

afterEach(cleanup);

async function violations(root: Element) {
  const result = await axe.run(root, {
    rules: { "color-contrast": { enabled: false } },
    resultTypes: ["violations"],
  });
  return result.violations.map(
    (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`,
  );
}

describe("accessibility", () => {
  it("an application page with shell, forms, tables and states has no axe violations", async () => {
    const { container } = render(
      <ToastProvider>
        <AppShell
          sidebar={{
            label: "Console",
            brand: <Brand product="Pathrule" edition="local" />,
            sections: [
              {
                items: [
                  { label: "Overview", icon: Gauge, href: "/", active: true },
                  {
                    label: "Knowledge",
                    icon: Layers,
                    href: "/knowledge",
                    badge: { count: 3, tone: "warning", label: "awaiting review" },
                  },
                  {
                    label: "Settings",
                    icon: Settings,
                    href: "/settings",
                    locked: { reason: "Owner only" },
                  },
                ],
              },
            ],
          }}
          topbar={{
            leading: (
              <Breadcrumbs
                items={[
                  { label: "local" },
                  { label: "pathrule-web", href: "/" },
                  { label: "overview" },
                ]}
              />
            ),
          }}
        >
          <PageHeader
            title="Overview"
            description="What agents know about this workspace."
            actions={<Button variant="primary">New memory</Button>}
          />
          <div className="pr-grid pr-grid--metrics">
            <MetricCard label="Memories" value={12} detail="3 updated this week" />
          </div>
          <Alert
            tone="warning"
            title="Semantic search is off"
            action={{ label: "Learn how", onClick: () => {} }}
          >
            Needs an embedding key.
          </Alert>
          <Tabs
            label="Views"
            value="a"
            onValueChange={() => {}}
            items={[
              { value: "a", label: "Knowledge", count: 4 },
              { value: "b", label: "Scopes" },
            ]}
          />
          <SegmentedControl
            label="Type"
            value="all"
            onValueChange={() => {}}
            options={[
              { value: "all", label: "All" },
              { value: "memory", label: "Memories" },
            ]}
          />
          <SearchInput value="" onValueChange={() => {}} aria-label="Search knowledge" />
          <Card>
            <CardHeader title="Settings" />
            <div className="pr-stack pr-stack--3" style={{ padding: 16 }}>
              <FormField label="Workspace name" description="Lowercase, numbers and dashes.">
                <TextInput defaultValue="pathrule-web" mono />
              </FormField>
              <FormField label="Notes" optional>
                <Textarea maxLength={140} value="" onChange={() => {}} />
              </FormField>
              <FormField label="Density">
                <Select
                  options={[
                    { value: "comfortable", label: "Comfortable" },
                    { value: "compact", label: "Compact" },
                  ]}
                  defaultValue="comfortable"
                />
              </FormField>
              <Checkbox
                checked
                onCheckedChange={() => {}}
                label="Memories"
                description="Facts and conventions"
              />
              <RadioGroup
                label="Visibility"
                value="private"
                onValueChange={() => {}}
                options={[
                  { value: "private", label: "Private" },
                  { value: "org", label: "Organization" },
                ]}
              />
              <Switch
                checked
                onCheckedChange={() => {}}
                label="Learn from sessions"
                description="Proposes knowledge from corrections"
              />
              <Switch
                checked={false}
                onCheckedChange={() => {}}
                label="Telemetry"
                locked={{ reason: "Managed by organization policy" }}
              />
            </div>
          </Card>
          <DataTable
            caption="Knowledge"
            rows={[{ id: "1", t: "Use the api client" }]}
            rowKey={(r) => r.id}
            selectable
            onRowClick={() => {}}
            columns={[
              {
                key: "t",
                header: "Title",
                render: (r) => <RowTitle onOpen={() => {}}>{r.t}</RowTitle>,
              },
              {
                key: "a",
                header: "Actions",
                render: () => <IconButton icon={Archive} label="Archive" tooltip={false} />,
              },
            ]}
          />
          <Pagination page={2} pageSize={25} total={312} onPageChange={() => {}} />
          <KeyValueList items={[{ key: "Workspace id", value: "ws_01J9", mono: true }]} />
          <CommandChip command="pathrule ui" />
          <CodeBlock code={"pathrule init --local\npathrule ui"} title="terminal" />
          <Timeline
            items={[
              {
                id: "1",
                title: "Verified",
                at: "2026-10-08T10:00:00Z",
                actor: "Deniz",
                actorKind: "person",
              },
            ]}
          />
          <UntrustedText label="message" text="<img src=x onerror=alert(1)>" />
          <StatusIndicator status="connected" detail="last heartbeat 2m ago" />
          <Badge tone="accent">verified</Badge>
          <StateMessage
            title="No knowledge yet"
            description="Agents propose knowledge from corrections."
            actions={<Button>Create memory</Button>}
          />
        </AppShell>
      </ToastProvider>,
    );
    await flush();
    expect(await violations(container)).toEqual([]);
  });

  it("the Signals issue table, detail and legend have no axe violations", async () => {
    const groups = [
      issue({ id: "a", verification: "recurred" }),
      issue({
        id: "b",
        fingerprint: "fp-a",
        environment: "staging",
        coverage: { tracked: false, reason: "only production errors are verified" },
      }),
    ];
    const { container } = render(
      <main>
        <h1>Signals</h1>
        <IssueBrowser issues={groups} environment="production" onOpen={() => {}} />
        <BrokenByArea
          areas={brokenByArea(groups)}
          environment="production"
          knowledgeAt={() => ({ memory: 2, rule: 1, skill: 0, href: "/knowledge" })}
          onOpen={() => {}}
          onShowAll={() => {}}
        />
        <h2>Issue group detail</h2>
        <SignalIssueDetail issue={groups[0]!} all={groups} workspaceName="pathrule-web" />
        <VerificationLegend />
      </main>,
    );
    await flush();
    expect(await violations(container)).toEqual([]);
  });
});
