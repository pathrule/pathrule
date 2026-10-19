// SPDX-License-Identifier: Apache-2.0
// Foundation pages: color, typography, localization and the token reference.
import { useState } from "react";
import {
  Badge,
  Card,
  CopyButton,
  Pagination,
  RelativeTime,
  SegmentedControl,
} from "../src/index.js";
import { colors, typography } from "../src/tokens/index.js";
import { VerificationBadge } from "../src/signals/index.js";
import { I18nProvider, type UiCatalog } from "../src/i18n/index.js";
import type { SignalsCatalog } from "../src/signals/messages.js";
import { Row, type Entry } from "./registry-entry.js";

function luminance(hex: string): number {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
function ratio(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const hexOf = (cssVar: string, theme: "dark" | "light") =>
  colors.find((c) => c.cssVar === cssVar)?.[theme] ?? "#000000";

function ColorPage() {
  const pairs: Array<[string, string, string]> = [
    ["--pr-fg-1", "--pr-bg", "Primary text on canvas"],
    ["--pr-fg-3", "--pr-bg-1", "Description on surface"],
    ["--pr-fg-4", "--pr-bg-1", "Meta on surface"],
    ["--pr-accent-fg", "--pr-accent", "Label on primary"],
    ["--pr-accent-text", "--pr-accent-soft", "Verified on soft"],
    ["--pr-warn", "--pr-warn-soft", "Hypothesis"],
    ["--pr-danger", "--pr-danger-soft", "Error"],
    ["--pr-info", "--pr-info-soft", "Observing"],
  ];
  const groups = ["surface", "border", "text", "accent", "status", "inverse"] as const;
  return (
    <div className="pr-stack pr-stack--5" style={{ width: "100%" }}>
      {groups.map((group) => (
        <div key={group} className="pr-stack pr-stack--2">
          <span className="pr-section-label">{group}</span>
          <div className="pg-swatches">
            {colors
              .filter((c) => c.group === group)
              .map((c) => (
                <div key={c.cssVar} className="pg-swatch-card">
                  <span
                    className="pg-swatch-card__color"
                    style={{ background: `var(${c.cssVar})` }}
                  />
                  <span className="pr-mono">{c.cssVar}</span>
                  <span className="pr-note">{c.role}</span>
                </div>
              ))}
          </div>
        </div>
      ))}
      <div className="pg-table-scroll">
        <table className="pg-token-table">
          <thead>
            <tr>
              <th>pair</th>
              <th>use</th>
              <th>dark</th>
              <th>light</th>
            </tr>
          </thead>
          <tbody>
            {pairs.map(([fg, bg, use]) => (
              <tr key={use}>
                <td className="pr-mono">
                  {fg} on {bg}
                </td>
                <td>{use}</td>
                {(["dark", "light"] as const).map((t) => {
                  const r = ratio(hexOf(fg, t), hexOf(bg, t));
                  return (
                    <td key={t} className="pr-mono">
                      {r.toFixed(2)}{" "}
                      <Badge size="sm" tone={r >= 4.5 ? "accent" : "warning"}>
                        {r >= 7 ? "AAA" : r >= 4.5 ? "AA" : "fail"}
                      </Badge>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** An example partial catalog: only these strings change; everything else falls back to English. */
const EXAMPLE_UI_CATALOG: UiCatalog = {
  navigation: {
    nextPage: "Sonraki sayfa",
    previousPage: "Önceki sayfa",
    range: "{from}–{to} / {total}",
  },
  copy: { done: "Kopyalandı", button: "Kopyala" },
  time: { minutesAgo: "{count} dk önce", hoursAgo: "{count} sa önce", daysAgo: "{count} gün önce" },
};
const EXAMPLE_SIGNALS_CATALOG: SignalsCatalog = {
  verification: { label: { observing: "Gözlemleniyor", recurred: "Tekrarladı" } },
};

function I18nDemo() {
  const [locale, setLocale] = useState<"en" | "tr">("tr");
  return (
    <div className="pr-stack pr-stack--4" style={{ width: "100%" }}>
      <Row>
        <SegmentedControl
          label="Example locale"
          size="sm"
          value={locale}
          onValueChange={setLocale}
          options={[
            { value: "en", label: "English (source)" },
            { value: "tr", label: "Partial example catalog" },
          ]}
        />
        <Badge tone="warning" variant="outline" size="sm">
          example catalog, not a shipped translation
        </Badge>
      </Row>
      <I18nProvider
        locale={locale}
        catalogs={
          locale === "tr" ? { ui: EXAMPLE_UI_CATALOG, signals: EXAMPLE_SIGNALS_CATALOG } : {}
        }
      >
        <Card padded>
          <div className="pr-stack pr-stack--3">
            <Pagination page={2} pageSize={20} total={1284} onPageChange={() => {}} />
            <Row>
              <VerificationBadge state="observing" />
              <VerificationBadge state="recurred" />
              <VerificationBadge state="quiet" />
              <RelativeTime iso={new Date(Date.now() - 7 * 60_000).toISOString()} />
              <CopyButton value="example" label="Copy example" text="Copy" />
            </Row>
          </div>
        </Card>
      </I18nProvider>
    </div>
  );
}

export const FOUNDATION_ENTRIES: Entry[] = [
  {
    id: "colors",
    category: "foundations",
    name: "Color",
    kind: "foundation",
    description:
      "Two themes, one semantic layer. Components reference roles, never raw hex. Neutrals carry a faint green cast from the accent, so the system reads as one material.",
    dos: [
      "Reach for a role (--pr-fg-3, --pr-line-2) before a value.",
      "Reserve accent for primary action and verified knowledge.",
      "Pair every status color with an icon or a word.",
    ],
    donts: [
      "Don't tint whole surfaces with status colors.",
      "Don't use accent for observations, hypotheses or runtime data.",
      "Don't introduce gradients; depth comes from surface steps and hairlines.",
    ],
    a11y: "Every text role passes 4.5:1 on canvas and surface in both themes; the table below is computed from the tokens.",
    render: () => <ColorPage />,
  },
  {
    id: "type",
    category: "foundations",
    name: "Typography",
    kind: "foundation",
    description:
      "Geist for the interface; a mono face for anything a developer could paste: paths, ids, commands, keys and timestamps in meta. Mono is a semantic signal, not decoration.",
    dos: [
      "Tabular numerals for numbers in columns.",
      "Lowercase mono captions for meta.",
      "Headings at weight 500 with negative tracking.",
    ],
    donts: ["Don't set body copy in mono.", "Don't go below 11px for mono or 12px for sans."],
    a11y: "Sizes are rem, so a person's font-size setting scales the interface. Body line height is at least 1.45.",
    render: () => (
      <div className="pr-stack pr-stack--3" style={{ width: "100%" }}>
        {Object.entries(typography).map(([name, style]) => (
          <div key={name} className="pg-type-row">
            <span className="pr-text-caption-mono">
              text.{name} · {style.size}/{style.lineHeight}
            </span>
            <span className={`pr-text-${name}`}>
              {name === "code"
                ? "const res = await api.get('/orders')"
                : name === "caption-mono"
                  ? "learned · 2d · claude-code"
                  : name === "numeric"
                    ? "12,408   1,092   98.2%"
                    : "Pathrule delivers scoped knowledge"}
            </span>
          </div>
        ))}
      </div>
    ),
  },
];

// Exported one by one: the registry lists these two after the signals pages.
export const LOCALIZATION_ENTRY: Entry = {
  id: "i18n",
  category: "foundations",
  name: "Localization",
  kind: "foundation",
  from: "@pathrule/ui",
  imports: "I18nProvider, useMessages, createTranslator, type UiCatalog",
  description:
    "Catalogs are nested English objects; a locale catalog may translate any subset and English fills the rest. `{name}` interpolates and formats numbers for the locale; plurals use Intl.PluralRules; dates and relative time follow the locale. No dependency.",
  props: [
    { name: "locale", type: "string", default: '"en"', description: "BCP 47 tag." },
    {
      name: "catalogs",
      type: "Record<namespace, DeepPartial<catalog>>",
      description: '"ui", "signals" and each app\'s own namespace.',
    },
    {
      name: "onMissing",
      type: "(namespace, key) => void",
      description: "A key neither the locale nor English has; wire to a dev warning.",
    },
  ],
  dos: [
    "Keep English as the source catalog and the default.",
    "Pick a locale only when its catalog ships, so words and formats agree.",
  ],
  donts: [
    "Don't build sentences by concatenating translated fragments.",
    "Don't translate agent briefs: they are input for a coding agent.",
  ],
  a11y: "Accessible names come from the same catalogs as visible text.",
  render: () => <I18nDemo />,
};

export const TOKENS_ENTRY: Entry = {
  id: "tokens",
  category: "handoff",
  name: "Token reference",
  kind: "foundation",
  imports: "colors, typography, space, radius, motion, density",
  from: "@pathrule/ui/tokens",
  description:
    "Every color role with its CSS variable, token path and both theme values. One source (src/tokens/tokens.ts) generates tokens.css.",
  render: () => (
    <div className="pg-table-scroll">
      <table className="pg-token-table">
        <thead>
          <tr>
            <th>variable</th>
            <th>token</th>
            <th>role</th>
            <th>dark</th>
            <th>light</th>
          </tr>
        </thead>
        <tbody>
          {colors.map((c) => (
            <tr key={c.cssVar}>
              <td className="pr-mono">{c.cssVar}</td>
              <td className="pr-mono pr-meta">{c.path}</td>
              <td>{c.role}</td>
              <td className="pr-mono">
                <span className="pg-swatch" style={{ background: c.dark }} /> {c.dark}
              </td>
              <td className="pr-mono">
                <span className="pg-swatch" style={{ background: c.light }} /> {c.light}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ),
};
