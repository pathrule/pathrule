// SPDX-License-Identifier: Apache-2.0
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { X } from "lucide-react";
import { useId, useState, type ReactElement, type ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { Icon, type IconComponent } from "../lib/icon.js";
import { Button } from "./button.js";
import { useUiMessages } from "../i18n/ui-messages.js";

/* ── Popover ─────────────────────────────────────────────────────────────── */

export interface PopoverProps {
  trigger: ReactElement;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  /** Accessible name for the popover surface. */
  label?: string;
  className?: string;
}

/** Small, non-blocking controls anchored to a trigger. Focus moves in and returns on close. */
export function Popover({
  trigger,
  children,
  open,
  onOpenChange,
  align = "start",
  side = "bottom",
  label,
  className,
}: PopoverProps) {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align={align}
          side={side}
          sideOffset={6}
          collisionPadding={12}
          aria-label={label}
          className={cx("pr-popover", className)}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/**
 * Escape belongs to the innermost open thing. The dialog primitive hears Escape first (capture),
 * so when focus is on a control whose own popup is open (a combobox list), the dialog stays open
 * and the control closes its popup.
 */
function escapeOwnedByControl(event: KeyboardEvent): boolean {
  const target = event.target;
  return (
    target instanceof HTMLElement &&
    target.getAttribute("aria-expanded") === "true" &&
    target.getAttribute("role") === "combobox"
  );
}

/* ── Dialog ──────────────────────────────────────────────────────────────── */

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The question or the object: "Delete pathrule-web permanently?" */
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** Keep the dialog open while a destructive request is in flight. */
  busy?: boolean;
  icon?: IconComponent;
  tone?: "default" | "danger";
  className?: string;
}

/**
 * Interrupts for a decision. Focus is trapped and returns to the trigger; Escape and
 * the scrim close it unless `busy`. On narrow screens it becomes a bottom sheet.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
  busy = false,
  icon,
  tone = "default",
  className,
}: DialogProps) {
  const ui = useUiMessages();
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="pr-scrim" />
        <DialogPrimitive.Content
          className={cx(
            "pr-dialog",
            `pr-dialog--${size}`,
            tone === "danger" && "pr-dialog--danger",
            className,
          )}
          onEscapeKeyDown={(event) => {
            if (busy || escapeOwnedByControl(event)) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <div className="pr-dialog__header">
            {icon ? (
              <span
                className={cx("pr-dialog__icon", tone === "danger" && "pr-dialog__icon--danger")}
              >
                <Icon icon={icon} size="md" />
              </span>
            ) : null}
            <div className="pr-dialog__heading">
              <DialogPrimitive.Title className="pr-dialog__title">{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="pr-dialog__description">
                  {description}
                </DialogPrimitive.Description>
              ) : (
                <DialogPrimitive.Description className="pr-sr-only">
                  {typeof title === "string" ? title : ui.t("overlay.dialog")}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                className="pr-dialog__close"
                aria-label={ui.t("overlay.close")}
                disabled={busy}
              >
                <Icon icon={X} size="md" />
              </button>
            </DialogPrimitive.Close>
          </div>
          {children ? <div className="pr-dialog__body">{children}</div> : null}
          {footer ? <div className="pr-dialog__footer">{footer}</div> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** Name the consequence: what is kept, what is lost, whether it can be undone. */
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  /** Irreversible actions require typing this text exactly. Never for reversible ones. */
  confirmText?: string;
  icon?: IconComponent;
  /** Runs the action. The dialog stays open (busy) until it settles; a thrown error is shown inline. */
  onConfirm: () => Promise<void> | void;
  children?: ReactNode;
  /** Wider for confirmations that carry a form; a plain confirmation stays small. */
  size?: "sm" | "md" | "lg";
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = "default",
  confirmText,
  icon,
  onConfirm,
  children,
  size = "sm",
}: ConfirmDialogProps) {
  const ui = useUiMessages();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const errorId = useId();
  const matches = confirmText == null || typed === confirmText;

  const close = (next: boolean) => {
    if (!next) {
      setTyped("");
      setError(null);
    }
    onOpenChange(next);
  };

  const run = async () => {
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      setTyped("");
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : ui.t("overlay.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={title}
      description={description}
      icon={icon}
      tone={tone}
      busy={busy}
      size={size}
      footer={
        <>
          <Button variant="ghost" onClick={() => close(false)} disabled={busy}>
            {cancelLabel ?? ui.t("overlay.cancel")}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            loading={busy}
            disabled={
              matches
                ? false
                : { reason: ui.t("overlay.typeToConfirm", { text: confirmText ?? "" }) }
            }
            onClick={() => void run()}
            className={tone === "danger" && matches ? "pr-btn--danger-armed" : undefined}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        className="pr-stack pr-stack--3"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        {children}
        {confirmText != null ? (
          <div className="pr-field">
            <label htmlFor={inputId} className="pr-field__label">
              Type <span className="pr-mono">{confirmText}</span> to confirm
            </label>
            <input
              id={inputId}
              className="pr-input pr-input--mono"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={typed.length > 0 && !matches ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              disabled={busy}
            />
          </div>
        ) : null}
        {error ? (
          <p id={errorId} role="alert" className="pr-field__message pr-field__message--error">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

/* ── Drawer ──────────────────────────────────────────────────────────────── */

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** Small meta shown before the title, e.g. an id. */
  eyebrow?: ReactNode;
  /** Badges or status next to the title. */
  status?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: "md" | "lg";
  /** Accessible description for screen readers. */
  description?: string;
}

/** Detail without losing the list. Right side on desktop, full width on mobile. */
export function Drawer({
  open,
  onOpenChange,
  title,
  eyebrow,
  status,
  children,
  footer,
  width = "md",
  description,
}: DrawerProps) {
  const ui = useUiMessages();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="pr-scrim pr-scrim--drawer" />
        <DialogPrimitive.Content
          className={cx("pr-drawer", `pr-drawer--${width}`)}
          onOpenAutoFocus={(event) => {
            // Start reading at the top of the detail, not on its first control (which may carry a
            // tooltip or an action); Tab still reaches every control in order.
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus({ preventScroll: true });
          }}
          onEscapeKeyDown={(event) => {
            if (escapeOwnedByControl(event)) event.preventDefault();
          }}
        >
          <div className="pr-drawer__header">
            {eyebrow ? <span className="pr-drawer__eyebrow">{eyebrow}</span> : null}
            <DialogPrimitive.Title className="pr-drawer__title">{title}</DialogPrimitive.Title>
            {status}
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                className="pr-dialog__close pr-drawer__close"
                aria-label={ui.t("overlay.close")}
              >
                <Icon icon={X} size="md" />
              </button>
            </DialogPrimitive.Close>
          </div>
          <DialogPrimitive.Description className="pr-sr-only">
            {description ?? (typeof title === "string" ? title : ui.t("overlay.details"))}
          </DialogPrimitive.Description>
          <div className="pr-drawer__body">{children}</div>
          {footer ? <div className="pr-drawer__footer">{footer}</div> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
