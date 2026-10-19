// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalBackend } from "../backend/local/local-backend.js";
import { ENDED_TURNS_LEDGER, learnFromEndedTurns, lessonMemory, turnLessons } from "./turn-lessons.js";

let n = 0;
/** A Claude Code transcript: each command and its output, in order. */
function transcript(steps: Array<[cmd: string, out: string, error?: boolean]>): string {
  return steps
    .flatMap(([cmd, out, error]) => {
      const id = `t${++n}`;
      return [
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: cmd } }] } }),
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: out, ...(error ? { is_error: true } : {}) }] } }),
      ];
    })
    .join("\n");
}

const PANIC = "ok  \tgithub.com/acme/gin\t1.6s\npanic: team environment not prepared\n\ngoroutine 1 [running]:";

/** The same, with the session's working directory stamped on every entry, as Claude Code writes it. */
function transcriptIn(cwd: string, steps: Array<[cmd: string, out: string, error?: boolean]>): string {
  return transcript(steps)
    .split("\n")
    .map((line) => JSON.stringify({ ...JSON.parse(line), cwd }))
    .join("\n");
}

const REPO = "/private/tmp/prbpub/runs/go-capability-pathrule-t22/repo";

// PathruleBench go-capability-pathrule-t22, session 3 (2026-10-18), verbatim: four commands in one call,
// whose output ends with the last one's "checkdocs: ok".
const T22_CALL = "gofmt -l .; go vet ./... && go test ./... 2>&1 | tail -20; ACME_TEAM_SUITE=1 go test ./... 2>&1 | tail -20; (cd tools && go run ./checkdocs)";
const T22_OUTPUT = [
  "tests must run with TZ=UTC: the fixtures compare timestamps rendered in UTC",
  "FAIL\tacme.example/toolkit/api\t0.418s",
  "?   \tacme.example/toolkit/cmd/acme\t[no test files]",
  "?   \tacme.example/toolkit/scripts/genlimits\t[no test files]",
  "panic: team environment not prepared",
  "",
  "goroutine 1 [running]:",
  "acme.example/toolkit/teamtests.TestMain(0x37867d584aa0)",
  `\t${REPO}/teamtests/registry_test.go:18 +0x6c`,
  "main.main()",
  "\t_testmain.go:52 +0x88",
  "FAIL\tacme.example/toolkit/teamtests\t0.772s",
  "FAIL",
  "tests must run with TZ=UTC: the fixtures compare timestamps rendered in UTC",
  "FAIL\tacme.example/toolkit/api\t0.643s",
  "?   \tacme.example/toolkit/cmd/acme\t[no test files]",
  "?   \tacme.example/toolkit/scripts/genlimits\t[no test files]",
  "ok  \tacme.example/toolkit/teamtests\t0.322s",
  "FAIL",
  "checkdocs: ok",
].join("\n");
const T22_FIXED = "ok  \tacme.example/toolkit/api\t0.413s\n?   \tacme.example/toolkit/cmd/acme\t[no test files]\n?   \tacme.example/toolkit/scripts/genlimits\t[no test files]\nok  \tacme.example/toolkit/teamtests\t0.664s";

// PathruleBench go-capability-none-t1 (2026-10-18), verbatim: the docs check is its own module under tools/.
const NONE_T1_CALL = "gofmt -l .; go vet ./... ; TZ=UTC go test ./api/ ; TZ=UTC ACME_TEAM_SUITE=1 go test ./... 2>&1 | tail; go run ./tools/checkdocs";
const NONE_T1_OUTPUT = [
  "Exit code 1",
  "ok  \tacme.example/toolkit/api\t0.392s",
  "ok  \tacme.example/toolkit/api\t(cached)",
  "?   \tacme.example/toolkit/cmd/acme\t[no test files]",
  "?   \tacme.example/toolkit/internal/catalogue\t[no test files]",
  "?   \tacme.example/toolkit/scripts/genlimits\t[no test files]",
  "ok  \tacme.example/toolkit/teamtests\t0.442s",
  "main module (acme.example/toolkit) does not contain package acme.example/toolkit/tools/checkdocs",
].join("\n");
const INSPECT_TOOLS: [string, string] = ["ls -la tools tools/checkdocs; cat go.mod; ls tools/checkdocs/go.mod 2>&1; cat tools/checkdocs/main.go", '\tfmt.Println("checkdocs: ok")\n}'];

