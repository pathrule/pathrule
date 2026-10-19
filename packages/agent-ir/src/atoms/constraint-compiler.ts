// SPDX-License-Identifier: Apache-2.0
/**
 * Deterministic CONSTRAINT compiler: structured intent in, verified representation out.
 *
 * The model does NOT write regexes here. It supplies a grounded literal plus the FORM
 * KIND of that literal, and this module builds the pattern mechanically. The reason is
 * measured, not stylistic: a model asked
 * for a regex produced three patterns that were faithful to the prose and incomplete
 * against real code, and every one of those failures is silent, because an under-matching
 * pattern simply never fires.
 *
 * The mechanical variations (whitespace, quoting, camelCase spelling, import syntax) are
 * properties of the literal's KIND, not of the instance, which is why one field replaces
 * a regex. Measured: the same six real
 * constraints compiled to 12 of 22 forbidden forms with zero false positives, and the JSX
 * `cursor: "pointer"` variant that the model's own regex missed was covered without
 * adding anything to the prose.
 *
 * Three properties this module must keep:
 *
 *  1. PURE AND STABLE. No I/O, no clock, no randomness, no model call. The same intent
 *     compiles to the same pattern forever, which is what makes a stored fingerprint of
 *     it meaningful.
 *  2. TWO-SIDED VERIFICATION. Every grounded positive example must match and every
 *     grounded negative example must not. One miss on either side and nothing compiles.
 *     Validator acceptance is not success; that distinction is the whole point.
 *  3. NO SILENT FALLBACK. Every refusal names a reason. A representation this module
 *     cannot verify must be visibly refused rather than quietly weakened, because false
 *     security on a constraint costs more than no constraint.
 */

/**
 * The syntactic kinds measured as sufficient across the real corpus. Deliberately closed:
 * 22 forbidden forms needed exactly these six, and only one form in the whole corpus
 * asked for a seventh (an identifier assigned a string literal), which v1 refuses rather
 * than guesses at.
 */
export type FormKind =
  | "character"
  | "identifier"
  | "code_fragment"
  | "class_name"
  | "css_declaration"
  | "import_specifier";

export const FORM_KINDS: readonly FormKind[] = [
  "character",
  "identifier",
  "code_fragment",
  "class_name",
  "css_declaration",
  "import_specifier",
];

/** One grounded forbidden form. */
export interface ForbiddenForm {
  /** The literal, exactly as the source prose names it. */
  literal: string;
  form_kind: FormKind;
}

/**
 * What a model (or a person) supplies. Contains no regex and no flags: both are the
 * compiler's output, so neither is a place a caller can be wrong.
 */
export interface StructuredConstraintIntent {
  /** The prose this was derived from. Used to prove every literal is grounded. */
  source_text: string;
  forbidden_forms: ForbiddenForm[];
  /** Code that MUST be caught. Every one of them, or nothing compiles. */
  positive_examples: string[];
  /** Code that must NOT be caught. Any hit and nothing compiles. */
  negative_examples: string[];
  /** What to do instead. Reaches the agent in the deny reason. */
  message: string;
  /**
   * Optional path narrowing, for a constraint whose subject is WHERE a file is rather
   * than what it contains. Measured need: one real rule forbids `.md` files under a
   * specific subtree, and forcing that into a content regex would be the wrong target.
   */
  scope_path?: string;
  file_extensions?: string[];
}

export type CompileFailureReason =
  | "UNSUPPORTED_FORM_KIND"
  | "INSUFFICIENT_GROUNDING"
  | "NO_FORBIDDEN_FORM"
  | "NO_EXAMPLES"
  | "POSITIVE_COVERAGE_FAILED"
  | "NEGATIVE_FALSE_POSITIVE"
  | "PATTERN_UNCOMPILABLE"
  | "PATTERN_MATCHES_EMPTY"
  | "PATH_SCOPE_INVALID"
  | "MESSAGE_TOO_SHORT";

/** The verified output, in the shape the existing CONSTRAINT atom stores. */
export interface VerifiedRepresentation {
  /** Absent for a path-only constraint. */
  pattern?: string;
  /** Always "" in v1: flags are not a caller input and no kind needs one. */
  flags: string;
  message: string;
  /** Present only when the intent narrowed by path. */
  path?: { scope_path: string; file_extensions?: string[] };
  /** Which kinds took part, for provenance at approval or audit time. */
  form_kinds: FormKind[];
  /**
   * The exact prose this representation was proved against, trimmed.
   *
   * Echoed back rather than discarded because verification is a statement about a
   * PAIR (this pattern, that prose) and only half of it survives into the stored atom
   * otherwise. Keeping it is what lets a later compile re-prove the pair against the
   * rule body as it stands then, instead of trusting that nothing moved. Every
   * forbidden literal is contained in this string by construction, so it is the
   * smallest key that covers the whole grounding claim.
   */
  source_text: string;
}

