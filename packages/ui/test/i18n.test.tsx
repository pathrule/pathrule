// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator, type DeepPartial } from "../src/i18n/core.js";
import { I18nProvider } from "../src/i18n/react.js";
import { uiMessages, type UiCatalog } from "../src/i18n/ui-messages.js";
import { CopyButton, RelativeTime } from "../src/components/data.js";
import { Pagination } from "../src/components/navigation.js";
import { UnsavedChangesBar } from "../src/patterns/states.js";
import { byRole, cleanup, render } from "./render.js";

afterEach(cleanup);

const base = {
  greeting: "Hello {name}",
  count: { one: "{count} group", other: "{count} groups" },
  nested: { only: "English only" },
} as const;

describe("createTranslator", () => {
  it("interpolates, and formats numbers for the locale", () => {
    const en = createTranslator(base);
    expect(en.t("greeting", { name: "Ada" })).toBe("Hello Ada");
    expect(en.plural("count", 1)).toBe("1 group");
    expect(en.plural("count", 1234)).toBe("1,234 groups");
    const de = createTranslator(base, { locale: "de-DE" });
    expect(de.plural("count", 1234)).toBe("1.234 groups");
  });

  it("falls back to English for a key the locale lacks, and to the key when English lacks it", () => {
    const onMissing = vi.fn();
    const overrides: DeepPartial<typeof base> = { greeting: "Merhaba {name}" };
    const tr = createTranslator(base, { locale: "tr", overrides, onMissing });
    expect(tr.t("greeting", { name: "Ada" })).toBe("Merhaba Ada");
    expect(tr.t("nested.only")).toBe("English only");
    expect(onMissing).not.toHaveBeenCalled();
    // A key nobody has: shown as itself, reported once.
    const unknown = "nested.absent" as unknown as "nested.only";
    expect(tr.t(unknown)).toBe("nested.absent");
    expect(tr.t(unknown)).toBe("nested.absent");
    expect(onMissing).toHaveBeenCalledTimes(1);
    expect(onMissing).toHaveBeenCalledWith("nested.absent");
  });

  it("keeps a placeholder it has no value for, and never throws on a bad locale", () => {
    const t = createTranslator(base, { locale: "not a locale!" });
    expect(t.locale).toBe("en");
    expect(t.t("greeting")).toBe("Hello {name}");
  });

  it("says relative time with the catalog's words and dates past 30 days", () => {
    const t = createTranslator(uiMessages);
    const now = Date.parse("2026-10-09T12:00:00Z");
    expect(t.relative("2026-10-09T11:59:50Z", now)).toBe("just now");
    expect(t.relative("2026-10-09T11:55:00Z", now)).toBe("5m ago");
    expect(t.relative("2026-10-09T09:00:00Z", now)).toBe("3h ago");
    expect(t.relative("2026-10-07T12:00:00Z", now)).toBe("2d ago");
    expect(t.relative("2026-10-09T15:00:00Z", now)).toBe("in 3h");
    expect(t.relative("2026-07-01T12:00:00Z", now)).toBe("Jul 1, 2026");
    expect(t.relative("not a time", now)).toBe("not a time");
  });
});

describe("I18nProvider", () => {
  it("leaves every component in English without a provider", () => {
    const { container } = render(
      <Pagination page={2} pageSize={10} total={1234} onPageChange={() => {}} />,
    );
    expect(container.textContent).toContain("11–20 of 1,234");
    expect(byRole(container, "button", "Next page")).toHaveLength(1);
  });

  it("applies a partial catalog and falls back to English for the rest", () => {
    const tr: UiCatalog = {
      navigation: { nextPage: "Sonraki sayfa", range: "{from}–{to} / {total}" },
      states: { unsaved: { other: "{count} kaydedilmemiş değişiklik" } },
      copy: { done: "Kopyalandı" },
    };
    const { container } = render(
      <I18nProvider locale="tr-TR" catalogs={{ ui: tr }}>
        <Pagination page={2} pageSize={10} total={1234} onPageChange={() => {}} />
        <UnsavedChangesBar count={3} onDiscard={() => {}} onSave={() => {}} />
        <CopyButton value="x" label="Copy id" text="Copy id" />
      </I18nProvider>,
    );
    // Translated, with Turkish digit grouping.
    expect(container.textContent).toContain("11–20 / 1.234");
    expect(byRole(container, "button", "Sonraki sayfa")).toHaveLength(1);
    expect(container.textContent).toContain("3 kaydedilmemiş değişiklik");
    // Not translated: English.
    expect(byRole(container, "button", "Previous page")).toHaveLength(1);
    expect(container.textContent).toContain("Discard");
  });

  it("formats relative time with the locale's catalog words", () => {
    const iso = new Date(Date.now() - 5 * 60_000).toISOString();
    const { container } = render(
      <I18nProvider locale="tr" catalogs={{ ui: { time: { minutesAgo: "{count} dk önce" } } }}>
        <RelativeTime iso={iso} />
      </I18nProvider>,
    );
    expect(container.querySelector("time")?.textContent).toBe("5 dk önce");
  });
});
