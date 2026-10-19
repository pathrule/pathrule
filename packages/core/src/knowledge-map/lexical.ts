// SPDX-License-Identifier: Apache-2.0
//
// Lexical similarity for the knowledge map, language-neutral by construction.
//
// Knowledge is written in whatever language the team writes, so nothing here holds a word
// list in any language (see the "No single-language special-casing" rule). Tokens are runs
// of Unicode letters and digits, lowercased per letter after NFKC. Words common enough to
// carry no topic are dropped by document frequency learned from the workspace itself, which
// works the same in every language. Scripts written without spaces between words (Han,
// Hiragana, Katakana, Thai, Lao, Khmer, Myanmar) have no word runs to split on, so those
// runs index as overlapping character pairs: a property of the letters, not of a language.
//
// Scores are TF-IDF cosines, `(1 + ln tf) * ln(N / df)` over L2-normalized vectors, rescored
// with CSLS (cross-domain similarity local scaling, k = 10): a long document is close to
// everything, so subtracting each side's mean similarity to its own nearest neighbours stops
// it from becoming everyone's neighbour. Measured in the knowledge-map calibration benchmark (plan D8):
// BM25 made the worst top-6 in-degree 84, plain TF-IDF 55, TF-IDF + CSLS 23.

export const LEXICAL_MAX_DF = 0.4;
export const CSLS_K = 10;
export const TITLE_REPEAT = 3;

const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}_-]*/gu;
const NO_SPACE_LETTER =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const MARK = /\p{M}/u;
const DIGITS = /^\p{N}+$/u;

function pushNoSpaceRun(units: string[], out: string[]): void {
  if (units.length === 1) out.push(units[0]!);
  for (let i = 1; i < units.length; i++) out.push(units[i - 1]! + units[i]!);
}

/** Tokens of a text: lowercased letter/digit runs, character pairs for scripts without spaces. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const match of text.normalize("NFKC").toLowerCase().matchAll(WORD)) {
    const word = match[0].replace(/^[-_]+|[-_]+$/g, "");
    if (!word || DIGITS.test(word)) continue;
    if (!NO_SPACE_LETTER.test(word)) {
      out.push(word);
      continue;
    }
    // Mixed or no-space word: spaced runs stay whole, no-space runs become pairs of units
    // (a base letter plus the marks that follow it).
    let spaced = "";
    let units: string[] = [];
    const flushSpaced = (): void => {
      const run = spaced.replace(/^[-_]+|[-_]+$/g, "");
      if (run && !DIGITS.test(run)) out.push(run);
      spaced = "";
    };
    for (const char of word) {
      if (MARK.test(char)) {
        if (units.length > 0) units[units.length - 1] += char;
        else spaced += char;
      } else if (NO_SPACE_LETTER.test(char)) {
        flushSpaced();
        units.push(char);
      } else {
        if (units.length > 0) {
          pushNoSpaceRun(units, out);
          units = [];
        }
        spaced += char;
      }
    }
    flushSpaced();
    if (units.length > 0) pushNoSpaceRun(units, out);
  }
  return out;
}

export interface LexicalDocument {
  id: string;
  title: string;
  /** Description and body, already joined. */
  text: string;
}

