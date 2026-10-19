// SPDX-License-Identifier: Apache-2.0
// The lasting-marker table, language by language: one stated decision that is caught, one everyday
// sentence that is not, and the memory title in the person's language.
import { describe, expect, it } from "vitest";
import { LASTING_MARKERS, splitSentences } from "./lasting-markers.js";
import { statedDecisionMemory, statedDecisions } from "./stated-decisions.js";

const CASES: Array<{ lang: string; decision: string; title: string; changed?: string; changedTitle?: string; plain: string }> = [
  {
    lang: "de",
    decision: "Teamentscheidung: ab jetzt startet jede neue Go-Datei mit der Zeile `// SPDX-License-Identifier: MIT`.",
    title: "Entscheidung: Ab jetzt startet jede neue Go-Datei mit der",
    changed: "Entscheidungsänderung: neue Fehlertypen benutzen `https://errors.acme.io/` statt `https://errors.acme.dev/`.",
    changedTitle: "Geänderte Entscheidung: Neue Fehlertypen benutzen `https://errors.acme.io/`",
    plain: "Wie immer, bitte die Tests laufen lassen.",
  },
  {
    lang: "fr",
    decision: "Décision d'équipe : désormais chaque nouveau fichier source commence par la ligne `# SPDX-License-Identifier: MIT`.",
    title: "Décision: Désormais chaque nouveau fichier source commence par la ligne",
    plain: "Comme toujours, lance les tests avant de finir.",
  },
  {
    lang: "es",
    decision: "Decisión del equipo: a partir de ahora cada nuevo archivo empieza con la línea `# SPDX-License-Identifier: MIT`.",
    title: "Decisión: A partir de ahora cada nuevo archivo empieza con la línea",
    plain: "Como siempre, corre las pruebas.",
  },
  {
    lang: "pt",
    decision: "Decisão do time: daqui pra frente todo novo arquivo começa com a linha `# SPDX-License-Identifier: MIT`.",
    title: "Decisão: Daqui pra frente todo novo arquivo começa com a linha",
    plain: "Como sempre, rode os testes antes de terminar.",
  },
  {
    lang: "it",
    decision: "Decisione del team: d'ora in poi ogni nuovo file sorgente inizia con la riga `# SPDX-License-Identifier: MIT`.",
    title: "Decisione: D'ora in poi ogni nuovo file sorgente inizia con la riga",
    plain: "Come sempre, esegui i test.",
  },
  {
    lang: "tr",
    decision: "Ekip kararı: bundan sonra her yeni kaynak dosyası `# SPDX-License-Identifier: MIT` satırıyla başlar.",
    title: "Karar: Bundan sonra her yeni kaynak dosyası",
    changed: "Karar değişti: yeni hata türleri `https://errors.acme.dev/` yerine `https://errors.acme.io/` kullanır; eskiler şimdilik kalır.",
    changedTitle: "Değişen karar: Yeni hata türleri `https://errors.acme.dev/` yerine",
    plain: "Her zamanki gibi testleri çalıştır.",
  },
  {
    lang: "ja",
    decision: "チームの決定：今後は新しいソースファイルはすべて `# SPDX-License-Identifier: MIT` の行で始めてください。",
    title: "決定: 今後は新しいソースファイルはすべて `# SPDX-License-Identifier: MIT` の行で始めてください",
    plain: "いつも通りテストを実行してください。",
  },
];

describe("lasting markers across languages", () => {
  it("every language in the table has openers, lasting words, strong words and titles", () => {
    for (const lang of LASTING_MARKERS) {
      expect(lang.opener.length, lang.code).toBeGreaterThan(2);
      expect(lang.lasting.length, lang.code).toBeGreaterThan(2);
      expect(lang.strong.length, lang.code).toBeGreaterThan(3);
      expect(lang.changed.every((c) => lang.opener.includes(c) || lang.changed.includes(c)), lang.code).toBe(true);
      for (const p of [...lang.opener, ...lang.lasting, ...lang.strong, ...lang.leadIn]) expect(p, `${lang.code}: ${p}`).toBe(p.toLowerCase());
    }
  });

  for (const c of CASES) {
    it(`catches a ${c.lang} decision, titles it in ${c.lang}, and leaves an everyday sentence alone`, () => {
      const ds = statedDecisions(c.decision);
      expect(ds, c.decision).toHaveLength(1);
      expect(ds[0]!.lang).toBe(c.lang);
      expect(ds[0]!.quote).toBe(c.decision);
      expect(statedDecisionMemory(ds[0]!).title.startsWith(c.title), statedDecisionMemory(ds[0]!).title).toBe(true);
      expect(statedDecisions(c.plain)).toEqual([]);
      if (c.changed) {
        const [d] = statedDecisions(c.changed);
        expect(d?.kind).toBe("changed-decision");
        expect(statedDecisionMemory(d!).title.startsWith(c.changedTitle!), statedDecisionMemory(d!).title).toBe(true);
      }
    });
  }

  it("takes a long rule by its strong word alone, in Turkish and in Japanese", () => {
    expect(statedDecisions("Üretim veritabanına asla doğrudan migration çalıştırma, her zaman önce staging üzerinde dene.")).toHaveLength(1);
    expect(statedDecisions("本番データベースに対しては決して直接マイグレーションを実行しないでください。必ず先にステージングで試します。")).toHaveLength(1);
    expect(statedDecisions("asla olmaz")).toEqual([]);
    // "artık" alone is "now" or "already"; with a negation it is a change that lasts.
    expect(statedDecisions("genişletme ben onayladım artık hazır md formatında sadece düzelteceksen iç yazım formatını güncelle")).toEqual([]);
    expect(statedDecisions("Artık Studio electron app yok. iOS app yok.")).toHaveLength(1);
    expect(statedDecisions("Vercel, Supabase kullanmıyoruz artık cloudflare'a geçiyor tüm sistem.")).toHaveLength(1);
    expect(statedDecisions("yok artık bu kadar da olmaz")).toEqual([]);
  });

  it("settles 今後 between Japanese and Chinese by the script, and joins a bare announcement to its next sentence", () => {
    const ja = statedDecisions("今後作成するエラータイプは `https://errors.acme.dev/` ではなく `https://errors.acme.io/` を使います。既存のものは当面そのままです。");
    expect(ja.map((d) => d.lang)).toEqual(["ja"]);
    const zh = statedDecisions("今后新建的错误类型一律使用 `https://errors.acme.io/`，不再使用 `https://errors.acme.dev/`。");
    expect(zh.map((d) => d.lang)).toEqual(["zh"]);
    const en = statedDecisions("One more team decision. Errors in `cli/` stay one plain-text line on stderr with exit code 2. Then run the tests.");
    expect(en.map((d) => d.quote)).toEqual(["One more team decision. Errors in `cli/` stay one plain-text line on stderr with exit code 2."]);
  });

  it("breaks Japanese sentences at 。 and Latin ones before a capital or a quote", () => {
    expect(splitSentences("今後はAを使う。Bは使わない。")).toEqual(["今後はAを使う。", "Bは使わない。"]);
    expect(splitSentences("First one. `second` starts low. Third one! ¿Cuarta? Fifth.")).toEqual(["First one.", "`second` starts low.", "Third one!", "¿Cuarta?", "Fifth."]);
  });
});
