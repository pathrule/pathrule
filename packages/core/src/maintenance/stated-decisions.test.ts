// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalBackend } from "../backend/local/local-backend.js";
import {
  USER_WORDS_CURSOR,
  USER_WORDS_LEDGER,
  learnFromUserWords,
  saysTheSame,
  statedDecisionMemory,
  statedDecisions,
} from "./stated-decisions.js";

const DEADLINE =
  "504 responses should also tell clients when to retry: add a `Retry-After: 1` header to them. Team decision, from now on: every response header that the toolkit itself adds must be listed in a tuple `ADDED_HEADERS` in `acme/headers.py` (create the module). Register Retry-After now.";
const DOMAIN =
  "Change of decision on error types: we moved the error catalogue to a new domain. Error types created from now on use `https://errors.acme.io/` instead of `https://errors.acme.dev/`; existing ones keep their URLs for now. Then run the team suite and your tests, fix failures, and give me a short summary.";
const SPDX =
  "The 400 must never be sent for requests whose path starts with `/internal/`. Also a team decision: every new source or test file you create starts with the line `# SPDX-License-Identifier: MIT`. Apply it to the files you created.";

describe("what the person stated as lasting", () => {
  it("keeps the sentence with the marker, verbatim, and nothing around it", () => {
    const [d] = statedDecisions(DEADLINE);
    expect(statedDecisions(DEADLINE)).toHaveLength(1);
    expect(d!.quote).toBe(
      "Team decision, from now on: every response header that the toolkit itself adds must be listed in a tuple `ADDED_HEADERS` in `acme/headers.py` (create the module).",
    );
    expect(statedDecisionMemory(d!).title).toBe(
      "Decision: Every response header that the toolkit itself adds must be listed in a",
    );
  });

  it("joins consecutive lasting sentences into one changed decision", () => {
    const ds = statedDecisions(DOMAIN);
    expect(ds).toHaveLength(1);
    expect(ds[0]!.kind).toBe("changed-decision");
    expect(ds[0]!.quote).toMatch(
      /^Change of decision on error types: we moved the error catalogue to a new domain\. Error types created from now on use/,
    );
    expect(ds[0]!.quote).not.toContain("Then run the team suite");
    expect(statedDecisionMemory(ds[0]!).title).toBe(
      "Changed decision: We moved the error catalogue to a new domain",
    );
  });

  it("takes a long 'never' sentence as a rule and a short 'as always' as none", () => {
    const ds = statedDecisions(SPDX);
    expect(ds.map((d) => d.quote)).toEqual([
      "The 400 must never be sent for requests whose path starts with `/internal/`.",
      "Also a team decision: every new source or test file you create starts with the line `# SPDX-License-Identifier: MIT`.",
    ]);
    expect(statedDecisionMemory(ds[1]!).title).toBe(
      "Decision: Every new source or test file you create starts with the line",
    );
    expect(
      statedDecisions(
        "Next App option: `max_query_keys: int = 0`. Same conventions as always. And add tests.",
      ),
    ).toEqual([]);
    expect(statedDecisions("Should we always use the problem format here?")).toEqual([]);
    expect(statedDecisions("/compact")).toEqual([]);
  });

  it("reads nothing out of pasted material: long text, documents, code, lists, or a message that states many things", () => {
    const decision = "Team decision, from now on: every response header that the toolkit itself adds must be listed in `ADDED_HEADERS`.";
    expect(statedDecisions(decision)).toHaveLength(1);
    expect(statedDecisions(`${decision} ${"The review notes follow. ".repeat(70)}`)).toEqual([]);
    expect(statedDecisions(`## Notes from the meeting\n\n${decision}`)).toEqual([]);
    expect(statedDecisions(`[Pasted transcript]\n${decision}`)).toEqual([]);
    expect(statedDecisions(`Look at this:\n\n\`\`\`\n${decision}\n\`\`\``)).toEqual([]);
    expect(statedDecisions(`- always do A\n- never do B\n${decision}`)).toEqual([]);
    expect(statedDecisions(`1- fix the header 2- ${decision} 3- run the tests`)).toEqual([]);
    expect(statedDecisions(`${decision} We decided B. Also a team decision: C holds. Change of decision: D now.`)).toEqual([]);
  });

  it("reads the lines added since the cursor by bytes, so non-ASCII prompts are not skipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-stated-bytes-"));
    try {
      const b = new LocalBackend(":memory:");
      b.registerWorkspace({ workspaceId: "ws", localRootPath: "/repo" });
      const ledger = join(dir, USER_WORDS_LEDGER);
      const line = (text: string) => `${JSON.stringify({ sid: "s1", at: "2026-10-16T10:30:00.000Z", text })}\n`;
      // A first pass over Turkish text with many multi-byte characters, then a decision appended after it.
      writeFileSync(ledger, line("Şöyle düşünüyorum: önce testleri çalıştırıp çıktıyı görelim, sonra değiştiririz. Ğüşiöç ğüşiöç ğüşiöç."));
      expect(await learnFromUserWords(b, "ws", dir, "2026-10-16T11:00:00.000Z")).toBe(0);
      appendFileSync(ledger, line("Ekip kararı: bundan sonra her yeni kaynak dosyası `# SPDX-License-Identifier: MIT` satırıyla başlar."));
      expect(await learnFromUserWords(b, "ws", dir, "2026-10-16T11:01:00.000Z")).toBe(1);
      const root = await b.ensureNodeForPath("ws", "/", "folder");
      const titles = (await b.listMemories({ workspaceId: "ws", nodeId: root.id })).map((m) => m.title);
      expect(titles).toHaveLength(1);
      expect(titles[0]).toMatch(/^Karar: Bundan sonra her yeni kaynak dosyası/);
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("asks the model tier about the prompts the table read nothing in, and saves what it copied through the same path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-stated-tier-"));
    try {
      const b = new LocalBackend(":memory:");
      b.registerWorkspace({ workspaceId: "ws", localRootPath: "/repo" });
      const ledger = join(dir, USER_WORDS_LEDGER);
      const now = "2026-10-16T11:00:00.000Z";
      const line = (text: string) => `${JSON.stringify({ sid: "s1", at: "2026-10-16T10:30:00.000Z", text })}\n`;
      const silentOne = "Mantemos o cache em Redis e não em memória local, já que roda em vários pods.";
      writeFileSync(ledger, line(DEADLINE) + line(silentOne) + line("## pasted\n" + silentOne));
      const asked: string[][] = [];
      const saved = await learnFromUserWords(b, "ws", dir, now, {
        onSilent: async (prompts) => {
          asked.push(prompts.map((p) => p.text));
          return [{ quote: "Mantemos o cache em Redis e não em memória local", kind: "decision", lang: "pt", sid: "s1", at: null }];
        },
      });
      expect(asked).toEqual([[silentOne]]);
      expect(saved).toBe(2);
      const root = await b.ensureNodeForPath("ws", "/", "folder");
      const titles = (await b.listMemories({ workspaceId: "ws", nodeId: root.id })).map((m) => m.title);
      expect(titles).toContain("Decisão: Mantemos o cache em Redis e não em memória local");
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("knows when a memory already says it in other words", () => {
    const quote =
      "Also a team decision: every new source or test file you create starts with the line `# SPDX-License-Identifier: MIT`.";
    expect(
      saysTheSame(
        quote,
        "New files start with SPDX MIT header\nEvery new source or test file starts with the line `# SPDX-License-Identifier: MIT`.",
      ),
    ).toBe(true);
    expect(
      saysTheSame(
        quote,
        "Error type domain\nError types created from now on use https://errors.acme.io/.",
      ),
    ).toBe(false);
  });

  it("saves new statements at the root, typed, skips what the agent saved, and reads only what is new", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-stated-"));
    try {
      const b = new LocalBackend(":memory:");
      b.registerWorkspace({ workspaceId: "ws", localRootPath: "/repo" });
      const root = await b.ensureNodeForPath("ws", "/", "folder");
      await b.writeMemory({
        workspaceId: "ws",
        nodeId: root.id,
        title: "Toolkit-added response headers are registered in ADDED_HEADERS",
        content:
          "Every response header that the toolkit itself adds must be listed in the tuple `ADDED_HEADERS` in `acme/headers.py`.",
      });
      const ledger = join(dir, USER_WORDS_LEDGER);
      const line = (text: string, at = "2026-10-16T10:00:00.000Z") =>
        `${JSON.stringify({ sid: "s1", at, text })}\n`;
      // A first pass reads only recent prompts: an old decision in a long ledger stays where it is.
      writeFileSync(
        ledger,
        line(
          "Team decision, from now on: nothing is ever logged at INFO.",
          "2026-10-01T10:00:00.000Z",
        ) +
          line(DEADLINE) +
          line(DOMAIN),
      );
      expect(await learnFromUserWords(b, "ws", dir, "2026-10-16T11:00:00.000Z")).toBe(1);
      const saved = await b.listMemories({ workspaceId: "ws", nodeId: root.id });
      expect(saved.map((m) => m.title)).toContain(
        "Changed decision: We moved the error catalogue to a new domain",
      );
      const changed = saved.find((m) => m.title.startsWith("Changed decision"))!;
      expect(changed.content).toMatch(
        /^Change of decision on error types: we moved the error catalogue to a new domain\. Error types created from now on use `https:\/\/errors\.acme\.io\/`/,
      );
      expect(changed.content).toContain("Stated by the person in a session on 2026-10-16");
      const binding = (await b.buildKnowledgePayload("ws", "binding"))!.find(
        (x) => x.dir_path === "/",
      )!;
      expect(binding.markdown).toContain("created from now on use `https://errors.acme.io/`");
      expect(readFileSync(join(dir, USER_WORDS_CURSOR), "utf8")).toBe(
        String(readFileSync(ledger).length),
      );
      // The same ledger again: nothing new to read.
      expect(await learnFromUserWords(b, "ws", dir)).toBe(0);
      // A new prompt that repeats the decision: already said. Its age no longer matters once a cursor exists.
      appendFileSync(
        ledger,
        line(
          "Reminder, from now on: error types use `https://errors.acme.io/` instead of `https://errors.acme.dev/`.",
          "2026-10-02T10:00:00.000Z",
        ),
      );
      expect(await learnFromUserWords(b, "ws", dir)).toBe(0);
      appendFileSync(
        ledger,
        line(
          "New rule: nothing is ever logged at INFO level in this toolkit.",
          "2026-10-02T10:00:00.000Z",
        ),
      );
      expect(await learnFromUserWords(b, "ws", dir)).toBe(1);
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