export interface LexicalIndex {
  /** id -> term -> weight, L2-normalized; ids and terms in sorted insertion order. */
  vectors: Map<string, Map<string, number>>;
  /** term -> [id, weight] postings. */
  postings: Map<string, Array<[string, number]>>;
  /** term -> ln(N / df), for terms that survived the document-frequency cut. */
  idf: Map<string, number>;
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function buildLexicalIndex(documents: readonly LexicalDocument[]): LexicalIndex {
  const docs = [...documents].sort((a, b) => byId(a.id, b.id));
  // Term counts, not token lists: a workspace's text is held once, in its documents.
  const countsOf = new Map<string, Map<string, number>>();
  const df = new Map<string, number>();
  for (const doc of docs) {
    const counts = new Map<string, number>();
    for (const term of tokenize(doc.title)) counts.set(term, (counts.get(term) ?? 0) + TITLE_REPEAT);
    for (const term of tokenize(doc.text)) counts.set(term, (counts.get(term) ?? 0) + 1);
    countsOf.set(doc.id, counts);
    for (const term of counts.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const n = docs.length;
  const idf = new Map<string, number>();
  for (const [term, count] of [...df.entries()].sort((a, b) => byId(a[0], b[0]))) {
    if (count / n <= LEXICAL_MAX_DF) idf.set(term, Math.log(n / count));
  }
  const vectors = new Map<string, Map<string, number>>();
  const postings = new Map<string, Array<[string, number]>>();
  for (const doc of docs) {
    const tf = [...countsOf.get(doc.id)!].filter(([term]) => idf.has(term));
    countsOf.delete(doc.id);
    const raw = tf.sort((a, b) => byId(a[0], b[0])).map(([term, count]) => [term, (1 + Math.log(count)) * idf.get(term)!] as const);
    const norm = Math.sqrt(raw.reduce((sum, [, w]) => sum + w * w, 0)) || 1;
    const vector = new Map<string, number>();
    for (const [term, w] of raw) {
      const weight = w / norm;
      vector.set(term, weight);
      let list = postings.get(term);
      if (!list) postings.set(term, (list = []));
      list.push([doc.id, weight]);
    }
    vectors.set(doc.id, vector);
  }
  return { vectors, postings, idf };
}

export type ScoredNeighbour = [id: string, score: number];

const byScore = (a: ScoredNeighbour, b: ScoredNeighbour): number => b[1] - a[1] || byId(a[0], b[0]);

/** Every non-zero cosine neighbour of `id` inside `pool`, best first, ties by id. */
export function cosineNeighbours(index: LexicalIndex, id: string, pool: ReadonlySet<string>): ScoredNeighbour[] {
  const acc = new Map<string, number>();
  for (const [term, x] of index.vectors.get(id) ?? []) {
    for (const [other, y] of index.postings.get(term) ?? []) {
      if (other !== id && pool.has(other)) acc.set(other, (acc.get(other) ?? 0) + x * y);
    }
  }
  return [...acc.entries()].sort(byScore);
}

export interface LexicalNeighbour {
  id: string;
  /** Hub-corrected rank score: 2 * cosine - r_i - r_j. Relative, can be negative. */
  csls: number;
  /** The plain cosine: how alike the two texts are, independent of their neighbourhoods. */
  cosine: number;
}

/**
 * Neighbour lists for every id in `pool`, ranked by CSLS (D8), ties by id. CSLS decides WHICH
 * neighbours an item gets; the cosine says HOW alike they are. CSLS alone cannot do both: three
 * identical texts with no other neighbours score CSLS 0, the same as two unrelated texts in a
 * crowded neighbourhood.
 *
 * `keep` cuts each list to its best entries. Rows are computed twice instead of held, over integer
 * postings, so memory grows with the pool times `keep`, not with its square, and a Worker's 128 MB
 * and 30 s hold a few thousand items. The sums run in cosineNeighbours' order: same numbers.
 */
export function lexicalNeighbourLists(
  index: LexicalIndex,
  pool: readonly string[],
  keep = Number.POSITIVE_INFINITY,
): Map<string, LexicalNeighbour[]> {
  const ids = [...new Set(pool)].sort(byId);
  const n = ids.length;
  const position = new Map(ids.map((id, i) => [id, i]));
  const postings = new Map<string, { at: Int32Array; weight: Float64Array }>();
  for (const [term, list] of index.postings) {
    const inPool = list.filter(([other]) => position.has(other));
    if (inPool.length < 2) continue;
    postings.set(term, {
      at: Int32Array.from(inPool, ([other]) => position.get(other)!),
      weight: Float64Array.from(inPool, ([, y]) => y),
    });
  }
  const cosine = new Float64Array(n);
  const touched = new Int32Array(n);
  let count = 0;
  // Fills `cosine` and `touched` with row i; ids are sorted, so the pool order breaks ties by id.
  const row = (i: number): void => {
    for (let t = 0; t < count; t++) cosine[touched[t]!] = 0;
    count = 0;
    for (const [term, x] of index.vectors.get(ids[i]!) ?? []) {
      const list = postings.get(term);
      if (!list) continue;
      for (let k = 0; k < list.at.length; k++) {
        const j = list.at[k]!;
        if (j === i) continue;
        if (cosine[j] === 0) touched[count++] = j;
        cosine[j] = cosine[j]! + x * list.weight[k]!;
      }
    }
  };
  const meanTop = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    row(i);
    const top = best(touched, count, cosine, CSLS_K);
    meanTop[i] = top.length ? top.reduce((sum, j) => sum + cosine[j]!, 0) / top.length : 0;
  }
  const csls = new Float64Array(n);
  const out = new Map<string, LexicalNeighbour[]>();
  for (let i = 0; i < n; i++) {
    row(i);
    for (let t = 0; t < count; t++) {
      const j = touched[t]!;
      csls[j] = 2 * cosine[j]! - meanTop[i]! - meanTop[j]!;
    }
    out.set(
      ids[i]!,
      best(touched, count, csls, keep).map((j): LexicalNeighbour => ({ id: ids[j]!, csls: csls[j]!, cosine: cosine[j]! })),
    );
  }
  return out;
}

/** The `limit` best of the first `count` positions by `score`, best first, ties by position. */
function best(positions: Int32Array, count: number, score: Float64Array, limit: number): number[] {
  const before = (a: number, b: number): boolean => score[a]! > score[b]! || (score[a] === score[b] && a < b);
  if (limit >= count) return Array.from(positions.subarray(0, count)).sort((a, b) => score[b]! - score[a]! || a - b);
  const out: number[] = [];
  for (let t = 0; t < count; t++) {
    const j = positions[t]!;
    if (out.length === limit && !before(j, out[limit - 1]!)) continue;
    let at = Math.min(out.length, limit - 1);
    while (at > 0 && before(j, out[at - 1]!)) at--;
    if (out.length === limit) out.pop();
    out.splice(at, 0, j);
  }
  return out;
}

/** CSLS-rescored neighbour lists for every id in `pool` (D8), best first, ties by id. */
export function cslsNeighbourLists(index: LexicalIndex, pool: readonly string[]): Map<string, ScoredNeighbour[]> {
  const out = new Map<string, ScoredNeighbour[]>();
  for (const [id, list] of lexicalNeighbourLists(index, pool)) out.set(id, list.map((n): ScoredNeighbour => [n.id, n.csls]));
  return out;
}

/** Cosine of a free-text query against every document, best first (seeds `view: related`). */
export function queryScores(index: LexicalIndex, text: string): ScoredNeighbour[] {
  const tf = new Map<string, number>();
  for (const term of tokenize(text)) if (index.idf.has(term)) tf.set(term, (tf.get(term) ?? 0) + 1);
  const raw = [...tf.entries()].map(([term, count]) => [term, (1 + Math.log(count)) * index.idf.get(term)!] as const);
  const norm = Math.sqrt(raw.reduce((sum, [, w]) => sum + w * w, 0)) || 1;
  const acc = new Map<string, number>();
  for (const [term, w] of raw) {
    for (const [id, y] of index.postings.get(term) ?? []) acc.set(id, (acc.get(id) ?? 0) + (w / norm) * y);
  }
  return [...acc.entries()].sort(byScore);
}

/**
 * Lexical score -> vector-scale similarity by quantile matching: a score sits where it ranks
 * among `lexicalSorted`, and takes the vector similarity at the same rank of `vectorSorted`.
 * Both lists ascending. Mirrors `to_voyage_scale` in the benchmark prototype.
 */
export function quantileScale(lexicalSorted: readonly number[], vectorSorted: readonly number[]): (score: number) => number {
  return (score) => {
    if (lexicalSorted.length === 0 || vectorSorted.length === 0) return 0;
    let lo = 0;
    let hi = lexicalSorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lexicalSorted[mid]! < score) lo = mid + 1;
      else hi = mid;
    }
    const q = lo / lexicalSorted.length;
    return vectorSorted[Math.min(vectorSorted.length - 1, Math.floor(q * vectorSorted.length))]!;
  };
}

