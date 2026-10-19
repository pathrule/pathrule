// SPDX-License-Identifier: Apache-2.0
// Signals pages: the runtime-events workspace and its verification states, on example data.
import { useState } from "react";
import { Badge, Card, SegmentedControl } from "../src/index.js";
import {
  SignalIssueDetail,
  SignalsWorkspace,
  StatusBadge,
  VerificationBadge,
  VerificationLegend,
} from "../src/signals/index.js";
import {
  EXAMPLE_ISSUES,
  EXAMPLE_LOCAL_ISSUES,
  exampleSource,
  type ExampleMode,
} from "./examples.js";
import { Row, type Entry } from "./registry-entry.js";

function SignalsDemo() {
  const [mode, setMode] = useState<ExampleMode>("local");
  return (
    <div className="pr-stack pr-stack--4" style={{ width: "100%" }}>
      <Row>
        <SegmentedControl
          label="Example source"
          size="sm"
          value={mode}
          onValueChange={setMode}
          options={[
            { value: "local", label: "Local-shaped" },
            { value: "data", label: "Cloud-shaped" },
            { value: "empty", label: "Empty" },
            { value: "error", label: "Error" },
            { value: "unavailable", label: "Unavailable" },
          ]}
        />
        <Badge tone="warning" variant="outline" size="sm">
          example data, not a real workspace
        </Badge>
      </Row>
      <div className="pg-embedded">
        <SignalsWorkspace
          key={mode}
          source={exampleSource(mode)}
          workspaceName="example-web"
          agentSteps={(issue) => [`Example step for ${issue.id}, named by the console.`]}
        />
      </div>
    </div>
  );
}

export const SIGNALS_ENTRIES: Entry[] = [
  {
    id: "signals",
    category: "signals",
    name: "Signals workspace",
    kind: "domain",
    from: "@pathrule/ui/signals",
    imports: "SignalsWorkspace, type SignalsSource",
    description:
      "Runtime evidence that a fix held, or did not. The backend's verification state is authoritative and shown as is; human workflow metadata sits apart and never implies verification. Each console supplies a SignalsSource.",
    props: [
      {
        name: "source",
        type: "SignalsSource",
        description:
          "capabilities + listIssues; listCoverage, listKeys, revokeKey only when they exist.",
      },
      { name: "workspaceName", type: "string" },
      {
        name: "managedPanels",
        type: "ReactNode",
        description: "Cloud-only additions: quotas, usage, team settings.",
      },
      {
        name: "setup",
        type: "ReactNode",
        description: "How to connect an application to this source, under Instrumentation.",
      },
      {
        name: "agentSteps",
        type: "(issue) => string[]",
        description: "Steps the console can name exactly in the agent brief (tools, commands).",
      },
      {
        name: "view / onViewChange",
        type: '"overview" | "issues" | "verification" | "instrumentation" | "activity"',
        description: "Controlled view, for consoles that keep it in the URL.",
      },
      {
        name: "openIssueId / onOpenIssueChange",
        type: "string | null",
        description: "Controlled open group, for deep links.",
      },
    ],
    dos: [
      "Show Verified only from the backend's verified state.",
      "Say when a group is not tracked, and why.",
      "Call a fix record a claim; only evidence from a newer release moves a group.",
      "Copy hand-off briefs locally; never send runtime text anywhere.",
    ],
    donts: [
      "Don't call quiet, archived or a manual resolution a fix.",
      "Don't add boards, assignment or sprints.",
      "Don't render runtime text or a fix note as HTML or markdown.",
    ],
    a11y: "Verification is shape, word and color; the coverage strip has a text equivalent.",
    render: () => <SignalsDemo />,
  },
  {
    id: "verification",
    category: "signals",
    name: "Verification states and issue detail",
    kind: "domain",
    from: "@pathrule/ui/signals",
    imports: "VerificationBadge, StatusBadge, VerificationLegend, SignalIssueDetail",
    description:
      "Five states the backend computes. Observing pulses; nothing else moves. The lifecycle badge says Resolved only for a verified fix; archived and manual closure say what they are.",
    render: () => (
      <div className="pr-stack pr-stack--4" style={{ width: "100%" }}>
        <Row>
          {(["recurred", "observing", "quiet", "verified", "unobserved"] as const).map((s) => (
            <VerificationBadge key={s} state={s} />
          ))}
        </Row>
        <Row>
          <StatusBadge issue={EXAMPLE_ISSUES[3]!} />
          <StatusBadge issue={{ ...EXAMPLE_ISSUES[3]!, verification: "unobserved" }} />
          <StatusBadge issue={EXAMPLE_LOCAL_ISSUES[2]!} />
          <StatusBadge issue={EXAMPLE_ISSUES[0]!} />
        </Row>
        <Card padded>
          <SignalIssueDetail
            issue={EXAMPLE_LOCAL_ISSUES[0]!}
            all={EXAMPLE_LOCAL_ISSUES}
            workspaceName="example-api"
            capabilities={exampleSource("local").capabilities}
            loadHistory={exampleSource("local").getHistory}
          />
        </Card>
        <Card padded>
          <VerificationLegend />
        </Card>
        <Card padded>
          <SignalIssueDetail
            issue={EXAMPLE_ISSUES[1]!}
            all={EXAMPLE_ISSUES}
            workspaceName="example-web"
          />
        </Card>
      </div>
    ),
  },
];
