// SPDX-License-Identifier: Apache-2.0
import { CircleDot, CircleX, Clock, Radio, ShieldCheck, TriangleAlert } from "lucide-react";
import { cx } from "../lib/cx.js";
import { Icon, type IconComponent } from "../lib/icon.js";
import { Badge } from "../components/badge.js";
import { RelativeTime } from "../components/data.js";
import { SegmentBar } from "../components/charts.js";
import { Alert, KeyValueList } from "../components/surface.js";
import { Tooltip } from "../components/tooltip.js";
import { useSignalsMessages } from "./messages.js";
import {
  VERIFICATION_STATES,
  type SignalIssue,
  type VerificationPolicy,
  type VerificationState,
} from "./model.js";

const STATE_ICON: Record<VerificationState, IconComponent> = {
  unobserved: CircleDot,
  observing: Radio,
  quiet: Clock,
  verified: ShieldCheck,
  recurred: CircleX,
};

/** Verification state: shape + word + color, so it survives grayscale. Pulses only while observing. */
export function VerificationBadge({
  state,
  size = "md",
}: {
  state: VerificationState;
  size?: "sm" | "md";
}) {
  const m = useSignalsMessages();
  return (
    <Tooltip content={m.t(`verification.meaning.${state}`)}>
      <span className={cx("pr-verify", `pr-verify--${state}`, `pr-verify--${size}`)} tabIndex={0}>
        <Icon
          icon={STATE_ICON[state]}
          size="xs"
          className={state === "observing" ? "pr-verify__live" : undefined}
        />
        {m.t(`verification.label.${state}`)}
      </span>
    </Tooltip>
  );
}

