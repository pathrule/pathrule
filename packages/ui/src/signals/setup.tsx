// SPDX-License-Identifier: Apache-2.0
// The Setup tab: what a fix needs before a release can prove it, this month's usage (Cloud), the
// ingest keys an app sends with, how to send, and what Pathrule keeps.
import { CircleCheck, KeyRound, TriangleAlert } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Badge } from "../components/badge.js";
import { Button } from "../components/button.js";
import { CopyButton } from "../components/data.js";
import { FormField, TextInput } from "../components/forms.js";
import { Dialog } from "../components/overlay.js";
import { Meter } from "../components/spinner.js";
import { Card, CardHeader, KeyValueList, StateMessage } from "../components/surface.js";
import { useAsync } from "../lib/use-async.js";
import { LoadError } from "../patterns/states.js";
import type { ReadinessCheck } from "./insights.js";
import { useSignalsMessages } from "./messages.js";
import type { CreatedIngestKey, IngestKeySummary, SignalsUsage } from "./model.js";
import { environmentName } from "./overview.js";

type Messages = ReturnType<typeof useSignalsMessages>;

function checkText(m: Messages, check: ReadinessCheck): { title: string; detail: string } {
  switch (check.key) {
    case "production":
      if (check.ok) {
        const time = check.lastSeen ? m.relative(check.lastSeen) : "";
        return {
          title: m.t("readiness.production"),
          detail: check.release
            ? m.t("readiness.productionDetail", { release: check.release, time })
            : m.t("readiness.productionNoRelease", { time }),
        };
      }
      return {
        title: check.lastSeen
          ? m.t("readiness.productionMissing")
          : m.t("readiness.productionNever"),
        detail: m.t("readiness.productionMissingDetail"),
      };
    case "releases":
      if (check.ok)
        return { title: m.t("readiness.releases"), detail: m.t("readiness.releasesDetail") };
      return {
        title: m.t("readiness.releasesMissing"),
        detail: check.missing.length
          ? m.t("readiness.releasesMissingDetail", {
              environments: check.missing.map(environmentName).join(", "),
            })
          : m.t("readiness.releasesBlocked"),
      };
    case "successes":
      if (check.flows === 0) {
        return {
          title: m.t("readiness.successesNone"),
          detail: m.t("readiness.successesNoneDetail"),
        };
      }
      if (check.ok)
        return { title: m.t("readiness.successes"), detail: m.t("readiness.successesDetail") };
      return {
        title: m.t("readiness.successesPartial", {
          count: m.number(check.withSuccesses),
          total: m.number(check.flows),
        }),
        detail: m.t("readiness.successesPartialDetail", { flows: check.missing.join(", ") }),
      };
    case "points":
      if (check.ok)
        return { title: m.t("readiness.points"), detail: m.t("readiness.pointsDetail") };
      return {
        title: m.plural("readiness.pointsWaiting", check.declared),
        detail: m.t("readiness.pointsWaitingDetail", { points: check.waiting.join(", ") }),
      };
  }
}

/** A check that has no flows to measure is not a failure: it reads as a step still to take. */
export function openChecks(checks: readonly ReadinessCheck[]): number {
  return checks.filter((check) => !check.ok).length;
}

