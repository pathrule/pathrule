// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { applyContentEdit } from "./content-edit.js";

describe("applyContentEdit — surgical delta edits", () => {
  it("append adds text after a blank line and keeps a trailing newline", () => {
    const r = applyContentEdit("Line one.", { op: "append", text: "Line two." });
    expect(r.ok && r.content).toBe("Line one.\n\nLine two.\n");
  });

  it("append onto empty content just writes the text", () => {
    const r = applyContentEdit("", { op: "append", text: "First." });
    expect(r.ok && r.content).toBe("First.\n");
  });

  it("prepend puts text before existing content", () => {
    const r = applyContentEdit("Body.", { op: "prepend", text: "Intro." });
    expect(r.ok && r.content).toBe("Intro.\n\nBody.\n");
  });

  it("str_replace swaps a unique occurrence", () => {
    const r = applyContentEdit("use foo() here", { op: "str_replace", find: "foo()", replace: "bar()" });
    expect(r.ok && r.content).toBe("use bar() here");
  });

  it("str_replace errors when the target is missing", () => {
    const r = applyContentEdit("nothing here", { op: "str_replace", find: "absent", replace: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_found");
  });

  it("str_replace errors (ambiguous) when the target appears more than once", () => {
    const r = applyContentEdit("a a a", { op: "str_replace", find: "a", replace: "b" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ambiguous");
  });

  it("replace_section swaps only the named section, keeping the heading + neighbours", () => {
    const doc = ["# Title", "", "## Setup", "", "old setup", "", "## Usage", "", "keep me"].join("\n");
    const r = applyContentEdit(doc, { op: "replace_section", heading: "Setup", body: "new setup steps" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toContain("## Setup\n\nnew setup steps");
    expect(r.content).toContain("## Usage");
    expect(r.content).toContain("keep me");
    expect(r.content).not.toContain("old setup");
  });

  it("replace_section accepts a heading given with its #s and stops at a same-level heading", () => {
    const doc = ["## A", "a body", "### A sub", "sub body", "## B", "b body"].join("\n");
    const r = applyContentEdit(doc, { op: "replace_section", heading: "## A", body: "A replaced" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The nested "### A sub" is inside A and gets replaced; "## B" (same level) is preserved.
    expect(r.content).toContain("## A\n\nA replaced");
    expect(r.content).toContain("## B");
    expect(r.content).not.toContain("sub body");
  });

  it("replace_section errors when the heading is not found", () => {
    const r = applyContentEdit("## Only", { op: "replace_section", heading: "Missing", body: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_found");
  });

  it("replace_section errors (ambiguous) on duplicate headings", () => {
    const doc = ["## Notes", "one", "## Notes", "two"].join("\n");
    const r = applyContentEdit(doc, { op: "replace_section", heading: "Notes", body: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ambiguous");
  });

  it("str_replace inserts the replacement literally, $ sequences included", () => {
    // String.replace reads $' as "the text after the match", so this used to paste the
    // rest of the body into the middle of the line.
    const doc = "before\nOLD\nafter";
    for (const literal of ["IFS=$'\\n'", "echo $$", "cost: $&", "x $` y"]) {
      const r = applyContentEdit(doc, { op: "str_replace", find: "OLD", replace: literal });
      expect(r.ok && r.content).toBe(`before\n${literal}\nafter`);
    }
  });

  describe("replace_section and fenced code", () => {
    it("does not end a section at a # comment inside a code block", () => {
      // The failure that shipped: `# Dry run:` in a bash sample was read as a heading,
      // the replacement stopped there, and the rest of the old section stayed behind.
      const doc = [
        "## Send",
        "",
        "```bash",
        "# Dry run:",
        "node send.mjs",
        "```",
        "",
        "old prose",
        "",
        "## Next",
        "",
        "keep me",
      ].join("\n");
      const r = applyContentEdit(doc, { op: "replace_section", heading: "Send", body: "new steps" });
      expect(r.ok && r.content).toBe("## Send\n\nnew steps\n\n## Next\n\nkeep me\n");
    });

    it("never matches the target heading inside a code block", () => {
      const doc = ["## Setup", "real", "", "```sh", "## Setup", "```", "", "## Usage", "u"].join("\n");
      const r = applyContentEdit(doc, { op: "replace_section", heading: "Setup", body: "x" });
      expect(r.ok && r.content).toBe("## Setup\n\nx\n\n## Usage\nu\n");
    });

    it("says so when the heading only exists inside a code block", () => {
      const doc = ["# Title", "", "```sh", "# Install", "npm i", "```"].join("\n");
      const r = applyContentEdit(doc, { op: "replace_section", heading: "Install", body: "x" });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("not_found");
        expect(r.message).toContain("inside a fenced code block");
      }
    });

    it("follows CommonMark closing rules: same marker, at least as long, nothing after", () => {
      const doc = [
        "## A",
        "~~~~",
        "```",
        "# not a heading",
        "~~~",
        "# still not a heading",
        "~~~~",
        "",
        "````markdown",
        "```bash",
        "# nor this",
        "```",
        "````",
        "## B",
        "b",
      ].join("\n");
      const r = applyContentEdit(doc, { op: "replace_section", heading: "A", body: "a" });
      expect(r.ok && r.content).toBe("## A\n\na\n\n## B\nb\n");
    });

    it("reads fences in CRLF content", () => {
      const doc = ["## A", "```bash", "# comment", "```", "old", "## B", "b"].join("\r\n");
      const r = applyContentEdit(doc, { op: "replace_section", heading: "A", body: "a" });
      expect(r.ok && r.content).toBe("## A\r\n\na\n\n## B\r\nb\n");
    });

    it("refuses instead of guessing when an unclosed fence decides where the section ends", () => {
      // A renderer would treat everything after the fence as code, so the section would
      // run to the end and take "## B" with it. Neither reading is safe to act on.
      const doc = ["## A", "```bash", "# comment", "", "## B", "keep me"].join("\n");
      const r = applyContentEdit(doc, { op: "replace_section", heading: "A", body: "a" });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("ambiguous");
        expect(r.message).toContain("never closed");
      }
    });

    it("treats a second language-tagged opener inside a fence as a missing closer", () => {
      const doc = [
        "## A",
        "```bash",
        "one",
        "## B",
        "```bash",
        "# comment",
        "```",
        "## C",
      ].join("\n");
      const r = applyContentEdit(doc, { op: "replace_section", heading: "A", body: "a" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("ambiguous");
    });

    it("still edits a section an unclosed fence elsewhere cannot affect", () => {
      const doc = ["## A", "old", "## B", "```bash", "echo unclosed"].join("\n");
      const r = applyContentEdit(doc, { op: "replace_section", heading: "A", body: "a" });
      expect(r.ok && r.content).toBe("## A\n\na\n\n## B\n```bash\necho unclosed\n");
    });

    it("leaves blank-line runs outside the replaced section untouched", () => {
      // Two blank lines between Python functions are part of the sample, not noise.
      const py = ["```python", "def a():", "    pass", "", "", "def b():", "    pass", "```"];
      const doc = ["## A", "old", "", "## B", ...py].join("\n");
      const r = applyContentEdit(doc, { op: "replace_section", heading: "A", body: "\n\nnew\n\n\n" });
      expect(r.ok && r.content).toBe(["## A", "", "new", "", "## B", ...py].join("\n") + "\n");
    });
  });

  it("append rejects empty text", () => {
    const r = applyContentEdit("x", { op: "append", text: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_args");
  });
});