export function VerificationLegend() {
  const m = useSignalsMessages();
  return (
    <dl className="pr-verify-legend">
      {VERIFICATION_STATES.map((state) => (
        <div key={state} className="pr-verify-legend__row">
          <dt>
            <span className={cx("pr-verify", `pr-verify--${state}`, "pr-verify--sm")}>
              <Icon icon={STATE_ICON[state]} size="xs" />
              {m.t(`verification.label.${state}`)}
            </span>
          </dt>
          <dd>{m.t(`verification.meaning.${state}`)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A resolved group whose verification is not `verified` was closed by a person, not evidence. */
export function isManualResolution(issue: SignalIssue): boolean {
  return issue.status === "resolved" && issue.verification !== "verified";
}

/**
 * The group's lifecycle. `Resolved` appears only for a verified fix; a group closed any other
 * way says so, so archived or manual closure never reads as proof.
 */
export function StatusBadge({ issue, size = "sm" }: { issue: SignalIssue; size?: "sm" | "md" }) {
  const m = useSignalsMessages();
  const manual = isManualResolution(issue);
  const label = manual ? m.t("status.resolvedManual") : m.t(`status.label.${issue.status}`);
  const meaning = manual
    ? m.t("status.meaning.resolvedManual")
    : m.t(`status.meaning.${issue.status}`);
  const tone =
    issue.status === "resolved" && !manual
      ? "accent"
      : issue.status === "active"
        ? "neutral"
        : "warning";
  return (
    <Tooltip content={meaning}>
      <Badge
        tone={tone}
        variant={issue.status === "active" ? "outline" : "soft"}
        size={size}
        tabIndex={0}
      >
        {label}
      </Badge>
    </Tooltip>
  );
}

function duration(m: ReturnType<typeof useSignalsMessages>, ms: number): string {
  const hours = ms / 3_600_000;
  if (hours >= 1 && Number.isInteger(hours)) {
    return m.number(hours, { style: "unit", unit: "hour", unitDisplay: "long" });
  }
  return m.number(Math.round(ms / 60_000), { style: "unit", unit: "minute", unitDisplay: "long" });
}

export function verificationRules(
  m: ReturnType<typeof useSignalsMessages>,
  policy: VerificationPolicy | undefined,
): string {
  if (!policy) return m.t("fix.rulesGeneric");
  return m.t("fix.rules", {
    envelopes: policy.minEnvelopes,
    quietAfter: duration(m, policy.quietAfterMs),
    successes: policy.minSuccesses,
    verifiedAfter: duration(m, policy.verifiedAfterMs),
  });
}

function minutes(m: ReturnType<typeof useSignalsMessages>, ms: number): string {
  return m.number(Math.max(0, Math.floor(ms / 60_000)), {
    style: "unit",
    unit: "minute",
    unitDisplay: "short",
  });
}

/** One condition of the proof: what it is, how far along, against its threshold. */
function ProofMeter({ label, value, share }: { label: string; value: string; share: number }) {
  const done = share >= 1;
  return (
    <span className="pr-proof-meter">
      <span className="pr-proof-meter__head">
        <span>{label}</span>
        <span className={cx("pr-tabular", done && "pr-proof-meter__value--done")}>{value}</span>
      </span>
      <SegmentBar
        size="sm"
        track
        scale={Math.max(0, Math.min(1, share))}
        segments={[{ key: "met", value: share > 0 ? 1 : 0, color: done ? "positive" : "info" }]}
      />
    </span>
  );
}

/**
 * Whether the latest fix holds: the release it was made against and the release being watched,
 * then each condition of the proof against its threshold when the source states them. Shows
 * nothing it does not have.
 */
export function FixHolding({
  issue,
  policy,
  now = Date.now(),
}: {
  issue: SignalIssue;
  policy?: VerificationPolicy;
  now?: number;
}) {
  const m = useSignalsMessages();
  const p = issue.progress;
  if (!p) return null;
  const finished = issue.verification === "verified";
  const ran = p.observedSince ? Math.max(0, now - Date.parse(p.observedSince)) : 0;
  const of = (value: string | number, target: string | number) =>
    m.t("detail.meters.of", { value: String(value), target: String(target) });
  return (
    <div className="pr-stack pr-stack--3">
      {p.blocked === "no_release" ? (
        <Alert tone="warning" icon={TriangleAlert} title={m.t("progress.blockedTitle")}>
          {m.t("progress.blocked")}
        </Alert>
      ) : null}
      {issue.verification === "quiet" && p.fresh === false ? (
        <Alert tone="warning" icon={Clock} title={m.t("progress.staleTitle")}>
          {m.t("progress.stale")}
        </Alert>
      ) : null}
      <p className="pr-release-step pr-mono">
        <span>
          {issue.correction?.baselineRelease ?? m.t("fix.unknownRelease")}{" "}
          <span className="pr-meta">({m.t("progress.baseline")})</span>
        </span>
        <span aria-hidden>→</span>
        <span>
          {p.candidateRelease ?? m.t("progress.noCandidate")}{" "}
          {p.candidateRelease ? (
            <span className="pr-meta">({m.t("progress.candidate")})</span>
          ) : null}
        </span>
      </p>
      {p.candidateRelease && policy ? (
        <div className="pr-proof-meters">
          <ProofMeter
            label={m.t("detail.meters.running", { release: p.candidateRelease })}
            value={of(
              minutes(m, finished ? policy.verifiedAfterMs : ran),
              minutes(m, policy.verifiedAfterMs),
            )}
            share={finished ? 1 : ran / policy.verifiedAfterMs}
          />
          <ProofMeter
            label={m.t("detail.meters.envelopes")}
            value={of(m.number(p.envelopes), m.number(policy.minEnvelopes))}
            share={p.envelopes / Math.max(1, policy.minEnvelopes)}
          />
          {issue.flow ? (
            <ProofMeter
              label={m.t("detail.meters.successes", { flow: issue.flow })}
              value={of(m.number(p.successes), m.number(policy.minSuccesses))}
              share={p.successes / Math.max(1, policy.minSuccesses)}
            />
          ) : (
            <span className="pr-proof-meter pr-meta">{m.t("progress.noFlow")}</span>
          )}
        </div>
      ) : p.candidateRelease ? (
        <KeyValueList
          columns={2}
          items={[
            { key: m.t("progress.envelopes"), value: m.number(p.envelopes) },
            {
              key: m.t("progress.successes"),
              value: issue.flow ? m.number(p.successes) : m.t("progress.noFlow"),
            },
          ]}
        />
      ) : null}
      {p.recurrences > 0 ? (
        <p className="pr-note pr-note--danger">
          {m.t("progress.recurrences")}:{" "}
          {p.recurredRelease
            ? m.t("progress.recurredIn", { count: p.recurrences, release: p.recurredRelease })
            : m.number(p.recurrences)}
        </p>
      ) : null}
      {p.candidateLastSeen ? (
        <p className="pr-meta">
          {m.t("progress.lastEnvelope")} <RelativeTime iso={p.candidateLastSeen} />
        </p>
      ) : null}
    </div>
  );
}
