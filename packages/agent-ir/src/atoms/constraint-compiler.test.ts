// SPDX-License-Identifier: Apache-2.0
// The deterministic CONSTRAINT compiler and its two-sided oracle.
//
// The acceptance corpus is the four documents measured as AUTO_CANDIDATE in the constraint path
// predicate study, with prose transcribed from the real rules so the
// grounding check is against the same text a person wrote.
//
// The negative corpus is the cases measured as NOT safely representable. Refusing them is
// the success condition, not a limitation: v1's job is to automate what it can verify and
// visibly refuse the rest.

import { describe, expect, it } from "vitest";

import {
  compileConstraintIntent,
  pathMatchesConstraintScope,
  type StructuredConstraintIntent,
} from "./constraint-compiler.js";

function verified(intent: StructuredConstraintIntent) {
  const result = compileConstraintIntent(intent);
  if (result.status !== "VERIFIED") {
    throw new Error(`expected VERIFIED, got ${result.status}: ${result.detail}`);
  }
  return result.representation;
}

// ── real prose, transcribed ─────────────────────────────────────────────────

const CURSOR_PROSE = `Never apply \`cursor: pointer\` (or the Tailwind \`cursor-pointer\` class) anywhere in the app UI.
- Buttons, clickable rows, menu triggers, links, toggles: leave the cursor as the default arrow. Do NOT add \`cursor-pointer\`.
- If you need to signal interactivity, use hover background/color/opacity changes, not the cursor.`;

const EM_DASH_PROSE = `The em dash character (U+2014) is banned across the entire project: UI copy, i18n dictionaries, code comments, docs, commit messages.
Rewrite with a period, colon, comma, or parentheses. For numeric ranges use a hyphen or the word "to".
The character is — and it must not appear.`;

const CORE_PROSE = `@pathrule/core (the OSS engine) must NEVER import cloud/closed code: no @pathrule/cloud, no @supabase/*, no stripe, no realtime client.
The dependency graph flows cloud -> core only, never the reverse. If core needs a capability that lives in cloud, invert it behind a seam/adapter injected from the cloud side.`;

const MOBILE_PROSE = `The Xcode 16 file-system-synchronized group rooted at Pathrule/ bundles every file it contains, including .md files, into the app bundle.
Scope all mobile memories, rules, and companion files at /packages/mobile (the package root), never under Pathrule/**.
Treat any stray CLAUDE.md or AGENTS.md found under Pathrule/ as a mis-scoped memory.`;

const ERROR_PROSE = `Read an error's text with \`errorMessage(err, fallback)\`. Never \`String(err)\`, never \`err instanceof Error ? err.message : String(err)\`.`;

