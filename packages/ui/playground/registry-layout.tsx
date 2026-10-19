// SPDX-License-Identifier: Apache-2.0
// Layout pages: the application shell.
import { Activity, Archive, Users } from "lucide-react";
import { AppShell, Brand, Breadcrumbs, Button, PageHeader } from "../src/index.js";
import type { Entry } from "./registry-entry.js";

export const LAYOUT_ENTRIES: Entry[] = [
  {
    id: "shell",
    category: "layout",
    name: "Application shell",
    kind: "shared",
    imports: "AppShell, Sidebar, NavItem, Topbar, PageHeader, Brand",
    description:
      "Sticky 248 px sidebar from 900 px, a modal sheet below it. Locked items stay visible with a lock and the reason. Badges only for counts that wait for the person.",
    render: () => (
      <div className="pg-embedded pg-embedded--shell">
        <AppShell
          sidebar={{
            label: "Example console",
            brand: <Brand product="Pathrule" edition="example" />,
            sections: [
              { items: [{ label: "Overview", icon: Activity, href: "#", active: true }] },
              {
                heading: "organization",
                items: [
                  {
                    label: "Members",
                    icon: Users,
                    href: "#",
                    badge: { count: 3, tone: "warning", label: "awaiting review" },
                  },
                  {
                    label: "Billing",
                    icon: Archive,
                    href: "#",
                    locked: { reason: "Owners and admins manage billing" },
                  },
                ],
              },
            ],
          }}
          topbar={{
            leading: <Breadcrumbs items={[{ label: "example" }, { label: "overview" }]} />,
          }}
        >
          <PageHeader
            title="Overview"
            description="A page inside the shared shell."
            actions={<Button variant="primary">Primary action</Button>}
          />
        </AppShell>
      </div>
    ),
  },
];