export function ReadinessCard({ checks }: { checks: readonly ReadinessCheck[] }) {
  const m = useSignalsMessages();
  return (
    <Card aria-labelledby="signals-ready">
      <CardHeader
        id="signals-ready"
        title={m.t("readiness.title")}
        description={m.t("readiness.description")}
      />
      <ul className="pr-readiness">
        {checks.map((check) => {
          const text = checkText(m, check);
          return (
            <li key={check.key} className="pr-readiness__row">
              <span
                className={
                  check.ok ? "pr-readiness__icon pr-readiness__icon--ok" : "pr-readiness__icon"
                }
                aria-hidden
              >
                {check.ok ? <CircleCheck size={14} /> : <TriangleAlert size={14} />}
              </span>
              <span className="pr-readiness__text">
                <span className="pr-readiness__title">{text.title}</span>
                <span className="pr-readiness__detail">{text.detail}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export function UsageCard({ load }: { load: (signal: AbortSignal) => Promise<SignalsUsage> }) {
  const m = useSignalsMessages();
  const usage = useAsync(load, [load]);
  return (
    <Card aria-labelledby="signals-usage" padded>
      <div className="pr-stack pr-stack--3">
        <h2 id="signals-usage" className="pr-card__title">
          {m.t("usage.title")}
        </h2>
        {usage.state.status === "loading" ? null : usage.state.status === "error" ? (
          <LoadError
            compact
            title={m.t("usage.error")}
            error={usage.state.error}
            onRetry={usage.reload}
          />
        ) : (
          <>
            <Meter
              label={
                usage.state.data.limit != null
                  ? m.t("usage.counted", {
                      count: m.number(usage.state.data.counted),
                      limit: m.number(usage.state.data.limit),
                    })
                  : m.t("usage.countedNoLimit", { count: m.number(usage.state.data.counted) })
              }
              value={usage.state.data.counted}
              max={usage.state.data.limit ?? "unlimited"}
              format={(n) => m.number(n)}
            />
            <KeyValueList
              items={[
                { key: m.t("usage.spike"), value: m.number(usage.state.data.spikeLimited) },
                { key: m.t("usage.over"), value: m.number(usage.state.data.overQuota) },
                ...(usage.state.data.groupLimited
                  ? [
                      {
                        key: m.t("usage.groupLimited"),
                        value: m.number(usage.state.data.groupLimited),
                      },
                    ]
                  : []),
                {
                  key: m.t("usage.groups"),
                  value:
                    usage.state.data.groupLimit != null
                      ? m.t("usage.groupsOf", {
                          count: m.number(usage.state.data.groups),
                          limit: m.number(usage.state.data.groupLimit),
                        })
                      : m.number(usage.state.data.groups),
                },
              ]}
            />
          </>
        )}
      </div>
    </Card>
  );
}

export interface IngestKeysPanelProps {
  keys: readonly IngestKeySummary[];
  /** Present only when the source can revoke and the person is allowed to. */
  onRevoke?: (key: IngestKeySummary) => void;
  /** Present only when the source can create keys and the person is allowed to. */
  onCreate?: () => void;
  readOnlyReason?: string;
}

export function IngestKeysPanel({
  keys,
  onRevoke,
  onCreate,
  readOnlyReason,
}: IngestKeysPanelProps) {
  const m = useSignalsMessages();
  return (
    <Card aria-labelledby="signals-keys">
      <CardHeader
        id="signals-keys"
        title={m.t("keys.title")}
        meta={readOnlyReason ? m.t("keys.readOnly") : undefined}
        actions={
          onCreate ? (
            <Button size="sm" leadingIcon={KeyRound} onClick={onCreate}>
              {m.t("keys.create")}
            </Button>
          ) : undefined
        }
      />
      {keys.length === 0 ? (
        <StateMessage
          compact
          icon={KeyRound}
          title={m.t("keys.emptyTitle")}
          description={m.t("keys.emptyDescription")}
        />
      ) : (
        <ul className="pr-key-list">
          {keys.map((key) => (
            <li key={key.id} className="pr-key-list__row">
              <span className="pr-key-list__id">
                <span className="pr-mono">{key.prefix}••••••••</span>
                <span className="pr-meta">
                  {key.label ? `${key.label} · ` : ""}
                  {key.lastUsedAt
                    ? m.t("keys.lastUsed", { time: m.relative(key.lastUsedAt) })
                    : m.t("keys.neverUsed")}
                </span>
              </span>
              {key.revokedAt ? (
                <Badge tone="neutral" variant="outline" size="sm">
                  {m.t("keys.revoked")}
                </Badge>
              ) : onRevoke ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="pr-text-danger"
                  onClick={() => onRevoke(key)}
                >
                  {m.t("keys.revoke")}
                </Button>
              ) : (
                <Badge tone="accent" size="sm">
                  {m.t("keys.active")}
                </Badge>
              )}
            </li>
          ))}
        </ul>
      )}
      {readOnlyReason ? <p className="pr-card__note">{readOnlyReason}</p> : null}
    </Card>
  );
}

/** Names a new key, creates it, then shows its secret once with a copy button. */
export function CreateKeyDialog({
  open,
  onOpenChange,
  create,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  create: (label: string) => Promise<CreatedIngestKey>;
  onCreated: () => void;
}) {
  const m = useSignalsMessages();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedIngestKey | null>(null);
  const close = (next: boolean) => {
    if (busy) return;
    onOpenChange(next);
    if (!next) {
      setLabel("");
      setError(null);
      setCreated(null);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const name = label.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      setCreated(await create(name));
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : m.t("keys.createError"));
    } finally {
      setBusy(false);
    }
  };
  if (created) {
    return (
      <Dialog
        open={open}
        onOpenChange={close}
        title={m.t("keys.secretTitle")}
        description={m.t("keys.secretDescription")}
        footer={<Button onClick={() => close(false)}>{m.t("keys.secretDone")}</Button>}
      >
        <div className="pr-key-secret">
          <code className="pr-mono">{created.secret}</code>
          <CopyButton
            value={created.secret}
            label={m.t("keys.secretCopy")}
            text={m.t("keys.secretCopy")}
          />
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      busy={busy}
      icon={KeyRound}
      title={m.t("keys.createTitle")}
      description={m.t("keys.createDescription")}
      footer={
        <Button
          type="submit"
          form="signals-create-key"
          variant="primary"
          loading={busy}
          disabled={!label.trim()}
        >
          {m.t("keys.createConfirm")}
        </Button>
      }
    >
      <form id="signals-create-key" onSubmit={submit}>
        <FormField label={m.t("keys.labelField")} error={error ?? undefined}>
          <TextInput
            value={label}
            maxLength={80}
            placeholder={m.t("keys.labelPlaceholder")}
            onChange={(event) => setLabel(event.target.value)}
          />
        </FormField>
      </form>
    </Dialog>
  );
}

export function SendCard({ children }: { children: ReactNode }) {
  const m = useSignalsMessages();
  return (
    <section className="pr-stack pr-stack--3" aria-label={m.t("send.title")}>
      {children}
    </section>
  );
}

export function KeptCard({ retention }: { retention?: string }) {
  const m = useSignalsMessages();
  return (
    <Card aria-labelledby="signals-kept" padded>
      <div className="pr-stack pr-stack--2">
        <h2 id="signals-kept" className="pr-card__title">
          {m.t("kept.title")}
        </h2>
        <p className="pr-note">{retention ?? m.t("kept.fallback")}</p>
      </div>
    </Card>
  );
}