describe("acceptance corpus: the four AUTO_CANDIDATE documents", () => {
  it("1. cursor: pointer, including the JSX form the model's own regex missed", () => {
    const rep = verified({
      source_text: CURSOR_PROSE,
      forbidden_forms: [
        { literal: "cursor: pointer", form_kind: "css_declaration" },
        { literal: "cursor-pointer", form_kind: "class_name" },
      ],
      positive_examples: [
        ".cta { cursor: pointer; }",
        "cursor:pointer",
        '<div className="cursor-pointer">',
        'style={{ cursor: "pointer" }}',
        "style={{ cursor: 'pointer' }}",
        '<div className="flex cursor-pointer items-center">',
      ],
      negative_examples: [
        ".cta { cursor: default; }",
        "const cursorPointer = 1;",
        '<div className="cursor-not-allowed">',
        "onPointerDown={x}",
      ],
      message: "Use hover background, color or opacity to signal interactivity, not the cursor.",
    });
    expect(rep.pattern).toBeDefined();
    expect(rep.form_kinds).toEqual(["css_declaration", "class_name"]);
    // The measured win: no flags, and the quoted JSX form covered by the KIND, not by
    // anything added to the prose.
    expect(rep.flags).toBe("");
  });

  it("2. em dash", () => {
    const rep = verified({
      source_text: EM_DASH_PROSE,
      forbidden_forms: [{ literal: "—", form_kind: "character" }],
      positive_examples: ["a — b", "// note — see below"],
      negative_examples: ["a - b", "a – b", "a, b"],
      message: "Rewrite with a period, colon, comma or parentheses; for ranges use a hyphen.",
    });
    expect(rep.pattern).toBe("—");
  });

  it("3. core cloud imports", () => {
    const rep = verified({
      source_text: CORE_PROSE,
      forbidden_forms: [
        { literal: "@pathrule/cloud", form_kind: "import_specifier" },
        { literal: "@supabase/", form_kind: "import_specifier" },
        { literal: "stripe", form_kind: "import_specifier" },
      ],
      positive_examples: [
        'import { CloudBackend } from "@pathrule/cloud";',
        'import { createClient } from "@supabase/supabase-js";',
        'import Stripe from "stripe";',
        'const s = require("stripe");',
        'import x from "@stripe/stripe-js";',
      ],
      negative_examples: [
        'import { x } from "@pathrule/shared";',
        'import Database from "better-sqlite3";',
        'import { p } from "./stripe-prices.js";',
        'import { q } from "../supabase/helpers.js";',
      ],
      message: "Invert the capability behind a seam or adapter injected from the cloud side.",
    });
    expect(rep.pattern).toContain("from|import|require");
    expect(rep.form_kinds).toEqual(["import_specifier"]);
  });

  it("4. mobile markdown, a PATH-ONLY constraint with no content pattern at all", () => {
    const rep = verified({
      source_text: MOBILE_PROSE,
      forbidden_forms: [],
      scope_path: "/packages/mobile/Pathrule",
      file_extensions: [".md", ".mdx"],
      positive_examples: [
        "/packages/mobile/Pathrule/CLAUDE.md",
        "/packages/mobile/Pathrule/Views/AGENTS.md",
      ],
      negative_examples: [
        "/packages/mobile/CLAUDE.md",
        "/packages/mobile/Pathrule/Views/Foo.swift",
        "/packages/app/CLAUDE.md",
      ],
      message: "Scope mobile knowledge at /packages/mobile, never under Pathrule/.",
    });
    // No pattern is invented for a rule whose subject is where the file lives.
    expect(rep.pattern).toBeUndefined();
    expect(rep.path).toEqual({
      scope_path: "/packages/mobile/Pathrule",
      file_extensions: [".md", ".mdx"],
    });
    expect(rep.form_kinds).toEqual([]);
  });
});

