// SPDX-License-Identifier: Apache-2.0
import { CircleAlert, CircleCheck, Info, LoaderCircle, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cx } from "../lib/cx.js";
import { Icon } from "../lib/icon.js";
import { useUiMessages } from "../i18n/ui-messages.js";

export type ToastTone = "success" | "error" | "info" | "loading";

export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Undo keeps the toast at least 8 s. */
  undo?: () => void;
  undoLabel?: string;
  /** ms; loading toasts stay until updated or dismissed. */
  duration?: number;
}

interface ToastEntry extends ToastInput {
  id: number;
}

export interface ToastApi {
  show(input: ToastInput): number;
  update(id: number, input: ToastInput): void;
  dismiss(id: number): void;
}

const ToastContext = createContext<ToastApi | null>(null);

const MAX_VISIBLE = 3;

export function ToastProvider({ children }: { children: ReactNode }) {
  const ui = useUiMessages();
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const paused = useRef(false);

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((list) => list.filter((toast) => toast.id !== id));
  }, []);

  const schedule = useCallback(
    (entry: ToastEntry) => {
      const existing = timers.current.get(entry.id);
      if (existing) clearTimeout(existing);
      if (entry.tone === "loading") return;
      const base = entry.duration ?? 4200;
      const ms = entry.undo ? Math.max(8000, base) : base;
      const tick = () => {
        if (paused.current) {
          timers.current.set(entry.id, setTimeout(tick, 1000));
          return;
        }
        dismiss(entry.id);
      };
      timers.current.set(entry.id, setTimeout(tick, ms));
    },
    [dismiss],
  );

  const show = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      const entry: ToastEntry = { tone: "success", ...input, id };
      setToasts((list) => [...list, entry].slice(-MAX_VISIBLE));
      schedule(entry);
      return id;
    },
    [schedule],
  );

  const update = useCallback(
    (id: number, input: ToastInput) => {
      const entry: ToastEntry = { tone: "success", ...input, id };
      setToasts((list) => list.map((toast) => (toast.id === id ? entry : toast)));
      schedule(entry);
    },
    [schedule],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) clearTimeout(timer);
      map.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(() => ({ show, update, dismiss }), [show, update, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <section
        className="pr-toasts"
        aria-label={ui.t("toast.region")}
        onMouseEnter={() => (paused.current = true)}
        onMouseLeave={() => (paused.current = false)}
        onFocus={() => (paused.current = true)}
        onBlur={() => (paused.current = false)}
      >
        <ol aria-live="polite" aria-relevant="additions text" className="pr-toasts__list">
          {toasts.map((toast) => (
            <li
              key={toast.id}
              className={cx("pr-toast", `pr-toast--${toast.tone ?? "success"}`)}
              role={toast.tone === "error" ? "alert" : "status"}
            >
              <span className="pr-toast__icon">
                <Icon
                  icon={
                    toast.tone === "error"
                      ? CircleAlert
                      : toast.tone === "loading"
                        ? LoaderCircle
                        : toast.tone === "info"
                          ? Info
                          : CircleCheck
                  }
                  size="md"
                  className={toast.tone === "loading" ? "pr-spin" : undefined}
                />
              </span>
              <span className="pr-toast__text">
                <span className="pr-toast__title">{toast.title}</span>
                {toast.description ? (
                  <span className="pr-toast__description">{toast.description}</span>
                ) : null}
              </span>
              {toast.undo ? (
                <button
                  type="button"
                  className="pr-toast__action"
                  onClick={() => {
                    toast.undo?.();
                    dismiss(toast.id);
                  }}
                >
                  {toast.undoLabel ?? ui.t("toast.undo")}
                </button>
              ) : null}
              <button
                type="button"
                className="pr-toast__close"
                aria-label={ui.t("toast.dismiss")}
                onClick={() => dismiss(toast.id)}
              >
                <Icon icon={X} size="sm" />
              </button>
            </li>
          ))}
        </ol>
      </section>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside <ToastProvider>");
  return api;
}
