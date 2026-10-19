// SPDX-License-Identifier: Apache-2.0
import { CircleAlert, Compass, Lock, PlugZap, WifiOff } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../components/button.js";
import { Banner, StateMessage } from "../components/surface.js";
import { Skeleton } from "../components/spinner.js";
import type { AsyncResource } from "../lib/use-async.js";
import { useUiMessages } from "../i18n/ui-messages.js";

/** A failed load: says what failed, keeps the request id, offers retry. Never blames the person. */
export function LoadError({
  title,
  error,
  onRetry,
  requestId,
  compact,
}: {
  title: string;
  error: Error;
  onRetry?: () => void;
  requestId?: string;
  compact?: boolean;
}) {
  const ui = useUiMessages();
  return (
    <StateMessage
      kind="error"
      icon={CircleAlert}
      title={title}
      description={error.message || ui.t("states.requestFailed")}
      requestId={requestId}
      compact={compact}
      actions={
        onRetry ? (
          <Button size="sm" onClick={onRetry}>
            {ui.t("states.retry")}
          </Button>
        ) : undefined
      }
    />
  );
}

/** Names what is missing and who can grant it. Navigation stays visible around it. */
export function PermissionState({
  title,
  description,
  action,
}: {
  title: string;
  description: ReactNode;
  action?: ReactNode;
}) {
  return (
    <StateMessage
      kind="permission"
      icon={Lock}
      title={title}
      description={description}
      actions={action}
    />
  );
}

/**
 * The runtime does not have this capability. Used instead of hiding a module the person
 * expects, and never with sample data: it says why and what would make it available.
 */
export function CapabilityUnavailable({
  title,
  reason,
  action,
}: {
  title: string;
  reason: ReactNode;
  action?: ReactNode;
}) {
  return (
    <StateMessage kind="empty" icon={PlugZap} title={title} description={reason} actions={action} />
  );
}

export function NotFoundState({
  title,
  description,
  action,
}: {
  title?: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  const ui = useUiMessages();
  return (
    <StateMessage
      kind="empty"
      icon={Compass}
      title={title ?? ui.t("states.notFoundTitle")}
      description={description ?? ui.t("states.notFoundDescription")}
      actions={action}
    />
  );
}

export function OfflineBanner({ since, onRetry }: { since?: string; onRetry?: () => void }) {
  const ui = useUiMessages();
  return (
    <Banner
      tone="warning"
      icon={WifiOff}
      action={
        onRetry ? (
          <button type="button" className="pr-banner__action" onClick={onRetry}>
            {ui.t("states.retryNow")}
          </button>
        ) : undefined
      }
    >
      {since ? ui.t("states.offlineSince", { since }) : ui.t("states.offline")}
    </Banner>
  );
}

export interface UnsavedChangesBarProps {
  count: number;
  onDiscard: () => void;
  onSave: () => void;
  saving?: boolean;
  disabledReason?: string;
}

/** Sticky bar for forms with explicit save. Discard is never destructive without saying so. */
export function UnsavedChangesBar({
  count,
  onDiscard,
  onSave,
  saving,
  disabledReason,
}: UnsavedChangesBarProps) {
  const ui = useUiMessages();
  if (count === 0) return null;
  return (
    <div className="pr-unsaved" role="region" aria-label={ui.t("states.unsavedRegion")}>
      <span className="pr-unsaved__text">{ui.plural("states.unsaved", count)}</span>
      <Button variant="ghost" size="sm" onClick={onDiscard} disabled={saving}>
        {ui.t("states.discard")}
      </Button>
      <Button
        variant="primary"
        size="sm"
        onClick={onSave}
        loading={saving}
        disabled={disabledReason ? { reason: disabledReason } : false}
      >
        {ui.t("states.save")}
      </Button>
    </div>
  );
}

export interface AsyncViewProps<T> {
  resource: AsyncResource<T>;
  /** What failed, for the error title: "Couldn't load knowledge". */
  errorTitle: string;
  loading?: ReactNode;
  children: (data: T) => ReactNode;
}

/** Renders exactly one of loading, error or the data. Empty is the child's job. */
export function AsyncView<T>({ resource, errorTitle, loading, children }: AsyncViewProps<T>) {
  const { state, reload } = resource;
  if (state.status === "loading")
    return (
      <div aria-busy="true" className="pr-stack pr-stack--2">
        {loading ?? (
          <>
            <Skeleton shape="row" />
            <Skeleton shape="row" />
            <Skeleton shape="row" />
          </>
        )}
      </div>
    );
  if (state.status === "error")
    return <LoadError title={errorTitle} error={state.error} onRetry={reload} />;
  return <>{children(state.data)}</>;
}
