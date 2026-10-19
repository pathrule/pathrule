// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { selectKnowledgeGap } from "./gap-delivery.js";
import {
  PATH_DRIFT_LINE_MAX,
  detectPathDrift,
  pathDriftReason,
  pathDriftStubs,
  renderPathDriftDigest,
  renderPathDriftLine,
  type DriftTree,
} from "./path-drift.js";

const RUNBOOK =
  "# On-call runbook\n\nOne row per error slug.\n\n| Slug | Status | Check first |\n| --- | --- | --- |\n| `header-too-large` | 431 | Oversized cookies. |\n";
const RUNBOOK_MEMORY = {
  id: "m-runbook",
  title: "On-call runbook",
  content:
    "Every error slug the toolkit answers has a row in the on-call runbook, `docs/runbook.md`.",
  node_path: "/docs",
};

function tree(files: Record<string, string>): DriftTree {
  return { files: Object.keys(files), read: (p) => files[p] ?? null };
}

describe("path drift: knowledge naming a file the checkout moved away from", () => {
  it("copy: a same-named near-identical file that another file now names instead (the moved runbook)", () => {
    const drifts = detectPathDrift(
      [RUNBOOK_MEMORY],
      tree({
        "docs/runbook.md": RUNBOOK,
        "docs/oncall/runbook.md": RUNBOOK,
        "README.md": "- On-call runbook: `docs/oncall/runbook.md`\n",
      }),
    );
    expect(drifts).toEqual([
      {
        memoryId: "m-runbook",
        title: "On-call runbook",
        anchor: "docs/runbook.md",
        current: "docs/oncall/runbook.md",
        kind: "copy",
        evidence: "README.md",
      },
    ]);
    expect(renderPathDriftLine(drifts[0]!)).toBe(
      'memory "On-call runbook" names docs/runbook.md, but README.md now names docs/oncall/runbook.md, a copy of it. Write to docs/oncall/runbook.md, then update the memory (pathrule_update_memory).',
    );
    expect(pathDriftReason(drifts[0]!)).toBe(
      "docs/runbook.md looks moved: README.md now names docs/oncall/runbook.md, a copy of it. Point the memory at the current file.",
    );
  });

  it("copy needs a file that names the copy and not the original: two copies alone, a README naming both, or only an agent instruction file is not drift", () => {
    const both = { "docs/runbook.md": RUNBOOK, "docs/oncall/runbook.md": RUNBOOK };
    expect(detectPathDrift([RUNBOOK_MEMORY], tree(both))).toEqual([]);
    expect(
      detectPathDrift(
        [RUNBOOK_MEMORY],
        tree({ ...both, "README.md": "`docs/runbook.md` and `docs/oncall/runbook.md`" }),
      ),
    ).toEqual([]);
    expect(
      detectPathDrift(
        [RUNBOOK_MEMORY],
        tree({
          ...both,
          "CLAUDE.md": "runbook: docs/oncall/runbook.md",
          ".claude/notes.md": "docs/oncall/runbook.md",
        }),
      ),
    ).toEqual([]);
    // The longer path is not a mention of the shorter one.
    expect(
      detectPathDrift(
        [RUNBOOK_MEMORY],
        tree({ ...both, "README.md": "see old/docs/oncall/runbook.md.bak" }),
      ),
    ).toEqual([]);
  });

  it("copy needs the original abandoned: a twin something still names is in use, and a changelog naming both describes the move", () => {
    const moved = {
      "docs/runbook.md": RUNBOOK,
      "docs/oncall/runbook.md": RUNBOOK,
      "README.md": "docs/oncall/runbook.md",
    };
    expect(
      detectPathDrift(
        [RUNBOOK_MEMORY],
        tree({ ...moved, "docs/plan.md": "The open copy stays at docs/runbook.md." }),
      ),
    ).toEqual([]);
    const withChangelog = detectPathDrift(
      [RUNBOOK_MEMORY],
      tree({ ...moved, "CHANGELOG.md": "- moved docs/runbook.md to docs/oncall/runbook.md" }),
    );
    expect(withChangelog.map((d) => [d.kind, d.current])).toEqual([
      ["copy", "docs/oncall/runbook.md"],
    ]);
  });

  it("copy needs the files to be one file in two places: same name, different content is not drift", () => {
    const memory = { ...RUNBOOK_MEMORY, content: "The API index is `docs/api/index.md`." };
    expect(
      detectPathDrift(
        [memory],
        tree({
          "docs/api/index.md": "# API\n\n- App\n- Request\n- Response\n",
          "docs/guide/index.md": "# Guide\n\n- Install\n- Configure\n- Deploy\n",
          "README.md": "Start with docs/guide/index.md.",
        }),
      ),
    ).toEqual([]);
    // Near-empty files are alike by being empty, not by being one file.
    const init = {
      id: "m",
      title: "Package",
      content: "The package entry is `acme/__init__.py`.",
      node_path: "/",
    };
    expect(
      detectPathDrift(
        [init],
        tree({
          "acme/__init__.py": "",
          "tests/__init__.py": "",
          Makefile: "test: tests/__init__.py",
        }),
      ),
    ).toEqual([]);
  });

  it("pointer: the named file is now a short note naming a same-named file elsewhere, in any language", () => {
    const memory = {
      id: "m-cat",
      title: "The error catalogue",
      content: "Every slug is listed in `ERROR_SLUGS` in `acme/catalogue.py`.",
      node_path: "/acme",
    };
    for (const note of [
      '"""Moved: the error catalogue is acme/errors/catalogue.py now."""\n',
      "# Taşındı: acme/errors/catalogue.py\n",
      "// 移動しました → acme/errors/catalogue.py\n",
    ]) {
      const drifts = detectPathDrift(
        [memory],
        tree({
          "acme/catalogue.py": note,
          "acme/errors/catalogue.py": 'ERROR_SLUGS = (\n    "header-too-large",\n)\n',
        }),
      );
      expect(drifts.map((d) => [d.kind, d.anchor, d.current])).toEqual([
        ["pointer", "acme/catalogue.py", "acme/errors/catalogue.py"],
      ]);
    }
    // A note may name the folder the file now lives in, as Go names a package.
    const goMemory = {
      id: "m-go",
      title: "Catalogue",
      content: "Slugs are listed in `api/catalogue.go`.",
      node_path: "/api",
    };
    const goTree = tree({
      "api/catalogue.go": "package api\n\n// The error catalogue moved to internal/catalogue.\n",
      "internal/catalogue/catalogue.go": "package catalogue",
    });
    expect(detectPathDrift([goMemory], goTree).map((d) => [d.kind, d.current])).toEqual([
      ["pointer", "internal/catalogue/catalogue.go"],
    ]);
    expect(
      renderPathDriftLine(
        detectPathDrift(
          [memory],
          tree({
            "acme/catalogue.py": "# moved to acme/errors/catalogue.py",
            "acme/errors/catalogue.py": "x",
          }),
        )[0]!,
      ),
    ).toContain(
      "names acme/catalogue.py, but it now points to acme/errors/catalogue.py. Write to acme/errors/catalogue.py",
    );
  });

  it("renamed: the named file is gone and git recorded its rename; a gone file without one, or renamed to a file that is gone too, is not drift", () => {
    const memory = {
      id: "m-adr",
      title: "ADR 0003",
      content: "See `docs/adr/0003-outcome.md`, and `cli/commands/native.ts` for the command.",
      node_path: "/",
    };
    const renames: Record<string, string> = {
      "docs/adr/0003-outcome.md": "docs/architecture/decisions/0003-outcome.md",
    };
    const files = {
      "docs/architecture/decisions/0003-outcome.md": "x",
      "packages/cloud/src/cli/commands/native.ts": "y",
    };
    const withHistory = (f: Record<string, string>): DriftTree => ({
      ...tree(f),
      renamedTo: (p) => renames[p] ?? null,
    });
    const drifts = detectPathDrift([memory], withHistory(files));
    // The abbreviated reference has no recorded rename: it is shorthand, not a move.
    expect(drifts.map((d) => [d.kind, d.anchor, d.current])).toEqual([
      ["renamed", "docs/adr/0003-outcome.md", "docs/architecture/decisions/0003-outcome.md"],
    ]);
    expect(renderPathDriftLine(drifts[0]!)).toContain(
      "git shows it was renamed to docs/architecture/decisions/0003-outcome.md. Write to docs/architecture/decisions/0003-outcome.md",
    );
    expect(detectPathDrift([memory], tree(files))).toEqual([]);
    expect(
      detectPathDrift([memory], withHistory({ "packages/cloud/src/cli/commands/native.ts": "y" })),
    ).toEqual([]);
  });

  it("reads a reference relative to the memory's own node, and reports each memory and file once", () => {
    const memory = {
      id: "m-rel",
      title: "Runbook (relative)",
      content: "Rows go in `oncall/runbook.md`… and again in `oncall/runbook.md`.",
      node_path: "/docs",
    };
    const files = {
      "docs/oncall/runbook.md": RUNBOOK,
      "ops/runbook.md": RUNBOOK,
      "README.md": "ops/runbook.md",
    };
    expect(
      detectPathDrift([memory], tree(files)).map((d) => [d.anchor, d.current, d.kind]),
    ).toEqual([["docs/oncall/runbook.md", "ops/runbook.md", "copy"]]);
  });

  it("compiles one stub per stale file, scoped to that file, that the hook's gap selection delivers on an edit of it", () => {
    const other = { ...RUNBOOK_MEMORY, id: "m-2", title: "Runbook rows" };
    const drifts = detectPathDrift(
      [RUNBOOK_MEMORY, other],
      tree({
        "docs/runbook.md": RUNBOOK,
        "docs/oncall/runbook.md": RUNBOOK,
        "README.md": "docs/oncall/runbook.md",
      }),
    );
    expect(drifts).toHaveLength(2);
    const stubs = pathDriftStubs(drifts);
    expect(stubs).toHaveLength(1);
    expect(stubs[0]!.scope).toBe("docs/runbook.md");
    expect(stubs[0]!.ref).toMatch(/^drift_[0-9a-f]{8}$/);
    expect(pathDriftStubs(drifts)[0]!.ref).toBe(stubs[0]!.ref);
    const index = { knowledge_gaps: stubs };
    expect(selectKnowledgeGap(index, "docs/runbook.md", new Set())).toBe(stubs[0]);
    expect(selectKnowledgeGap(index, "docs/oncall/runbook.md", new Set())).toBeNull();
    expect(selectKnowledgeGap(index, "docs/runbook.md", new Set([stubs[0]!.ref]))).toBeNull();
  });

  it("renders the session digest notice: one line per stale file, at most five, or nothing", () => {
    const d = (anchor: string, kind: "copy" | "pointer" | "renamed") => ({
      memoryId: "m",
      title: "t",
      anchor,
      current: `new/${anchor}`,
      kind,
      evidence: kind === "copy" ? "README.md" : null,
    });
    expect(renderPathDriftDigest([])).toBeNull();
    expect(
      renderPathDriftDigest([
        d("docs/runbook.md", "copy"),
        d("docs/runbook.md", "copy"),
        d("acme/catalogue.py", "pointer"),
        d("docs/adr/1.md", "renamed"),
      ]),
    ).toBe(
      [
        "Pathrule: knowledge names files the checkout has moved away from. Use the current file, and update the memory (pathrule_update_memory):",
        "- docs/runbook.md → new/docs/runbook.md (README.md names the new one)",
        "- acme/catalogue.py → new/acme/catalogue.py (the old file points there)",
        "- docs/adr/1.md → new/docs/adr/1.md (git renamed it)",
      ].join("\n"),
    );
    const many = renderPathDriftDigest(
      Array.from({ length: 8 }, (_, i) => d(`a/f${i}.md`, "renamed")),
    )!;
    expect(many.split("\n")).toHaveLength(7);
    expect(many).toMatch(/- and 3 more$/);
  });

  it("keeps the line within the gap budget, shortening the title first", () => {
    const long = { ...RUNBOOK_MEMORY, title: "x".repeat(400) };
    const [d] = detectPathDrift(
      [long],
      tree({
        "docs/runbook.md": RUNBOOK,
        "docs/oncall/runbook.md": RUNBOOK,
        "README.md": "docs/oncall/runbook.md",
      }),
    );
    const line = renderPathDriftLine(d!);
    expect(line.length).toBeLessThanOrEqual(PATH_DRIFT_LINE_MAX);
    expect(line).toContain("…");
    expect(line).toContain("docs/oncall/runbook.md");
  });
});
