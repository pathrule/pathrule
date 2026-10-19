// SPDX-License-Identifier: Apache-2.0
// Feedback pages: alerts and toasts, overlays, progress and the non-happy-path states.
import { Trash2 } from "lucide-react";
import { useState } from "react";
import {
  Alert,
  Banner,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  Drawer,
  FormField,
  KeyValueList,
  Meter,
  Progress,
  Skeleton,
  Spinner,
  StateMessage,
  TextInput,
  useToast,
} from "../src/index.js";
import {
  CapabilityUnavailable,
  LoadError,
  PermissionState,
  UnsavedChangesBar,
} from "../src/patterns/states.js";
import { Row, type Entry } from "./registry-entry.js";

function FeedbackDemo() {
  const toast = useToast();
  return (
    <div className="pr-stack pr-stack--3" style={{ width: "100%" }}>
      <Alert tone="info" title="Scope changed to /src/features/orders">
        Agents receive knowledge from the new scope on their next session.
      </Alert>
      <Alert
        tone="warning"
        title="82% of the plan limit"
        action={{ label: "Compare plans", onClick: () => {} }}
      >
        New items queue at the limit.
      </Alert>
      <Alert tone="danger" title="Runtime event ingest failing">
        The ingest key for production was revoked.
      </Alert>
      <Banner tone="warning">
        Can't reach the runtime. Changes are disabled until it is back.
      </Banner>
      <Row>
        <Button
          onClick={() =>
            toast.show({
              title: "Memory retired",
              undo: () => toast.show({ title: "Memory restored" }),
            })
          }
        >
          Toast with undo
        </Button>
        <Button
          onClick={() =>
            toast.show({
              title: "Couldn't save",
              description: "The runtime is not reachable.",
              tone: "error",
            })
          }
        >
          Error toast
        </Button>
        <Button
          onClick={() => {
            const id = toast.show({ title: "Publishing…", tone: "loading" });
            setTimeout(() => toast.update(id, { title: "Published" }), 1500);
          }}
        >
          Async toast
        </Button>
      </Row>
    </div>
  );
}

function OverlayDemo() {
  const [dialog, setDialog] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [drawer, setDrawer] = useState(false);
  return (
    <Row>
      <Button onClick={() => setDialog(true)}>Dialog</Button>
      <Button variant="danger" onClick={() => setConfirm(true)}>
        Delete permanently
      </Button>
      <Button onClick={() => setDrawer(true)}>Drawer</Button>
      <Dialog
        open={dialog}
        onOpenChange={setDialog}
        title="Rename workspace"
        description="The name becomes the URL slug."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => setDialog(false)}>
              Rename
            </Button>
          </>
        }
      >
        <FormField label="Name">
          <TextInput mono defaultValue="pathrule-web" />
        </FormField>
      </Dialog>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        tone="danger"
        icon={Trash2}
        title="Delete pathrule-web permanently?"
        description="312 knowledge items, all revisions and runtime events are erased. This can't be undone."
        confirmLabel="Delete permanently"
        confirmText="pathrule-web"
        onConfirm={() => new Promise((resolve) => setTimeout(resolve, 900))}
      />
      <Drawer
        open={drawer}
        onOpenChange={setDrawer}
        eyebrow="memory"
        title="Use the api client, not fetch"
        footer={
          <Button variant="primary" onClick={() => setDrawer(false)}>
            Done
          </Button>
        }
      >
        <KeyValueList
          items={[
            { key: "Owner path", value: "/src/features", mono: true },
            { key: "Version", value: "v4", mono: true },
          ]}
        />
      </Drawer>
    </Row>
  );
}

function ProgressDemo() {
  const [value, setValue] = useState(62);
  return (
    <div className="pr-stack pr-stack--4" style={{ width: "100%", maxWidth: 520 }}>
      <Progress label="Importing" value={value} valueText={`${value} percent`} />
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => setValue(+e.target.value)}
        aria-label="Progress value"
      />
      <Progress label="Working" />
      <Meter label="Knowledge items" value={8240} max={10000} />
      <Meter label="Seats" value={8} max={10} />
      <Meter label="Runtime events" value={1020000} max={1000000} />
      <Row>
        <Spinner />
        <Skeleton width="40%" />
      </Row>
    </div>
  );
}

export const FEEDBACK_ENTRIES: Entry[] = [
  {
    id: "feedback",
    category: "feedback",
    name: "Alert, Banner, Toast",
    kind: "shared",
    imports: "Alert, Banner, ToastProvider, useToast",
    description:
      "Alerts persist in context. Toasts confirm and offer undo; undo toasts stay at least 8 s and pause on hover or focus.",
    a11y: "Danger alerts use role=alert, others role=status; toasts live in a polite region.",
    render: () => <FeedbackDemo />,
  },
  {
    id: "overlay",
    category: "feedback",
    name: "Dialog, Confirmation, Drawer",
    kind: "shared",
    imports: "Dialog, ConfirmDialog, Drawer",
    description:
      "Dialogs interrupt for a decision. Confirmations name the consequence and require typing for irreversible actions. Drawers show detail without losing the list. On phones, dialogs become bottom sheets.",
    props: [
      {
        name: "ConfirmDialog.confirmText",
        type: "string",
        description: "Must be typed exactly; only for irreversible actions.",
      },
      {
        name: "Dialog.busy",
        type: "boolean",
        description: "Keeps it open while a request is in flight.",
      },
    ],
    a11y: "Focus is trapped and returns to the trigger; aria-modal, labelled and described.",
    render: () => <OverlayDemo />,
  },
  {
    id: "progress",
    category: "feedback",
    name: "Progress, Meter, Spinner, Skeleton",
    kind: "shared",
    imports: "Progress, Meter, Spinner, Skeleton",
    description:
      "Determinate when we know, indeterminate when we don't, skeletons when the layout is known. Meters change tone at 80 and 100 percent and state the numbers.",
    render: () => <ProgressDemo />,
  },
  {
    id: "states",
    category: "feedback",
    name: "Empty, Error, Permission, Unavailable",
    kind: "pattern",
    imports: "StateMessage, LoadError, PermissionState, CapabilityUnavailable, UnsavedChangesBar",
    description:
      "Every list has more states than its happy path. A failed load is an error with retry, never an empty list. A missing capability says why instead of showing sample data.",
    render: () => (
      <div className="pg-grid">
        <Card padded>
          <StateMessage
            compact
            title="No knowledge in this workspace yet"
            description="Agents propose knowledge from corrections."
            actions={
              <Button size="sm" variant="primary">
                New memory
              </Button>
            }
          />
        </Card>
        <Card padded>
          <LoadError
            compact
            title="Couldn't load knowledge"
            error={new Error("The request timed out. Your data is safe.")}
            onRetry={() => {}}
            requestId="req_example"
          />
        </Card>
        <Card padded>
          <PermissionState
            title="Owners and admins manage billing"
            description="Ask an owner of this organization for access."
          />
        </Card>
        <Card padded>
          <CapabilityUnavailable
            title="Semantic search is off"
            reason="Needs an embedding key (bring your own key)."
          />
        </Card>
        <UnsavedChangesBar count={2} onDiscard={() => {}} onSave={() => {}} />
      </div>
    ),
  },
];
