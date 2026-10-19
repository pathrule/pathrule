// SPDX-License-Identifier: Apache-2.0
// Action pages: buttons, copy and the command chip.
import { Copy, Ellipsis, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button, CodeBlock, CommandChip, CopyButton, IconButton } from "../src/index.js";
import { Row, type Entry } from "./registry-entry.js";

function ButtonDemo() {
  const [loading, setLoading] = useState(false);
  return (
    <div className="pr-stack pr-stack--4">
      <Row>
        <Button variant="primary" leadingIcon={ShieldCheck}>
          Publish to team
        </Button>
        <Button variant="neutral">Neutral</Button>
        <Button>Archive workspace</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger" leadingIcon={Trash2}>
          Delete permanently
        </Button>
      </Row>
      <Row>
        <Button size="sm">Small</Button>
        <Button>Medium</Button>
        <Button size="lg">Large</Button>
        <Button
          variant="primary"
          loading={loading}
          onClick={() => {
            setLoading(true);
            setTimeout(() => setLoading(false), 1400);
          }}
        >
          Click to load
        </Button>
        <Button disabled={{ reason: "Requires the Maintainer role" }}>
          Disabled with a reason
        </Button>
      </Row>
      <Row>
        <IconButton icon={Copy} label="Copy" />
        <IconButton icon={RefreshCw} label="Refresh" />
        <IconButton icon={Ellipsis} label="More actions" variant="secondary" />
        <IconButton icon={Trash2} label="Delete" disabled={{ reason: "Owners only" }} />
      </Row>
    </div>
  );
}

export const ACTION_ENTRIES: Entry[] = [
  {
    id: "button",
    category: "actions",
    name: "Button and Icon Button",
    kind: "shared",
    imports: "Button, IconButton",
    description:
      "Commits an action. Pill shape from pathrule.io. One primary per region; danger only when the action destroys data. Icon buttons are square, always labelled, with a tooltip.",
    props: [
      {
        name: "variant",
        type: '"primary" | "neutral" | "secondary" | "ghost" | "danger"',
        default: "secondary",
      },
      { name: "size", type: '"sm" | "md" | "lg"', default: "md" },
      {
        name: "loading",
        type: "boolean",
        default: "false",
        description: "Keeps the label, sets aria-busy, ignores clicks.",
      },
      {
        name: "disabled",
        type: "boolean | { reason }",
        default: "false",
        description: "With a reason the button stays focusable and explains why.",
      },
      { name: "leadingIcon / trailingIcon", type: "IconComponent" },
      {
        name: "IconButton.label",
        type: "string (required)",
        description: "Becomes aria-label and the tooltip.",
      },
    ],
    dos: ["Label as verb + object: Archive workspace.", "Keep the label while loading."],
    donts: [
      "Don't use danger for reversible actions: Archive is secondary, Delete permanently is danger.",
      "Don't disable without a reason.",
    ],
    a11y: "Native <button>. Loading sets aria-busy. Permission-disabled uses aria-disabled and a tooltip so it stays discoverable.",
    render: () => <ButtonDemo />,
  },
  {
    id: "copy",
    category: "actions",
    name: "Copy and Command chip",
    kind: "shared",
    imports: "CopyButton, CommandChip, CodeBlock",
    description:
      "Copy confirms in place for 1.5 s and never moves layout. The command chip is the CLI line from pathrule.io.",
    props: [
      { name: "CopyButton.value", type: "string" },
      { name: "CopyButton.label", type: "string", description: "Accessible name: what is copied." },
      { name: "CommandChip.command", type: "string" },
    ],
    a11y: "The copied state is announced through a polite live region.",
    render: () => (
      <div className="pr-stack pr-stack--3" style={{ width: "100%", maxWidth: 560 }}>
        <CommandChip command="pathrule ui" />
        <Row>
          <span className="pr-mono">ws_example_01</span>
          <CopyButton value="ws_example_01" label="Copy workspace id" />
        </Row>
        <CodeBlock
          title="instrumentation.ts"
          code={
            "import { pathrule } from './pathrule-signals'\n\npathrule.init({ key: process.env.PATHRULE_INGEST_KEY, environment: 'production' })"
          }
          highlight={[3]}
        />
      </div>
    ),
  },
];
