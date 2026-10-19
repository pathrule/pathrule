// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  ENGLISH_RELATIVE_TIME,
  createTranslator,
  type DeepPartial,
  type Messages,
  type RelativeTimeMessages,
  type Translator,
} from "./core.js";

interface I18nContextValue {
  locale: string;
  catalogs: Readonly<Record<string, Messages | undefined>>;
  relativeTime: RelativeTimeMessages;
  onMissing?: (namespace: string, key: string) => void;
}

const I18nContext = createContext<I18nContextValue>({
  locale: "en",
  catalogs: {},
  relativeTime: ENGLISH_RELATIVE_TIME,
});

export interface I18nProviderProps {
  /** BCP 47 locale. Default `"en"`. */
  locale?: string;
  /**
   * The locale's catalogs by namespace (`"ui"`, `"signals"` and the app's own), each any subset
   * of the English catalog it translates. Missing strings fall back to English.
   */
  catalogs?: Readonly<Record<string, Messages | undefined>>;
  /** Reports a key that neither the locale nor English has; wire to a dev warning. */
  onMissing?: (namespace: string, key: string) => void;
  children: ReactNode;
}

/**
 * The locale for everything below it. Without a provider every component speaks English, so the
 * library works unconfigured.
 */
export function I18nProvider({ locale = "en", catalogs, onMissing, children }: I18nProviderProps) {
  const value = useMemo<I18nContextValue>(() => {
    const time = (catalogs?.ui as { time?: Partial<RelativeTimeMessages> } | undefined)?.time;
    const relativeTime = { ...ENGLISH_RELATIVE_TIME };
    for (const key of Object.keys(relativeTime) as Array<keyof RelativeTimeMessages>) {
      const local = time?.[key];
      if (typeof local === "string") relativeTime[key] = local;
    }
    return { locale, catalogs: catalogs ?? {}, relativeTime, onMissing };
  }, [locale, catalogs, onMissing]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useLocale(): string {
  return useContext(I18nContext).locale;
}

/**
 * A translator for one namespace: `base` is its English catalog, the provider supplies the
 * locale's version. Stable while the locale and catalogs are.
 */
export function useMessages<T extends Messages>(namespace: string, base: T): Translator<T> {
  const ctx = useContext(I18nContext);
  return useMemo(
    () =>
      createTranslator(base, {
        locale: ctx.locale,
        overrides: ctx.catalogs[namespace] as DeepPartial<T> | undefined,
        relativeTime: ctx.relativeTime,
        onMissing: ctx.onMissing ? (key) => ctx.onMissing?.(namespace, key) : undefined,
      }),
    [ctx, namespace, base],
  );
}
