// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  LEXICAL_SEM_MIN,
  LEXICAL_TO_VECTOR_KNOTS,
  buildLexicalIndex,
  cosineNeighbours,
  cslsNeighbourLists,
  knotScale,
  lexicalNeighbourLists,
  quantileScale,
  queryScores,
  tokenize,
  type LexicalDocument,
} from "./lexical.js";

describe("tokenize", () => {
  it("keeps letter and digit runs, lowercases per letter, drops pure numbers", () => {
    expect(tokenize("Turn-stall watchdog: 120s timeout, v2 API!")).toEqual(["turn-stall", "watchdog", "120s", "timeout", "v2", "api"]);
    expect(tokenize("2026 10 01")).toEqual([]);
  });

  it("treats every script with spaces the same way (no language list)", () => {
    expect(tokenize("Çakışma İzlemesi")).toEqual(["çakışma", "i̇zlemesi"]);
    expect(tokenize("Конфликт обнаружен")).toEqual(["конфликт", "обнаружен"]);
    expect(tokenize("संघर्ष मिला")).toEqual(["संघर्ष", "मिला"]);
  });

  it("indexes scripts written without spaces as character pairs", () => {
    expect(tokenize("設計規範")).toEqual(["設計", "計規", "規範"]);
    expect(tokenize("API設計")).toEqual(["api", "設計"]);
    expect(tokenize("字")).toEqual(["字"]);
  });

  it("folds compatibility forms (NFKC)", () => {
    expect(tokenize("ＡＰＩ")).toEqual(["api"]);
  });
});

function docs(entries: Array<[string, string, string]>): LexicalDocument[] {
  return entries.map(([id, title, text]) => ({ id, title, text }));
}

describe("buildLexicalIndex", () => {
  it("drops terms that appear in more than 40% of documents, in any language", () => {
    const index = buildLexicalIndex(
      docs([
        ["a", "x", "common alpha"],
        ["b", "y", "common beta"],
        ["c", "z", "common gamma"],
        ["d", "w", "delta"],
      ]),
    );
    expect(index.idf.has("common")).toBe(false);
    expect(index.idf.has("alpha")).toBe(true);
  });

  it("is independent of input order", () => {
    const entries: Array<[string, string, string]> = [
      ["b", "Release train", "desktop notarization signing"],
      ["a", "Release notes", "desktop changelog"],
      ["c", "Design canvas", "layers frames"],
    ];
    const forward = buildLexicalIndex(docs(entries));
    const reverse = buildLexicalIndex(docs([...entries].reverse()));
    expect([...forward.vectors.entries()].map(([id, v]) => [id, [...v.entries()]])).toEqual(
      [...reverse.vectors.entries()].map(([id, v]) => [id, [...v.entries()]]),
    );
  });
});

// The same three-document case in four languages: two documents share a topic, one does not.
// The rule "every language or none" asks for identical outcomes.
const CASES: Record<string, Array<[string, string, string]>> = {
  english: [
    ["p", "Payment retry", "the payment gateway retries a failed charge three times"],
    ["q", "Payment gateway outage", "when the payment gateway fails the charge retries later"],
    ["r", "Font loading", "the editor loads custom fonts before rendering text"],
    ["s", "Filler one", "unrelated notes about weather"],
    ["t", "Filler two", "unrelated notes about lunch"],
  ],
  turkish: [
    ["p", "Ödeme yeniden deneme", "ödeme ağ geçidi başarısız tahsilatı üç kez yeniden dener"],
    ["q", "Ödeme ağ geçidi kesintisi", "ödeme ağ geçidi başarısız olunca tahsilat sonra yeniden denenir"],
    ["r", "Yazı tipi yükleme", "düzenleyici metni çizmeden önce özel yazı tiplerini yükler"],
    ["s", "Dolgu bir", "hava durumu hakkında ilgisiz notlar"],
    ["t", "Dolgu iki", "öğle yemeği hakkında ilgisiz notlar"],
  ],
  japanese: [
    ["p", "決済の再試行", "決済ゲートウェイは失敗した請求を三回再試行する"],
    ["q", "決済ゲートウェイ障害", "決済ゲートウェイが失敗すると請求は後で再試行される"],
    ["r", "フォント読み込み", "エディタは描画前にカスタムフォントを読み込む"],
    ["s", "雑記一", "天気についての無関係なメモ"],
    ["t", "雑記二", "昼食についての無関係なメモ"],
  ],
  hindi: [
    ["p", "भुगतान पुनः प्रयास", "भुगतान गेटवे विफल शुल्क को तीन बार पुनः प्रयास करता है"],
    ["q", "भुगतान गेटवे बाधा", "जब भुगतान गेटवे विफल होता है तो शुल्क बाद में पुनः प्रयास होता है"],
    ["r", "फ़ॉन्ट लोडिंग", "संपादक पाठ बनाने से पहले कस्टम फ़ॉन्ट लोड करता है"],
    ["s", "भराव एक", "मौसम के बारे में असंबंधित नोट्स"],
    ["t", "भराव दो", "दोपहर के भोजन के बारे में असंबंधित नोट्स"],
  ],
};