/**
 * The same quantile matching frozen for workspaces with no vectors at all: [cosine,
 * vector-scale similarity] at every 5th percentile of memory top-6 lists (neighbours picked
 * by CSLS, scored by cosine), measured by the knowledge-map calibration benchmark with this
 * tokenizer on the 2026-10-01 baseline.
 */
export const LEXICAL_TO_VECTOR_KNOTS: ReadonlyArray<readonly [number, number]> = [
  [0.0099, 0.3785], [0.0479, 0.5203], [0.0572, 0.5484], [0.0658, 0.5662], [0.0725, 0.5825],
  [0.0791, 0.5951], [0.0839, 0.6054], [0.0902, 0.6139], [0.0951, 0.6216], [0.0999, 0.6299],
  [0.1061, 0.6387], [0.1103, 0.6481], [0.1165, 0.6572], [0.1234, 0.666], [0.1326, 0.6777],
  [0.1425, 0.6892], [0.1542, 0.7025], [0.1718, 0.7198], [0.1999, 0.7444], [0.2483, 0.7794],
  [0.5064, 0.9624],
];

/** The cosine where the knot table crosses vector similarity 0.60 (calibration output). */
export const LEXICAL_SEM_MIN = 0.0823;

/** Piecewise-linear map through LEXICAL_TO_VECTOR_KNOTS, clamped to the end knots. */
export function knotScale(score: number, knots: ReadonlyArray<readonly [number, number]> = LEXICAL_TO_VECTOR_KNOTS): number {
  if (knots.length === 0) return 0;
  if (score <= knots[0]![0]) return knots[0]![1];
  const last = knots[knots.length - 1]!;
  if (score >= last[0]) return last[1];
  for (let i = 1; i < knots.length; i++) {
    const [x1, y1] = knots[i]!;
    if (score <= x1) {
      const [x0, y0] = knots[i - 1]!;
      return x1 === x0 ? y1 : y0 + ((score - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return last[1];
}