describe("negative corpus: refusing what cannot be verified is the success condition", () => {
  it("refuses a semantic ban that needs the argument's TYPE (String(err) generalised)", () => {
    // Measured: generalising to any variable catches String(count), String(userId),
    // String(42). The distinguishing fact is not in the text, so no form kind can carry it.
    const result = compileConstraintIntent({
      source_text: ERROR_PROSE,
      forbidden_forms: [{ literal: "String(err)", form_kind: "code_fragment" }],
      positive_examples: ["const m = String(err);", "String(error)", "String(e)"],
      negative_examples: ["const m = errorMessage(err, 'x');", "String(count)"],
      message: "Read the error text with errorMessage(err, fallback).",
    });
    expect(result.status).toBe("POSITIVE_COVERAGE_FAILED");
    if (result.status === "VERIFIED") return;
    expect(result.detail).toContain("String(error)");
  });

  it("accepts the narrow idiom the prose actually names, and only that", () => {
    // The honest half of the same document: the literal the human wrote IS representable.
    const rep = verified({
      source_text: ERROR_PROSE,
      forbidden_forms: [{ literal: "String(err)", form_kind: "code_fragment" }],
      positive_examples: ["const m = String(err);"],
      negative_examples: ["const m = errorMessage(err, 'x');", "String(count)", "String(e)"],
      message: "Read the error text with errorMessage(err, fallback).",
    });
    expect(rep.pattern).toBe("(?<![\\w$])String\\(err\\)");
  });

  it("refuses a literal that is not in the source prose (INSUFFICIENT_GROUNDING)", () => {
    // The radix case: prose says "radix icons as glyphs" and never names the package, so
    // a model supplying @radix-ui/react-icons would be inventing a prohibition.
    const result = compileConstraintIntent({
      source_text: "Do not add other icon packages (heroicons, tabler, radix icons as glyphs, iconify).",
      forbidden_forms: [{ literal: "@radix-ui/react-icons", form_kind: "import_specifier" }],
      positive_examples: ['import { BellIcon } from "@radix-ui/react-icons";'],
      negative_examples: ['import { Bell } from "lucide-react";'],
      message: "Import the glyph from lucide-react instead.",
    });
    expect(result.status).toBe("INSUFFICIENT_GROUNDING");
  });

  it("refuses an unknown form kind rather than guessing a pattern", () => {
    const result = compileConstraintIntent({
      source_text: "files_touched must never be a raw string.",
      forbidden_forms: [{ literal: "files_touched", form_kind: "assigned_literal" as never }],
      positive_examples: ['files_touched: "a/b.ts"'],
      negative_examples: ["files_touched: normalizeFilesTouched(paths)"],
      message: "Assign files_touched from the normalizer helpers.",
    });
    expect(result.status).toBe("UNSUPPORTED_FORM_KIND");
  });

  it("refuses a wrong form kind whose pattern cannot match its own positive example", () => {
    // `identifier` wraps in \b...\b, and \b after ")" requires a word char. The oracle
    // catches it instead of shipping a pattern that never fires.
    const result = compileConstraintIntent({
      source_text: ERROR_PROSE,
      forbidden_forms: [{ literal: "String(err)", form_kind: "identifier" }],
      positive_examples: ["const m = String(err);"],
      negative_examples: ["errorMessage(err)"],
      message: "Read the error text with errorMessage(err, fallback).",
    });
    expect(result.status).toBe("POSITIVE_COVERAGE_FAILED");
  });

  it("refuses a representation that catches a negative example", () => {
    const result = compileConstraintIntent({
      source_text: "Never use the substring cursor in class names.",
      forbidden_forms: [{ literal: "cursor", form_kind: "identifier" }],
      positive_examples: ['className="cursor"'],
      negative_examples: ["const cursor = 1;"],
      message: "Use a different name for that binding entirely.",
    });
    expect(result.status).toBe("NEGATIVE_FALSE_POSITIVE");
  });

  it("refuses an intent with no oracle at all", () => {
    const base: StructuredConstraintIntent = {
      source_text: CURSOR_PROSE,
      forbidden_forms: [{ literal: "cursor-pointer", form_kind: "class_name" }],
      positive_examples: [],
      negative_examples: [],
      message: "Use hover background instead of the cursor.",
    };
    expect(compileConstraintIntent(base).status).toBe("NO_EXAMPLES");
    expect(
      compileConstraintIntent({ ...base, positive_examples: ['className="cursor-pointer"'] }).status,
    ).toBe("NO_EXAMPLES");
  });

  it("refuses an intent that forbids nothing", () => {
    expect(
      compileConstraintIntent({
        source_text: "Some prose.",
        forbidden_forms: [],
        positive_examples: ["x"],
        negative_examples: ["y"],
        message: "Do something else entirely.",
      }).status,
    ).toBe("NO_FORBIDDEN_FORM");
  });

  it("refuses a path narrowing that is not workspace-relative", () => {
    for (const scope_path of ["packages/mobile", "/packages/../etc", "/packages/*"]) {
      expect(
        compileConstraintIntent({
          source_text: MOBILE_PROSE,
          forbidden_forms: [],
          scope_path,
          positive_examples: ["/x"],
          negative_examples: ["/y"],
          message: "Scope mobile knowledge at the package root.",
        }).status,
        scope_path,
      ).toBe("PATH_SCOPE_INVALID");
    }
  });

  it("refuses a path narrowing that covers a path it must not", () => {
    const result = compileConstraintIntent({
      source_text: MOBILE_PROSE,
      forbidden_forms: [],
      scope_path: "/packages/mobile",
      file_extensions: [".md"],
      positive_examples: ["/packages/mobile/Pathrule/CLAUDE.md"],
      // The whole point of the rule: markdown at the package root is CORRECT.
      negative_examples: ["/packages/mobile/CLAUDE.md"],
      message: "Scope mobile knowledge at /packages/mobile, never under Pathrule/.",
    });
    expect(result.status).toBe("NEGATIVE_FALSE_POSITIVE");
  });

  it("refuses a message too short to act on", () => {
    expect(
      compileConstraintIntent({
        source_text: CURSOR_PROSE,
        forbidden_forms: [{ literal: "cursor-pointer", form_kind: "class_name" }],
        positive_examples: ['className="cursor-pointer"'],
        negative_examples: ["cursor-not-allowed"],
        message: "no",
      }).status,
    ).toBe("MESSAGE_TOO_SHORT");
  });
});