describe("lessons a turn's own commands taught", () => {
  it("finds the variant that worked after a failure a pipe hid, and says what it needs", () => {
    const lessons = turnLessons(transcript([
      ["go test ./acmetest 2>&1 | tail -20", PANIC],
      ["cat acmetest/main_test.go", "package acmetest"],
      ["ACME_TEAM_SUITE=1 go test -count=1 ./acmetest 2>&1 | tail -5", "ok  \tgithub.com/acme/gin/acmetest\t0.4s"],
    ]));
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.added).toEqual(["ACME_TEAM_SUITE=1"]);
    expect(lessonMemory(lessons[0]!).content).toMatch(/^Running `go test \.\/acmetest` here needs `ACME_TEAM_SUITE=1`/);
    // A call of one command: its output's last line is its own, and stays the evidence.
    expect(lessons[0]!.error).toBe("goroutine 1 [running]:");
  });

  it("never takes another command's output as evidence: the last line of a call belongs to its last command", () => {
    const lessons = turnLessons(transcriptIn(REPO, [
      [T22_CALL, T22_OUTPUT],
      ["TZ=UTC ACME_TEAM_SUITE=1 go test ./... 2>&1 | tail -20", T22_FIXED],
    ]));
    expect(lessons.map((l) => [l.family, l.added])).toEqual([
      ["go test ./...", ["ACME_TEAM_SUITE=1", "TZ=UTC"]],
      ["go test ./...", ["TZ=UTC"]],
    ]);
    for (const l of lessons) {
      expect(l.error).toBe("");
      expect(lessonMemory(l).content).not.toContain("checkdocs");
      expect(lessonMemory(l).content).not.toContain("The failure:");
    }
  });

  it("learns the directory a command needs, from `cd <dir> &&`, a subshell or `-C <dir>`", () => {
    const viaCd = turnLessons(transcriptIn(REPO, [[NONE_T1_CALL, NONE_T1_OUTPUT, true], INSPECT_TOOLS, ["cd tools && go run ./checkdocs 2>&1 | tail", "checkdocs: ok"]]));
    expect(viaCd).toEqual([
      {
        family: "go run ./tools/checkdocs",
        failed: "go run ./tools/checkdocs",
        worked: "cd tools && go run ./checkdocs",
        added: ["cd tools"],
        error: "main module (acme.example/toolkit) does not contain package acme.example/toolkit/tools/checkdocs",
      },
    ]);
    expect(lessonMemory(viaCd[0]!)).toEqual({
      title: "How to run go run ./tools/checkdocs",
      content:
        "Running `go run ./tools/checkdocs` here needs `cd tools`: it failed without it and worked as `cd tools && go run ./checkdocs`.\n\nThe failure: `main module (acme.example/toolkit) does not contain package acme.example/toolkit/tools/checkdocs`",
    });
    const viaFlag = turnLessons(transcriptIn(REPO, [[NONE_T1_CALL, NONE_T1_OUTPUT, true], ["go run -C tools ./checkdocs", "checkdocs: ok"]]));
    expect(viaFlag.map((l) => [l.family, l.added, l.worked])).toEqual([["go run ./tools/checkdocs", ["-C tools"], "go run -C tools ./checkdocs"]]);
    // A subshell's cd ends with it: the command after it runs at the top again.
    const viaSubshell = turnLessons(transcriptIn(REPO, [[NONE_T1_CALL, NONE_T1_OUTPUT, true], ["(cd tools && go run ./checkdocs); go run ./scripts/genlimits", "checkdocs: ok\napi/limits_gen.go is up to date (3 limits)"]]));
    expect(viaSubshell.map((l) => [l.family, l.added])).toEqual([["go run ./tools/checkdocs", ["cd tools"]]]);
    // From a subfolder to another: `../tools/checkdocs` from api/ is the same command.
    const fromApi = turnLessons(transcriptIn(REPO, [["(cd api && go run ../tools/checkdocs)", "main module (acme.example/toolkit) does not contain package acme.example/toolkit/tools/checkdocs", true], ["cd tools && go run ./checkdocs", "checkdocs: ok"]]));
    expect(fromApi.map((l) => [l.added, l.failed])).toEqual([[["cd tools"], "cd api && go run ../tools/checkdocs"]]);
  });

  it("reads no command out of a here-document's body, under a cd or not", () => {
    // PathruleBench go-capability (2026-10-18): a test file written with `cd api && cat > … <<'EOF'`, then
    // written again. Its Go lines are the program's input; read as commands, every line was a "lesson".
    const file = "package api\n\nfunc TestMaxQueryKeysRejects(t *testing.T) {\n\tapp := New(Options{MaxQueryKeys: 2})\n\tfor _, spec := range []string{\"5\", \"-1/minute\"} {\n\t}\n}";
    const lessons = turnLessons(transcriptIn(REPO, [
      [`cat > api/limits_test.go <<'EOF'\n${file}\nEOF\ngo test ./api/ 2>&1 | tail -3`, "tests must run with TZ=UTC: the fixtures compare timestamps rendered in UTC\nFAIL\tacme.example/toolkit/api\t0.4s", true],
      [`cd api && cat > limits_test.go <<'EOF'\n${file}\nEOF\ncd .. && TZ=UTC go test ./api/ -count=1 2>&1 | tail -3`, "ok  \tacme.example/toolkit/api\t0.3s"],
    ]));
    expect(lessons.map((l) => [l.family, l.added])).toEqual([["go test ./api/", ["TZ=UTC"]]]);
  });

  it("reads an agent's cd to its own working directory as the top, and an absolute cd below it as that folder", () => {
    // Agents prefix commands with `cd <repo>;` (PathruleBench, every language): that is no directory lesson.
    const atTop = turnLessons(transcriptIn(REPO, [
      [`cd ${REPO}; python3 -m unittest discover -s tests -t .`, "tests must run with TZ=UTC: the fixtures compare timestamps rendered in UTC\nFAILED (errors=1)", true],
      [`cd ${REPO}; TZ=UTC python3 -m unittest discover -s tests -t .`, "OK"],
    ]));
    expect(atTop.map((l) => l.added)).toEqual([["TZ=UTC"]]);
    // go-capability-claude_md-t1: `cd <repo>/tools; go run ./checkdocs` after `go run ./tools/checkdocs` failed.
    const below = turnLessons(transcriptIn(REPO, [["go run ./tools/checkdocs", NONE_T1_OUTPUT, true], [`cd ${REPO}/tools; go run ./checkdocs; echo exit $?`, "checkdocs: ok\nexit 0"]]));
    expect(below.map((l) => [l.added, l.worked])).toEqual([[["cd tools"], "cd tools && go run ./checkdocs"]]);
    // A directory that cannot be told (another tree, a variable, no recorded working directory) teaches nothing.
    expect(turnLessons(transcriptIn(REPO, [["go run ./tools/checkdocs", NONE_T1_OUTPUT, true], ["cd /elsewhere/tools && go run ./checkdocs", "checkdocs: ok"]]))).toEqual([]);
    expect(turnLessons(transcriptIn(REPO, [["go run ./tools/checkdocs", NONE_T1_OUTPUT, true], ["cd $TOOLS && go run ./checkdocs", "checkdocs: ok"]]))).toEqual([]);
    expect(turnLessons(transcript([["go run ./tools/checkdocs", NONE_T1_OUTPUT, true], [`cd ${REPO}/tools; go run ./checkdocs`, "checkdocs: ok"]]))).toEqual([]);
  });

  it("is no lesson when the fix only looks closer, skips the failure, or the command only inspects", () => {
    expect(turnLessons(transcript([["go test ./x", "--- FAIL: TestA", true], ["go test -v -run TestA ./x", "ok  x 0.1s"]]))).toEqual([]);
    expect(turnLessons(transcript([["python -m pytest tests", "FAILED tests/team/test_a.py\nError: boom", true], ["python -m pytest tests --ignore=tests/team", "== 10 passed"]]))).toEqual([]);
    expect(turnLessons(transcript([["git diff --stat lib/a.js", "Error: bad", true], ["git diff -w --stat lib/a.js", "1 file changed"]]))).toEqual([]);
  });

  // Each pair is a lesson the drain saved on a real workspace (2026-10-18) and the rules folder then
  // carried as a team decision: "How to run command grep FAIL needs -A4", "How to run export auth token)".
  it("reads past wrappers and builtins, and keeps nothing from shell variables, test filters, writes or output formats", () => {
    const none: Array<Array<[string, string, boolean?]>> = [
      [["command grep \"  FAIL \" $L", "", true], ["command grep -A4 \"  FAIL \" $L", "  FAIL  x"]],
      [["command grep -rn \"sqliteDir\" packages", "", true], ["command grep -rn -B12 \"sqliteDir\" packages", "a.ts:1"]],
      [["export GITHUB_TOKEN=$(gh auth token)", "Error: not logged in", true], ["PATHRULE_FP=065f GITHUB_TOKEN=$(gh auth token) node run.mjs", "ok "]],
      [["python3 $W/harness/showcase.py", "Traceback (most recent call last):\n  x", true], ["python3 -I - $W/harness/showcase.py", "done"]],
      [["$T/prefix/bin/pathrule setup claude", "Error: no", true], ["$T/prefix/bin/pathrule setup --no-intelligence claude", "ok "]],
      [["npx vitest run src/home", "FAIL src/home/a.test.ts", true], ["npx vitest run src/home -t \"shows the dashboard\"", "Tests 1 passed"]],
      [["pnpm exec prettier --check a.mjs", "Error: code style issues", true], ["pnpm exec prettier --write a.mjs", "a.mjs 12ms"]],
      [["npm view @pathrule/cli version", "npm ERR! code E404", true], ["npm view @pathrule/cli version --json", "\"1.0.1\""]],
    ];
    for (const steps of none) expect(turnLessons(transcript(steps)), steps[1]![0]).toEqual([]);
    // Another project's commands, reached by a cd out of the session's folder, are that project's.
    expect(turnLessons(transcriptIn(REPO, [
      ["cd /private/tmp/prbpub/runs/ts-t1/repo && node --test teamtests/a.test.ts", "not ok 1 - team suite", true],
      ["cd /private/tmp/prbpub/runs/ts-t1/repo && ACME_TEAM_SUITE=1 node --test teamtests/a.test.ts", "# pass 1"],
    ]))).toEqual([]);

    // A real one still counts, read past `env -u`, and Claude Code's own note is no evidence.
    const tz = turnLessons(transcript([
      ["env -u CI node --test api/a.test.ts", "not ok 1 - renders in UTC\nShell cwd was reset to /repo", true],
      ["TZ=UTC node --test api/a.test.ts", "ok 1 - renders in UTC\n# pass 1"],
    ]));
    expect(tz.map((l) => [l.family, l.added])).toEqual([["node api/a.test.ts", ["TZ=UTC"]]]);
    expect(lessonMemory(tz[0]!).content).not.toContain("Shell cwd was reset");
  });

  it("saves each lesson once at the root, typed, and consumes the ledger", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-turn-lessons-"));
    try {
      const b = new LocalBackend(":memory:");
      b.registerWorkspace({ workspaceId: "ws", localRootPath: "/repo" });
      const file = join(dir, "session.jsonl");
      writeFileSync(file, transcript([["go test ./acmetest | tail", PANIC], ["ACME_TEAM_SUITE=1 go test ./acmetest", "ok  acmetest 0.2s"]]));
      const ledger = () => writeFileSync(join(dir, ENDED_TURNS_LEDGER), `${JSON.stringify({ sid: "s1", transcript: file })}\n`);
      ledger();
      expect(await learnFromEndedTurns(b, "ws", dir)).toBe(1);
      expect(existsSync(join(dir, ENDED_TURNS_LEDGER))).toBe(false);
      const root = await b.ensureNodeForPath("ws", "/", "folder");
      const saved = await b.listMemories({ workspaceId: "ws", nodeId: root.id });
      expect(saved.map((m) => m.title)).toEqual(["How to run go test ./acmetest"]);
      const binding = (await b.buildKnowledgePayload("ws", "binding"))!.find((x) => x.dir_path === "/")!;
      expect(binding.markdown).toContain("needs `ACME_TEAM_SUITE=1`");
      ledger();
      expect(await learnFromEndedTurns(b, "ws", dir)).toBe(0);
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