export type CompileResult =
  | { status: "VERIFIED"; representation: VerifiedRepresentation }
  | { status: CompileFailureReason; detail: string };

const MIN_MESSAGE_CHARS = 10;
const MAX_PATTERN_CHARS = 200;

/** Escape every regex metacharacter. The literal is data, never syntax. */
function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWordChar(ch: string): boolean {
  return /[\w$]/.test(ch);
}

/**
 * The mechanical rules, one per form kind. Every tolerance here was required by a real
 * constraint in the measured corpus; nothing was added speculatively.
 */
function compileForm(form: ForbiddenForm): { ok: true; source: string } | { ok: false; detail: string } {
  const { literal, form_kind } = form;
  if (!literal || literal.length === 0) return { ok: false, detail: "empty literal" };

  switch (form_kind) {
    case "character":
      return { ok: true, source: escapeLiteral(literal) };

    case "identifier":
      return { ok: true, source: `\\b${escapeLiteral(literal)}\\b` };

    case "code_fragment": {
      // A word boundary is only meaningful where the edge character is itself a word
      // character. Measured: `String(err)` given the `identifier` kind compiled to a
      // pattern that could not match its own positive example, and the oracle refused it
      // rather than shipping something that never fires.
      const left = isWordChar(literal[0]!) ? "(?<![\\w$])" : "";
      const right = isWordChar(literal[literal.length - 1]!) ? "(?![\\w$])" : "";
      return { ok: true, source: `${left}${escapeLiteral(literal)}${right}` };
    }

    case "class_name":
      // A class token neighbours other class tokens and hyphens, so the boundary has to
      // exclude hyphens too: `cursor-pointer` must not fire inside `cursor-pointer-x`.
      return { ok: true, source: `(?<![\\w-])${escapeLiteral(literal)}(?![\\w-])` };

    case "css_declaration": {
      const idx = literal.indexOf(":");
      if (idx <= 0) return { ok: false, detail: `"${literal}" is not a "property: value" pair` };
      const prop = literal.slice(0, idx).trim();
      const value = literal.slice(idx + 1).trim();
      if (!prop || !value) return { ok: false, detail: `"${literal}" is missing a property or a value` };
      // A hyphenated CSS property is spelled camelCase in a JS style object, and the value
      // is quoted there. Both are syntax, not knowledge, which is why the compiler adds
      // them and the prose does not have to.
      let propAlt = escapeLiteral(prop);
      if (prop.includes("-")) {
        const camel = prop.replace(/-(\w)/g, (_m, c: string) => c.toUpperCase());
        propAlt = `(?:${escapeLiteral(prop)}|${escapeLiteral(camel)})`;
      }
      return {
        ok: true,
        source: `(?<![\\w-])${propAlt}\\s*:\\s*["'\`]?\\s*${escapeLiteral(value)}(?![\\w-])`,
      };
    }

    case "import_specifier": {
      const spec = literal.trim();
      let body: string;
      if (spec.endsWith("/*")) {
        body = `${escapeLiteral(spec.slice(0, -2))}/[^"'\`]*`;
      } else if (spec.endsWith("/")) {
        body = `${escapeLiteral(spec)}[^"'\`]*`;
      } else if (spec.startsWith("@")) {
        body = `${escapeLiteral(spec)}(?:/[^"'\`]*)?`;
      } else {
        // A bare package name also covers its subpaths and its @scope sibling, and the
        // anchor on the opening quote is what keeps `./stripe-prices.js` out.
        body = `(?:${escapeLiteral(spec)}(?:/[^"'\`]*)?|@${escapeLiteral(spec)}/[^"'\`]*)`;
      }
      return { ok: true, source: `(?:from|import|require)\\s*\\(?\\s*["'\`]${body}["'\`]` };
    }

    default:
      return { ok: false, detail: `unknown form kind "${String(form_kind)}"` };
  }
}