describe("determinism", () => {
  it("compiles the same intent to the same pattern every time", () => {
    const intent: StructuredConstraintIntent = {
      source_text: CURSOR_PROSE,
      forbidden_forms: [
        { literal: "cursor: pointer", form_kind: "css_declaration" },
        { literal: "cursor-pointer", form_kind: "class_name" },
      ],
      positive_examples: [".a { cursor: pointer; }"],
      negative_examples: [".a { cursor: default; }"],
      message: "Use hover background instead of the cursor.",
    };
    const first = verified(intent).pattern;
    for (let i = 0; i < 5; i += 1) expect(verified(intent).pattern).toBe(first);
  });

  it("never emits flags, so a caller cannot introduce a stateful regex", () => {
    // `g` and `y` make .test() alternate on identical input. The compiler owning flags is
    // what removes that failure class entirely.
    expect(
      verified({
        source_text: EM_DASH_PROSE,
        forbidden_forms: [{ literal: "—", form_kind: "character" }],
        positive_examples: ["a — b"],
        negative_examples: ["a - b"],
        message: "Rewrite with a period or a comma.",
      }).flags,
    ).toBe("");
  });
});

describe("pathMatchesConstraintScope", () => {
  const narrowing = { scope_path: "/packages/mobile/Pathrule", file_extensions: [".md"] };

  it("matches the scope and its descendants with the right extension", () => {
    expect(pathMatchesConstraintScope("/packages/mobile/Pathrule/CLAUDE.md", narrowing)).toBe(true);
    expect(pathMatchesConstraintScope("/packages/mobile/Pathrule/a/b/AGENTS.md", narrowing)).toBe(true);
  });

  it("does not match an ancestor, a sibling, or the wrong extension", () => {
    expect(pathMatchesConstraintScope("/packages/mobile/CLAUDE.md", narrowing)).toBe(false);
    expect(pathMatchesConstraintScope("/packages/mobile/PathruleX/CLAUDE.md", narrowing)).toBe(false);
    expect(pathMatchesConstraintScope("/packages/mobile/Pathrule/Foo.swift", narrowing)).toBe(false);
    expect(pathMatchesConstraintScope("/packages/mobile", narrowing)).toBe(false);
  });

  it("treats / as the whole workspace and no extension filter as any file", () => {
    expect(pathMatchesConstraintScope("/anything.ts", { scope_path: "/" })).toBe(true);
    expect(pathMatchesConstraintScope("/packages/mobile/Pathrule/Foo.swift", { scope_path: "/packages/mobile/Pathrule" })).toBe(true);
  });
});