describe("language parity", () => {
  it("finds the same nearest neighbour for the same case in every language", () => {
    const outcomes = Object.fromEntries(
      Object.entries(CASES).map(([language, entries]) => {
        const index = buildLexicalIndex(docs(entries));
        const all = new Set(entries.map(([id]) => id));
        return [language, { p: cosineNeighbours(index, "p", all)[0]?.[0], q: cosineNeighbours(index, "q", all)[0]?.[0] }];
      }),
    );
    for (const outcome of Object.values(outcomes)) expect(outcome).toEqual({ p: "q", q: "p" });
  });
});

describe("cslsNeighbourLists", () => {
  it("rescores every cosine as 2 * cos - r_i - r_j, r the mean of the top 10 cosines (D8)", () => {
    const entries: Array<[string, string, string]> = [
      ["a", "payment retry", "gateway charge"],
      ["b", "payment gateway", "outage charge"],
      ["c", "font loading", "editor glyph"],
      ["d", "font cache", "editor eviction"],
      ["e", "release signing", "notarization"],
      ["f", "release train", "desktop"],
      ["g", "theme tokens", "density"],
    ];
    const index = buildLexicalIndex(docs(entries));
    const ids = entries.map(([id]) => id);
    const pool = new Set(ids);
    const cosine = new Map(ids.map((id) => [id, cosineNeighbours(index, id, pool)]));
    const r = new Map(ids.map((id) => {
      const top = cosine.get(id)!.slice(0, 10);
      return [id, top.length ? top.reduce((sum, [, s]) => sum + s, 0) / top.length : 0];
    }));
    const csls = cslsNeighbourLists(index, ids);
    let checked = 0;
    for (const id of ids) {
      for (const [other, score] of csls.get(id)!) {
        const cos = cosine.get(id)!.find(([o]) => o === other)![1];
        expect(score).toBeCloseTo(2 * cos - r.get(id)! - r.get(other)!, 12);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("ranks ties by id so every surface gets the same list", () => {
    const entries: Array<[string, string, string]> = [
      ["b", "shared topic", "x1"],
      ["c", "shared topic", "x2"],
      ["a", "shared topic", "x3"],
      ["d", "other one", "x4"],
      ["e", "else two", "x5"],
      ["f", "more three", "x6"],
      ["g", "rest four", "x7"],
      ["h", "last five", "x8"],
    ];
    const index = buildLexicalIndex(docs(entries));
    const lists = cslsNeighbourLists(index, entries.map(([id]) => id));
    expect(lists.get("a")!.slice(0, 2).map(([id]) => id)).toEqual(["b", "c"]);
  });

  it("keeps only the best entries when asked, the same ones the full lists start with", () => {
    const index = buildLexicalIndex(docs(CASES.english!));
    const ids = CASES.english!.map(([id]) => id);
    const full = lexicalNeighbourLists(index, ids);
    const kept = lexicalNeighbourLists(index, ids, 2);
    for (const id of ids) expect(kept.get(id)).toEqual(full.get(id)!.slice(0, 2));
  });
});

describe("queryScores", () => {
  it("ranks documents by how well they match a free-text query", () => {
    const index = buildLexicalIndex(docs(CASES.english!));
    expect(queryScores(index, "payment gateway")[0]?.[0]).toMatch(/^[pq]$/);
  });
});

describe("calibration", () => {
  it("quantile matching maps a lexical rank onto the same vector rank", () => {
    const scale = quantileScale([0.1, 0.2, 0.3, 0.4], [0.5, 0.6, 0.7, 0.8]);
    expect(scale(0.05)).toBe(0.5);
    expect(scale(0.3)).toBe(0.7);
    expect(scale(9)).toBe(0.8);
  });

  it("the knot table is monotone, clamps at both ends and puts the floor at 0.60", () => {
    for (let i = 1; i < LEXICAL_TO_VECTOR_KNOTS.length; i++) {
      expect(LEXICAL_TO_VECTOR_KNOTS[i]![0]).toBeGreaterThanOrEqual(LEXICAL_TO_VECTOR_KNOTS[i - 1]![0]);
      expect(LEXICAL_TO_VECTOR_KNOTS[i]![1]).toBeGreaterThanOrEqual(LEXICAL_TO_VECTOR_KNOTS[i - 1]![1]);
    }
    expect(knotScale(-5)).toBe(LEXICAL_TO_VECTOR_KNOTS[0]![1]);
    expect(knotScale(5)).toBe(0.9624);
    expect(knotScale(0.03)).toBeLessThan(0.6);
    expect(knotScale(LEXICAL_SEM_MIN)).toBeCloseTo(0.6, 1);
  });
});