/** Workspace-relative, rooted, no traversal, no glob. Mirrors the CHECK atom's rule. */
function normaliseScopePath(raw: string): string | null {
  const token = raw.trim();
  if (!token || token.length > 300) return null;
  if (!token.startsWith("/")) return null;
  if (token.includes("..")) return null;
  if (/[*?[\]{}]/.test(token)) return null;
  return token.length > 1 ? token.replace(/\/+$/, "") : "/";
}

function normaliseExtensions(raw: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const item of raw) {
    const ext = item.trim().toLowerCase();
    if (!/^\.[a-z0-9]{1,12}$/.test(ext)) return null;
    if (!out.includes(ext)) out.push(ext);
  }
  return out.length > 0 ? out : null;
}

/**
 * Compile a structured intent, or refuse it with a reason.
 *
 * Deterministic: same input, same output, always.
 */
export function compileConstraintIntent(intent: StructuredConstraintIntent): CompileResult {
  const message = (intent.message ?? "").trim();
  if (message.length < MIN_MESSAGE_CHARS) {
    return {
      status: "MESSAGE_TOO_SHORT",
      detail: `a constraint needs a remedy of at least ${MIN_MESSAGE_CHARS} characters; a bare refusal leaves the agent stuck`,
    };
  }

  // Path narrowing, if any. Validated before the content side so a path-only intent can
  // short-circuit without inventing a pattern.
  let path: VerifiedRepresentation["path"];
  if (intent.scope_path !== undefined || intent.file_extensions !== undefined) {
    const scope = intent.scope_path === undefined ? null : normaliseScopePath(intent.scope_path);
    if (scope === null) {
      return {
        status: "PATH_SCOPE_INVALID",
        detail: `scope_path must be a workspace-relative path starting with "/" (got ${JSON.stringify(intent.scope_path)})`,
      };
    }
    let extensions: string[] | undefined;
    if (intent.file_extensions !== undefined) {
      const normalised = normaliseExtensions(intent.file_extensions);
      if (normalised === null) {
        return {
          status: "PATH_SCOPE_INVALID",
          detail: `file_extensions must be dotted extensions like ".md" (got ${JSON.stringify(intent.file_extensions)})`,
        };
      }
      extensions = normalised;
    }
    path = extensions ? { scope_path: scope, file_extensions: extensions } : { scope_path: scope };
  }

  // Trimmed once, here: this is both the string every literal is checked against and
  // the string stored as the grounding key, and the two must be the same bytes or a
  // later re-proof could disagree with the one that granted enforcement.
  const sourceText = (intent.source_text ?? "").trim();
  const forms = intent.forbidden_forms ?? [];

  // ── path-only ─────────────────────────────────────────────────────────────
  // A constraint whose subject is WHERE a file is needs no content pattern, and forcing
  // one would be the wrong target. Verified by the path oracle instead.
  if (forms.length === 0) {
    if (!path) {
      return {
        status: "NO_FORBIDDEN_FORM",
        detail: "an intent with no forbidden form and no path narrowing forbids nothing",
      };
    }
    const oracle = verifyPathOracle(path, intent.positive_examples ?? [], intent.negative_examples ?? []);
    if (oracle.status !== "ok") return oracle.failure;
    return {
      status: "VERIFIED",
      representation: { flags: "", message, path, form_kinds: [], source_text: sourceText },
    };
  }

  // ── content side ──────────────────────────────────────────────────────────
  for (const form of forms) {
    if (!FORM_KINDS.includes(form.form_kind)) {
      return {
        status: "UNSUPPORTED_FORM_KIND",
        detail: `"${String(form.form_kind)}" is not one of: ${FORM_KINDS.join(", ")}`,
      };
    }
    // Grounding: the literal has to appear in the prose it claims to come from. This is
    // what stops a model from adding a prohibition nobody wrote.
    if (!sourceText || !sourceText.includes(form.literal)) {
      return {
        status: "INSUFFICIENT_GROUNDING",
        detail: `the literal ${JSON.stringify(form.literal)} does not appear in the source text it claims to come from`,
      };
    }
  }

  const positives = intent.positive_examples ?? [];
  const negatives = intent.negative_examples ?? [];
  if (positives.length === 0 || negatives.length === 0) {
    return {
      status: "NO_EXAMPLES",
      detail: "verification needs at least one positive and one negative example; without both there is no oracle",
    };
  }

  const sources: string[] = [];
  const kinds: FormKind[] = [];
  for (const form of forms) {
    const compiled = compileForm(form);
    if (!compiled.ok) return { status: "UNSUPPORTED_FORM_KIND", detail: compiled.detail };
    sources.push(compiled.source);
    if (!kinds.includes(form.form_kind)) kinds.push(form.form_kind);
  }
  const pattern = sources.join("|");
  if (pattern.length > MAX_PATTERN_CHARS * forms.length) {
    return { status: "PATTERN_UNCOMPILABLE", detail: `compiled pattern is implausibly long (${pattern.length} chars)` };
  }

  let re: RegExp;
  try {
    re = new RegExp(pattern, "");
  } catch (err) {
    return {
      status: "PATTERN_UNCOMPILABLE",
      detail: `compiled pattern is not a valid JavaScript regex: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (re.test("")) {
    return { status: "PATTERN_MATCHES_EMPTY", detail: "the compiled pattern matches the empty string, so it would deny every edit" };
  }

  const missed = positives.filter((example) => !re.test(example));
  if (missed.length > 0) {
    return {
      status: "POSITIVE_COVERAGE_FAILED",
      detail: `did not catch ${missed.length} of ${positives.length} positive example(s): ${JSON.stringify(missed)}`,
    };
  }
  const falsePositives = negatives.filter((example) => re.test(example));
  if (falsePositives.length > 0) {
    return {
      status: "NEGATIVE_FALSE_POSITIVE",
      detail: `matched ${falsePositives.length} negative example(s): ${JSON.stringify(falsePositives)}`,
    };
  }

  // A path narrowing alongside a content pattern is an AND, and its own oracle still has
  // to pass when path examples were supplied.
  if (path) {
    const pathExamples = splitPathExamples(positives, negatives);
    if (pathExamples.positives.length > 0 || pathExamples.negatives.length > 0) {
      const oracle = verifyPathOracle(path, pathExamples.positives, pathExamples.negatives);
      if (oracle.status !== "ok") return oracle.failure;
    }
  }

  return {
    status: "VERIFIED",
    representation: {
      pattern,
      flags: "",
      message,
      ...(path ? { path } : {}),
      form_kinds: kinds,
      source_text: sourceText,
    },
  };
}

/** An example that looks like a workspace-relative path rather than a code line. */
function looksLikePathExample(example: string): boolean {
  return example.startsWith("/") && !/\s/.test(example);
}

function splitPathExamples(
  positives: readonly string[],
  negatives: readonly string[],
): { positives: string[]; negatives: string[] } {
  return {
    positives: positives.filter(looksLikePathExample),
    negatives: negatives.filter(looksLikePathExample),
  };
}

/**
 * Does a path fall inside the narrowing? Exact or descendant only, plus the extension
 * filter when one was given. Ancestors deliberately do not count: an edit to `/packages`
 * is not an edit inside `/packages/mobile/Pathrule`.
 */
export function pathMatchesConstraintScope(
  filePath: string,
  path: { scope_path: string; file_extensions?: string[] },
): boolean {
  if (!filePath) return false;
  const p = filePath.startsWith("/") ? filePath : `/${filePath}`;
  const scope = path.scope_path === "/" ? "" : path.scope_path.replace(/\/+$/, "");
  if (scope !== "" && p !== scope && !p.startsWith(`${scope}/`)) return false;
  if (path.file_extensions && path.file_extensions.length > 0) {
    const lower = p.toLowerCase();
    if (!path.file_extensions.some((ext) => lower.endsWith(ext))) return false;
  }
  return true;
}

function verifyPathOracle(
  path: { scope_path: string; file_extensions?: string[] },
  positives: readonly string[],
  negatives: readonly string[],
): { status: "ok" } | { status: "failed"; failure: CompileResult } {
  if (positives.length === 0 || negatives.length === 0) {
    return {
      status: "failed",
      failure: {
        status: "NO_EXAMPLES",
        detail: "a path narrowing needs at least one path that must be caught and one that must not",
      },
    };
  }
  const missed = positives.filter((p) => !pathMatchesConstraintScope(p, path));
  if (missed.length > 0) {
    return {
      status: "failed",
      failure: {
        status: "POSITIVE_COVERAGE_FAILED",
        detail: `path narrowing did not cover ${JSON.stringify(missed)}`,
      },
    };
  }
  const hit = negatives.filter((p) => pathMatchesConstraintScope(p, path));
  if (hit.length > 0) {
    return {
      status: "failed",
      failure: {
        status: "NEGATIVE_FALSE_POSITIVE",
        detail: `path narrowing wrongly covered ${JSON.stringify(hit)}`,
      },
    };
  }
  return { status: "ok" };
}
