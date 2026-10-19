// SPDX-License-Identifier: Apache-2.0
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CommandChip,
  CopyButton,
  KeyValueList,
  Page,
  PageHeader,
  StatusIndicator,
} from "@pathrule/ui";
import { RefreshCw } from "lucide-react";
import { useConsole, useRuntimeStatus } from "../app/context.js";
import { useConsoleMessages } from "../messages.js";

/** The local runtime as the host reports it, and where integrations are configured. */
export function RuntimePage() {
  const m = useConsoleMessages();
  const { refreshRuntime } = useConsole();
  const status = useRuntimeStatus();
  const host = status.host;
  const hostState = host.mode === "degraded" ? "disconnected" : "connected";
  return (
    <Page width="md">
      <div className="pr-stack pr-stack--5">
        <PageHeader
          title={m.t("runtime.title")}
          description={m.t("runtime.description")}
          actions={
            <Button size="sm" leadingIcon={RefreshCw} onClick={refreshRuntime}>
              {m.t("runtime.refresh")}
            </Button>
          }
        />
        <Card>
          <CardHeader
            title={m.t("runtime.host")}
            actions={
              <StatusIndicator
                status={hostState}
                live={false}
                label={
                  host.mode === "client"
                    ? m.t("runtime.running")
                    : host.mode === "own"
                      ? m.t("runtime.started")
                      : m.t("runtime.unreachable")
                }
              />
            }
          />
          <div className="pr-card__body">
            <KeyValueList
              items={[
                { key: m.t("runtime.mode"), value: host.mode, mono: true },
                {
                  key: m.t("runtime.version"),
                  value: host.version ?? m.t("runtime.unknown"),
                  mono: true,
                },
                {
                  key: m.t("runtime.process"),
                  value: host.pid != null ? String(host.pid) : m.t("runtime.unknown"),
                  mono: true,
                },
                {
                  key: m.t("runtime.plugins"),
                  value: host.plugins.length ? host.plugins.join(", ") : m.t("runtime.noPlugins"),
                  mono: host.plugins.length > 0,
                },
                { key: m.t("runtime.cli"), value: status.cliVersion, mono: true },
                { key: m.t("runtime.home"), value: status.home, mono: true, copy: status.home },
                {
                  key: m.t("runtime.account"),
                  value: (
                    <Badge size="sm" tone="neutral" variant="outline">
                      {m.t("runtime.noAccount")}
                    </Badge>
                  ),
                },
              ]}
              renderCopy={(item) =>
                item.copy ? (
                  <CopyButton
                    value={item.copy}
                    label={m.t("drawer.copyField", { field: item.key })}
                  />
                ) : null
              }
            />
          </div>
        </Card>
        <Card>
          <CardHeader title={m.t("runtime.integrations")} meta={m.t("runtime.integrationsMeta")} />
          <div className="pr-card__body pr-stack pr-stack--3">
            <p className="pr-note">{m.t("runtime.integrationsNote")}</p>
            <div className="lc-commands">
              <div>
                <span className="pr-section-label">{m.t("runtime.install")}</span>
                <CommandChip command="pathrule install" />
              </div>
              <div>
                <span className="pr-section-label">{m.t("runtime.doctor")}</span>
                <CommandChip command="pathrule doctor" />
              </div>
              <div>
                <span className="pr-section-label">{m.t("runtime.sync")}</span>
                <CommandChip command="pathrule sync" />
              </div>
            </div>
          </div>
        </Card>
      </div>
    </Page>
  );
}
