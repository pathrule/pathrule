// SPDX-License-Identifier: Apache-2.0
// Message catalogs without a dependency. A catalog is a nested object of strings; its English
// version is the source of truth and the type every other locale is checked against. A locale
// catalog may be partial: a key it lacks falls back to English, and a key English lacks shows
// itself (and is reported), so a missing translation never blanks the interface.
//
// Strings interpolate `{name}`; a number is formatted for the locale. A plural message is an
// object keyed by `Intl.PluralRules` categories (`one`, `other`, ...), `other` required.

export type Messages = { readonly [key: string]: string | Messages };

/** Every dotted path to a string in `T`: `"copy.done"`, `"time.minutesAgo"`. */
export type MessageKey<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${MessageKey<T[K]>}`;
}[keyof T & string];

/** Every dotted path to a plural object (one holding `other`) in `T`. */
export type PluralKey<T> = {
  [K in keyof T & string]: T[K] extends string
    ? never
    : T[K] extends { readonly other: string }
      ? K
      : `${K}.${PluralKey<T[K]>}`;
}[keyof T & string];

/** A locale's version of a catalog: any subset of its strings, same shape. */
export type DeepPartial<T> = {
  readonly [K in keyof T]?: T[K] extends string ? string : DeepPartial<T[K]>;
};

/** A catalog's shape with every string widened, for writing a locale's version of it. */
export type CatalogShape<T> = {
  readonly [K in keyof T]: T[K] extends string ? string : CatalogShape<T[K]>;
};

export type MessageVars = Readonly<Record<string, string | number>>;

export interface Translator<T extends Messages> {
  /** The BCP 47 locale strings and formats use. */
  readonly locale: string;
  t(key: MessageKey<T>, vars?: MessageVars): string;
  /** The plural form of `key` for `count`; `count` is also available as `{count}`. */
  plural(key: PluralKey<T>, count: number, vars?: MessageVars): string;
  number(value: number, options?: Intl.NumberFormatOptions): string;
  /** An ISO time as a date and time ("Oct 9, 2026, 4:05 PM"); an unparsable value as given. */
  dateTime(iso: string, options?: Intl.DateTimeFormatOptions): string;
  /** An ISO time relative to `now` ("5m ago"); older than 30 days as a date. */
  relative(iso: string, now?: number): string;
  list(items: readonly string[], type?: "conjunction" | "disjunction"): string;
}

export interface TranslatorOptions<T extends Messages> {
  /** Default `"en"`. */
  locale?: string;
  /** The locale's catalog; English fills what it lacks. */
  overrides?: DeepPartial<T>;
  /** Called once per key that English does not have either. */
  onMissing?: (key: string) => void;
}

/** The time strings a translator needs for `relative`. A type, not an interface: catalogs index it. */
export type RelativeTimeMessages = {
  readonly justNow: string;
  readonly inAMoment: string;
  readonly minutesAgo: string;
  readonly hoursAgo: string;
  readonly daysAgo: string;
  readonly inMinutes: string;
  readonly inHours: string;
  readonly inDays: string;
};

export const ENGLISH_RELATIVE_TIME: RelativeTimeMessages = {
  justNow: "just now",
  inAMoment: "in a moment",
  minutesAgo: "{count}m ago",
  hoursAgo: "{count}h ago",
  daysAgo: "{count}d ago",
  inMinutes: "in {count}m",
  inHours: "in {count}h",
  inDays: "in {count}d",
};

function lookup(catalog: unknown, key: string): unknown {
  let node: unknown = catalog;
  for (const part of key.split(".")) {
    if (node && typeof node === "object" && Object.prototype.hasOwnProperty.call(node, part)) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return node;
}

/** Locales `Intl` accepts; anything else formats as English rather than throwing. */
function supportedLocale(locale: string): string {
  try {
    return Intl.NumberFormat.supportedLocalesOf([locale]).length ? locale : "en";
  } catch {
    return "en";
  }
}

export function createTranslator<T extends Messages>(
  base: T,
  options: TranslatorOptions<T> & { relativeTime?: RelativeTimeMessages } = {},
): Translator<T> {
  const locale = supportedLocale(options.locale ?? "en");
  const overrides = options.overrides;
  const reported = new Set<string>();
  const numberFormat = new Intl.NumberFormat(locale);
  const plurals = new Intl.PluralRules(locale);
  const relativeStrings = options.relativeTime ?? ENGLISH_RELATIVE_TIME;

  const number = (value: number, opts?: Intl.NumberFormatOptions) =>
    opts ? new Intl.NumberFormat(locale, opts).format(value) : numberFormat.format(value);

  const interpolate = (template: string, vars?: MessageVars) =>
    vars
      ? template.replace(/\{(\w+)\}/g, (whole, name: string) => {
          const value = vars[name];
          if (value === undefined) return whole;
          return typeof value === "number" ? number(value) : value;
        })
      : template;

  const missing = (key: string) => {
    if (!reported.has(key)) {
      reported.add(key);
      options.onMissing?.(key);
    }
  };

  const resolve = (key: string): unknown => {
    const local = overrides ? lookup(overrides, key) : undefined;
    return local !== undefined ? local : lookup(base, key);
  };

  const t = (key: string, vars?: MessageVars) => {
    const value = resolve(key);
    if (typeof value === "string") return interpolate(value, vars);
    missing(key);
    return key;
  };

  const plural = (key: string, count: number, vars?: MessageVars) => {
    const category = plurals.select(count);
    const all = { count, ...vars };
    const local = overrides ? lookup(overrides, key) : undefined;
    for (const source of [local, lookup(base, key)]) {
      if (source && typeof source === "object") {
        const forms = source as Record<string, unknown>;
        const form = forms[category] ?? forms.other;
        if (typeof form === "string") return interpolate(form, all);
      }
    }
    missing(key);
    return key;
  };

  const dateTime = (iso: string, opts?: Intl.DateTimeFormatOptions) => {
    const time = Date.parse(iso);
    if (!Number.isFinite(time)) return iso;
    return new Date(time).toLocaleString(
      locale,
      opts ?? { dateStyle: "medium", timeStyle: "short" },
    );
  };

  const relative = (iso: string, now: number = Date.now()) => {
    const time = Date.parse(iso);
    if (!Number.isFinite(time)) return iso;
    const seconds = Math.round((now - time) / 1000);
    const future = seconds < 0;
    const abs = Math.abs(seconds);
    const say = (template: string, count: number) => interpolate(template, { count });
    if (abs < 45) return future ? relativeStrings.inAMoment : relativeStrings.justNow;
    if (abs < 3600)
      return say(
        future ? relativeStrings.inMinutes : relativeStrings.minutesAgo,
        Math.round(abs / 60),
      );
    if (abs < 86_400)
      return say(
        future ? relativeStrings.inHours : relativeStrings.hoursAgo,
        Math.round(abs / 3600),
      );
    if (abs < 86_400 * 30)
      return say(
        future ? relativeStrings.inDays : relativeStrings.daysAgo,
        Math.round(abs / 86_400),
      );
    return new Date(time).toLocaleDateString(locale, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const list = (items: readonly string[], type: "conjunction" | "disjunction" = "conjunction") => {
    try {
      return new Intl.ListFormat(locale, { type }).format(items);
    } catch {
      return items.join(", ");
    }
  };

  return {
    locale,
    t: t as Translator<T>["t"],
    plural: plural as Translator<T>["plural"],
    number,
    dateTime,
    relative,
    list,
  };
}
