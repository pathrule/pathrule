// SPDX-License-Identifier: Apache-2.0
// The question this channel has to answer is "did the required verification pass in this
// session", and the failure that matters is a FALSE PASS. So most of these tests assert
// that something is NOT recognised.

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  classifyVerificationCommand,
  collectSessionVerifications,
  requiredVerificationPassed,
  isConcreteGoTestCommand,
  classifyVerificationEvidenceCommand,
  confirmedVerificationResult,
} from "./verification-evidence.js";

function fp(command: string): string | null {
  return classifyVerificationCommand(command)?.fingerprint ?? null;
}
function strict(command: string): string | null {
  return classifyVerificationEvidenceCommand(command)?.fingerprint ?? null;
}
function evidence(command: string, passed: boolean, at = "2026-09-03T10:00:00Z") {
  return {v:fp(command),v2:strict(command),verificationOk:passed,ok:passed?1:0,at};
}

describe("concrete Python, Cargo and Go verification identities", () => {
  it.each([
    ["python -m pytest tests/receiver", "python"],
    ["python3 -m pytest -q tests/receiver", "python3"],
    ["cargo test --locked", "cargo"],
    ["cargo test --workspace --locked", "cargo"],
    ["cargo test --workspace", "cargo"],
    ["cargo test --locked --package receiver --test protocol", "cargo"],
    ["cargo test --features=serde,codec receiver", "cargo"],
    ["go test ./...", "go"],
    ["go test -race -count=1 ./receiver/...", "go"],
    ["cd packages/receiver && go test ./...", "go"],
  ])("identifies the concrete invocation %s without running it", (command, runner) => {
    expect(classifyVerificationCommand(command)).toMatchObject({ runner });
    const fingerprint = fp(command)!;
    expect(fingerprint).not.toBeNull();
    expect(requiredVerificationPassed(command, [evidence(command,true)]).passed).toBe(true);
    expect(requiredVerificationPassed(command, [evidence(command,false)]).passed).toBe(false);
  });
  it.each([
    ["python -m pytest tests/receiver", "python -m pytest tests/sender"],
    ["python -m pytest tests/receiver", "python3 -m pytest tests/receiver"],
    ["python -m pytest -k receiver", "python -m pytest -k sender"],
    ["cargo test --locked", "cargo test"],
    ["cargo test --package receiver", "cargo test --package sender"],
    ["cargo test --test receiver", "cargo test --test sender"],
    ["cargo test --features=serde,codec", "cargo test --features=serde codec"],
    ["go test ./receiver/...", "go test ./sender/..."],
    ["go test -count=1 ./...", "go test -count=2 ./..."],
    ["go test ./...", "cd packages/receiver && go test ./..."],
  ])("cannot satisfy %s with the different target/flags %s", (required, observed) => {
    expect(fp(required)).not.toBeNull();expect(fp(observed)).not.toBeNull();expect(fp(required)).not.toBe(fp(observed));
    expect(requiredVerificationPassed(required, [{ v: fp(observed), ok: 1 }]).passed).toBe(false);
  });
  it("normalizes only token whitespace/quoting, preserving argument order and boundaries", () => {
    expect(fp('python   -m pytest "tests/receiver"')).toBe(fp("python -m pytest tests/receiver"));
    expect(fp("go test -count=1 ./...")).not.toBe(fp("go test ./... -count=1"));
    expect(fp("cargo test --features 'codec'")).toBe(fp("cargo test --features codec"));
    expect(fp('cd "packages/receiver" && go test "./..."')).toBe(fp("cd packages/receiver && go test ./..."));
    expect(fp('pushd packages/receiver && go test ./...')).toBe(fp("cd packages/receiver && go test ./..."));
  });
  it.each([
    ["cargo test --features '' codec", "cargo test --features codec"],
    ['cargo test --features "" codec', "cargo test --features codec"],
    ["cargo test --features 'codec", "cargo test --features codec"],
    ['cargo test --features "codec', "cargo test --features codec"],
    ["command go test ./...", "go test ./..."],
    ["time go test ./...", "go test ./..."],
    ["pushd +1 && go test ./...", "cd +1 && go test ./..."],
    ["pushd -1 && go test ./...", "go test ./..."],
  ])("cannot convert erased syntax in %s to a PASS from %s", (ambiguous, concrete) => {
    const fingerprint = fp(concrete);
    expect(fingerprint).not.toBeNull();
    expect(fp(ambiguous)).toBeNull();
    expect(requiredVerificationPassed(ambiguous, [{v:fingerprint,ok:1}]).passed).toBe(false);
    expect(requiredVerificationPassed(concrete, [{v:fp(ambiguous),ok:1}]).passed).toBe(false);
  });
  it.each([
    "python -m other pytest", "python tests/check.py pytest", "cargo run test", "go run test",
    "python -m pytest --watch", "cargo test --watch=1", "go test -w ./...",
    "python -m pytest tests/<receiver>", "cargo test --package ${PACKAGE}", "go test ./<package>/...",
    "python -m pytest /private/tests", "python -m pytest ../tests", "cargo test --manifest-path /private/Cargo.toml", "go test /private/...",
    "python -m pytest -k", "python -m pytest -k -q", "cargo test --package", "go test -count",
    "python -m pytest | tail -1", "cargo test || true", "go test ./...; true", "go test ./... && echo done", "python -m pytest && cargo test",
    "go test ./... &", "go test ./... > result.txt", "GOFLAGS=-short go test ./...", "python -m pytest `other`",
    "cd ../receiver && go test ./...", "cd packages/receiver packages/sender && go test ./...", "cd -P packages/receiver && go test ./...",
    "node scripts/check.py", "bash scripts/check.sh",
  ])("refuses unresolved/unsafe command %s", command => {
    expect(fp(command)).toBeNull();
  });
  it("recognizes Go recursive package arguments without opening arbitrary ellipsis templates", () => {
    expect(isConcreteGoTestCommand("go test ./...")).toBe(true);
    expect(isConcreteGoTestCommand("go test ./receiver/...")).toBe(true);
    for (const command of ["go test ...", "go test ./<package>/...", "go test ../...", "go test ./... || true", "npm run test..."]) expect(isConcreteGoTestCommand(command)).toBe(false);
  });
  it("does not reinterpret cargo's boolean workspace flag as a package-manager scope", () => {
    expect(classifyVerificationCommand("cargo test --workspace --locked")).toMatchObject({scope:null,scope_kind:null});
    expect(classifyVerificationCommand("cd packages/receiver && cargo test --workspace --locked")).toMatchObject({scope:"packages/receiver",scope_kind:"dir"});
  });
});

describe("the five real command forms", () => {
  it("recognises each one, including the three the cat classifier calls unknown", () => {
    expect(fp("pnpm --filter @pathrule/shared test")).toBe("pnpm:test@package:@pathrule/shared");
    expect(fp("pnpm -F @pathrule/shared test")).toBe("pnpm:test@package:@pathrule/shared");
    expect(fp("cd packages/shared && pnpm vitest run")).toBe("vitest@dir:packages/shared");
    expect(fp("pnpm -r test")).toBe("pnpm:test@recursive");
    // The real `test` script of core, cli, mcp-server and cloud-backend. `cat` calls this
    // `execution`, which is a confident wrong answer rather than a missing one.
    expect(fp("node scripts/with-sqlite-native.mjs vitest run")).toBe("vitest");
  });
});

describe("fingerprint stability", () => {
  it("is unchanged by flag order, extra flags, quoting and whitespace", () => {
    const canonical = "pnpm:test@package:@pathrule/shared";
    for (const variant of [
      "pnpm --filter @pathrule/shared test",
      "pnpm --filter=@pathrule/shared test",
      "pnpm -F @pathrule/shared test",
      "pnpm   --filter   @pathrule/shared   test",
      'pnpm --filter "@pathrule/shared" test',
      "pnpm --filter @pathrule/shared --silent test",
      "pnpm --silent --filter @pathrule/shared test",
    ]) {
      expect(fp(variant), variant).toBe(canonical);
    }
  });

  it("is unchanged by wrappers and env prefixes", () => {
    expect(fp("time pnpm test")).toBe("pnpm:test");
    expect(fp("CI=1 pnpm test")).toBe("pnpm:test");
    expect(fp("env CI=1 pnpm test")).toBe("pnpm:test");
  });

  it("is unchanged by a redirect, which does not move the exit code", () => {
    expect(fp("pnpm test > out.log")).toBe("pnpm:test");
    expect(fp("pnpm test 2> err.log")).toBe("pnpm:test");
  });

  it("treats a trailing slash and a ./ prefix on a directory scope as the same scope", () => {
    expect(fp("cd ./packages/shared/ && pnpm vitest run")).toBe("vitest@dir:packages/shared");
    expect(fp("cd packages/shared && pnpm vitest run")).toBe("vitest@dir:packages/shared");
  });
});

describe("different verifications stay different", () => {
  it("separates packages", () => {
    expect(fp("pnpm --filter @pathrule/shared test")).not.toBe(fp("pnpm --filter @pathrule/core test"));
    expect(fp("cd packages/shared && pnpm vitest run")).not.toBe(fp("cd packages/core && pnpm vitest run"));
  });

  it("separates targets within one package", () => {
    expect(fp("pnpm --filter @pathrule/app test")).not.toBe(fp("pnpm --filter @pathrule/app test:runtime"));
  });

  it("separates a recursive run from a root run", () => {
    expect(fp("pnpm -r test")).toBe("pnpm:test@recursive");
    expect(fp("pnpm test")).toBe("pnpm:test");
    expect(fp("pnpm -r test")).not.toBe(fp("pnpm test"));
  });

  it("separates a narrowed run from the suite, so one file cannot vouch for all of them", () => {
    expect(fp("pnpm vitest run")).toBe("vitest");
    expect(fp("pnpm vitest run src/hook-supervisor/x.test.ts")).toBe("vitest#narrowed");
    expect(fp("pnpm vitest run")).not.toBe(fp("pnpm vitest run src/x.test.ts"));
  });

  it("separates runners", () => {
    expect(fp("jest")).toBe("jest");
    expect(fp("pytest")).toBe("pytest");
    expect(fp("vitest run")).toBe("vitest");
  });
});

describe("fail closed", () => {
  it("refuses a piped command, because the exit code belongs to the last stage", () => {
    // The failure this prevents: a FAILING suite piped to `tail` exits 0 and would be
    // recorded as a pass.
    expect(fp("pnpm test | tail -20")).toBeNull();
    expect(fp("pnpm test 2>&1 | tail -20")).toBeNull();
    expect(fp("pnpm test || true")).toBeNull();
  });

  it("refuses a scope it cannot name", () => {
    expect(fp("cd /Users/someone/repo/packages/shared && pnpm vitest run")).toBeNull();
    expect(fp("cd ~/repo && pnpm test")).toBeNull();
    expect(fp("pnpm --filter './packages/*' test")).toBeNull();
    expect(fp("pnpm --filter /abs/pkg test")).toBeNull();
  });

  it("refuses two verifications on one line, because ok is one value", () => {
    expect(fp("pnpm test && pnpm typecheck")).toBeNull();
    expect(fp("pnpm --filter @pathrule/shared test && pnpm --filter @pathrule/core test")).toBeNull();
  });

  it("refuses commands that carry no identity at all", () => {
    // A command with no runner and no script name has nothing stable to be identified
    // by. Note what is NOT in this list any more: `pnpm build` and `pnpm dev` DO get an
    // identity now. A fingerprint is not a claim that a command verifies anything, and
    // the attempt to make it one rejected two commands a person had correctly named.
    // See the module docblock.
    for (const c of [
      "git status",
      "cat package.json",
      "rm -rf dist",
      "node scripts/build.mjs",
      "bash packages/mobile/Scripts/protocol-parity.sh",
      "",
      "   ",
    ]) {
      expect(fp(c), c).toBeNull();
    }
  });

  it("refuses a watch-mode run, because its exit code says nothing", () => {
    // `pnpm test:watch` is `vitest` with no `run`. The old name-keyword gate accepted it
    // because the NAME contained "test", and it produced the SAME fingerprint as the
    // one-shot suite: a watch session could have satisfied a real requirement.
    expect(fp("pnpm vitest")).toBeNull();
    expect(fp("vitest")).toBeNull();
    expect(fp("pnpm --filter @pathrule/app exec vitest")).toBeNull();
    expect(fp("pnpm vitest run --watch")).toBeNull();
    expect(fp("pnpm test -- --watch")).toBeNull();
    // The one-shot forms still work, and `--run` is accepted as vitest's own alias.
    expect(fp("pnpm vitest run")).toBe("vitest");
    expect(fp("vitest --run")).toBe("vitest");
  });

  it("gives an identity to the real gates the old gate refused", () => {
    // The two commands the feasibility study measured as correctly extracted and wrongly
    // rejected. Neither name contains a verification word.
    expect(fp("pnpm --filter @pathrule/app build-storybook")).toBe(
      "pnpm:build-storybook@package:@pathrule/app",
    );
    expect(fp("pnpm web:prod-security")).toBe("pnpm:web:prod-security");
  });

  it("never puts an absolute path or a raw command in the fingerprint", () => {
    const signals = [
      "pnpm --filter @pathrule/shared test",
      "cd packages/shared && pnpm vitest run",
      "pnpm vitest run src/x.test.ts",
      "node scripts/with-sqlite-native.mjs vitest run",
    ].map((c) => classifyVerificationCommand(c));
    for (const s of signals) {
      expect(s).not.toBeNull();
      expect(s!.fingerprint).not.toContain("/Users");
      expect(s!.fingerprint).not.toContain("~");
      expect(s!.fingerprint).not.toContain(" ");
      // The wrapper script's own path must not survive into the identity.
      expect(s!.fingerprint).not.toContain("with-sqlite-native");
    }
  });

  it("tolerates junk without throwing", () => {
    for (const c of [null, undefined, 42, {}, "pnpm --filter", "cd", "&&", "|||"] as unknown[]) {
      expect(() => classifyVerificationCommand(c)).not.toThrow();
    }
  });
});

describe("the widening cannot produce a false PASS", () => {
  // Removing the name-keyword gate means every script invocation now has an identity.
  // The safety property was never that gate: it is exact fingerprint matching plus the
  // exit-code rules. These assert that directly, one path per way it could go wrong.
  const ROW = (v: string, ok: 0 | 1) => ({ v, ok, at: "2026-09-03T10:00:00.000Z" });

  it("an ordinary script passing does not satisfy a test requirement", () => {
    const rows = [ROW("pnpm:build@package:@pathrule/shared", 1)];
    expect(requiredVerificationPassed("pnpm --filter @pathrule/shared test", rows).passed).toBe(false);
  });

  it("a watch session cannot satisfy the one-shot suite", () => {
    // There is no fingerprint to record for a watch run at all, so there is nothing that
    // could match. Asserted from both ends.
    expect(classifyVerificationCommand("pnpm vitest")).toBeNull();
    expect(requiredVerificationPassed("pnpm vitest run", [ROW("vitest", 0)]).passed).toBe(false);
  });

  it("a piped run of the exact required command still satisfies nothing", () => {
    // Its exit code belonged to `tail`, so it never earned a fingerprint.
    expect(classifyVerificationCommand("pnpm --filter @pathrule/shared test | tail -5")).toBeNull();
  });

  it("a FAILING run of the exact required command does not satisfy it", () => {
    const rows = [ROW("pnpm:test@package:@pathrule/shared", 0)];
    expect(requiredVerificationPassed("pnpm --filter @pathrule/shared test", rows).passed).toBe(false);
  });

  it("the newly reachable gates match only themselves", () => {
    const storybook = classifyVerificationCommand("pnpm --filter @pathrule/app build-storybook")!;
    const security = classifyVerificationCommand("pnpm web:prod-security")!;
    expect(storybook.fingerprint).not.toBe(security.fingerprint);
    // `build` in one package is not `build` in another, and neither is `build-storybook`.
    expect(fp("pnpm --filter @pathrule/app build")).not.toBe(storybook.fingerprint);
    expect(fp("pnpm --filter @pathrule/admin build")).not.toBe(fp("pnpm --filter @pathrule/web build"));
    // A pass of the plain build does not satisfy the storybook gate.
    expect(
      requiredVerificationPassed("pnpm --filter @pathrule/app build-storybook", [
        ROW("pnpm:build@package:@pathrule/app", 1),
      ]).passed,
    ).toBe(false);
  });
});

describe("session evidence", () => {
  it("folds strict rows per identity and lets the last result win", () => {
    const shared="pnpm --filter @pathrule/shared test",core="pnpm --filter @pathrule/core test";
    const rows=[evidence(shared,true,"2026-09-03T10:00:00Z"),evidence(shared,false,"2026-09-03T11:00:00Z"),evidence(core,true,"2026-09-03T10:30:00Z")];
    expect(collectSessionVerifications(rows)).toEqual([
      {fingerprint:strict(shared),runs:2,passed:false,last_at:"2026-09-03T11:00:00Z"},
      {fingerprint:strict(core),runs:1,passed:true,last_at:"2026-09-03T10:30:00Z"},
    ].sort((a,b)=>a.fingerprint!.localeCompare(b.fingerprint!)));
    expect(requiredVerificationPassed(shared,rows).passed).toBe(false);
  });
  it("ignores legacy lossy and missing identities as proof of a PASS", () => {
    expect(collectSessionVerifications([{v:"pytest#narrowed",ok:1},{ok:1},{}])).toEqual([]);
    expect(requiredVerificationPassed("pytest tests/receiver",[{v:fp("pytest tests/receiver"),ok:1}]).passed).toBe(false);
  });
  it("matches documented filter aliases while preserving script and scope", () => {
    const command="pnpm --filter @pathrule/shared test";
    expect(requiredVerificationPassed("pnpm -F @pathrule/shared test",[evidence(command,true)])).toEqual({known:true,passed:true,fingerprint:strict(command)});
    expect(strict("pnpm --filter=@pathrule/shared test")).toBe(strict(command));
    expect(requiredVerificationPassed(command,[evidence("pnpm --filter @pathrule/core test",true)]).passed).toBe(false);
  });
  it("needs explicit verification confirmation even when generic tool telemetry says success", () => {
    const command="pnpm test",row=evidence(command,true);
    expect(requiredVerificationPassed(command,[{...row,verificationOk:undefined,ok:1}]).passed).toBe(false);
    expect(requiredVerificationPassed(command,[row,{...row,verificationOk:false}]).passed).toBe(false);
  });
  it("marks an unfingerprintable requirement as unknown rather than satisfied", () => {
    expect(requiredVerificationPassed("bash scripts/check.sh",[])).toEqual({known:false,passed:false,fingerprint:null});
  });
});

describe("strict versioned evidence without stored-identity migration", () => {
  it.each([
    ["pytest tests/receiver","pytest tests/sender"],
    ["jest --runInBand tests/receiver.test.ts","jest --runInBand tests/sender.test.ts"],
    ["pytest","pytest --collect-only"],
    ["jest","jest --listTests"],
    ["npm run verify -- --receiver","npm run verify -- --sender"],
    ["pnpm test","pnpm --version test"],
    ["pnpm --filter @pathrule/app --filter @pathrule/core test","pnpm --filter @pathrule/app test"],
    ["node scripts/check-real.mjs jest","node scripts/noop.mjs jest"],
    ["pytest","PYTHONPATH=other pytest"],
    ["pnpm run verify -- -F receiver","pnpm run verify -- --filter receiver"],
    ["pnpm --dir -F test","pnpm --dir --filter test"],
    ["pnpm -- --filter=@pathrule/core test","pnpm -- --filter @pathrule/core test"],
  ])("does not confuse %s with %s",(required,observed)=>{
    expect(strict(required)).not.toBeNull();expect(strict(observed)).not.toBeNull();
    expect(strict(required)).not.toBe(strict(observed));
    expect(requiredVerificationPassed(required,[evidence(observed,true)]).passed).toBe(false);
  });
  it.each(["pytest tests/receiver; true","pytest tests/receiver &","pytest tests/receiver | tail -1","pytest tests/receiver && echo done","pytest tests/receiver > /dev/null","pytest tests/receiver''","pytest 'tests/receiver","pushd +1 && pytest","/other/bin/pytest","C:/tools/pytest","checkAlias","npm.cmd test"])("refuses unsafe or unattested evidence %s",command=>{
    expect(strict(command)).toBeNull();
    expect(requiredVerificationPassed("pytest tests/receiver",[evidence(command,true)]).passed).toBe(false);
  });
  it.each(["pnpm --filter @pathrule/shared test","pnpm -F @pathrule/shared test","cd packages/shared && pnpm vitest run","pnpm -r test","node scripts/with-sqlite-native.mjs vitest run","python -m pytest tests/receiver","cargo test --locked","go test ./..."])("supports the required command form %s",command=>{
    expect(requiredVerificationPassed(command,[evidence(command,true)]).passed).toBe(true);
    expect(requiredVerificationPassed(command,[evidence(command,false)]).passed).toBe(false);
  });
  it("matches a reference SHA-256 digest and logs no raw arguments",()=>{
    for(const command of ["pytest","pnpm test","pytest "+"x".repeat(100)]) {
      const identity=[command.split(" ")];
      expect(strict(command)).toBe("verification.v2:"+createHash("sha256").update(JSON.stringify(identity)).digest("hex"));
    }
    const command="AUTH_TOKEN=private-token-value pnpm test";
    expect(strict(command)).toMatch(/^verification\.v2:[a-f0-9]{64}$/);
    expect(strict(command)).not.toContain("private-token-value");
  });
  it("normalizes valid quotation/whitespace only, keeping token boundaries",()=>{
    expect(strict('pytest "tests/receiver"')).toBe(strict("pytest tests/receiver"));
    expect(strict("pytest tests/receiver tests/sender")).not.toBe(strict("pytest tests/receivertests/sender"));
  });
  it("requires adapter attestation for explicit is_error:false",()=>{
    expect(confirmedVerificationResult({is_error:false})).toBeNull();
    expect(confirmedVerificationResult({is_error:false},false,true)).toBe(true);
    expect(confirmedVerificationResult({exit_code:0})).toBe(true);
    for(const response of [{exit_code:1},{exit_code:0,is_error:true},{exit_code:0,interrupted:true},{exit_code:0,signal:"SIGTERM"}])expect(confirmedVerificationResult(response)).toBe(false);
    for(const response of [{stdout:"1 failed"},{},{exit_code:NaN},{exit_code:.5}])expect(confirmedVerificationResult(response)).toBeNull();
    for(const exit_code of ["1","0",null,undefined,{},NaN,.5])expect(confirmedVerificationResult({exit_code,is_error:false},false,true)).toBeNull();
    expect(confirmedVerificationResult({exit_code:0},true)).toBe(false);
  });
});

describe('opaque single-command CHECK evidence',()=>{
 const command='northstar-check audit --strict';
 it('matches only the exact argv and an explicitly observed successful exit',()=>{
  expect(fp(command)).toBeNull();
  expect(strict(command)).toMatch(/^verification\.v2:[a-f0-9]{64}$/);
  expect(requiredVerificationPassed(command,[evidence(command,true)]).passed).toBe(true);
  expect(requiredVerificationPassed(command,[evidence(command,false)]).passed).toBe(false);
  expect(requiredVerificationPassed(command,[{v2:strict(command),ok:1}]).passed).toBe(false);
  for(const other of ['northstar-check audit','northstar-check audit --relaxed','northstar-check --strict audit','other-check audit --strict']){
   expect(strict(other)).not.toBe(strict(command));
   expect(requiredVerificationPassed(command,[evidence(other,true)]).passed).toBe(false);
  }
 });
 it.each([
  'northstar-check audit | tail -1','northstar-check audit && true','northstar-check audit; true',
  'northstar-check audit > out','northstar-check audit &','northstar-check audit `echo ok`',
  'northstar-check audit ${MODE}','northstar-check audit <scope>','northstar-check audit --target=/private',
  'northstar-check audit --target=../other','northstar-check audit --watch','northstar-check audit --file=src/check.ts',
  'bash scripts/check.sh','git status',
 ])('refuses unsafe or ambiguous opaque invocation %s',unsafe=>{
  expect(strict(unsafe)).toBeNull();
  expect(requiredVerificationPassed(unsafe,[evidence(command,true)]).passed).toBe(false);
 });
});


describe("opaque CHECK grammar: bounds, wrappers and exact tokens", () => {
  it.each(["nohup nice", "nice nohup", "nohup X=1", "nice nohup X=1 Y=2"])("fails closed instead of throwing on wrapper-only %s", command => {
    expect(() => classifyVerificationEvidenceCommand(command)).not.toThrow();
    expect(strict(command)).toBeNull();
    expect(() => requiredVerificationPassed(command, [])).not.toThrow();
  });
  it.each([
    "nohup northstar-check audit", "nice northstar-check audit", "time northstar-check audit", "env northstar-check audit",
    "sudo northstar-check audit", "command northstar-check audit", "exec northstar-check audit",
    "dash -c ls", "ksh -c ls", "csh -c ls", "tcsh -c ls", "pwsh -c ls", "xargs northstar-check", "eval northstar-check",
  ])("refuses a wrapper or shell as the custom binary: %s", command => {
    expect(strict(command)).toBeNull();
  });
  it("matches argv exactly, never by prefix, order, spacing or case", () => {
    const command = "northstar-check audit --strict";
    const required = strict(command);
    expect(required).not.toBeNull();
    for (const other of ["northstar-check audit --strict --extra", "Northstar-check audit --strict", "northstar-check audit --STRICT", "northstar-check audit --strict=1"]) {
      expect(strict(other), other).not.toBe(required);
      expect(requiredVerificationPassed(command, [evidence(other, true)]).passed, other).toBe(false);
    }
    // Spacing and quoting are not normalised into the same identity: they are refused.
    for (const spaced of ["northstar-check  audit --strict", " northstar-check audit --strict", "northstar-check audit --strict ", "northstar-check\taudit", 'northstar-check "audit" --strict', "northstar-check audit\t--strict"]) {
      expect(strict(spaced), JSON.stringify(spaced)).toBeNull();
    }
  });
  it("bounds the binary, argument count, token and total length", () => {
    const binary = "a" + "b".repeat(63);
    expect(strict(`${binary} run`)).not.toBeNull();
    expect(strict(`${binary}c run`)).toBeNull();
    const sixteen = Array.from({ length: 16 }, (_, i) => `a${i}`).join(" ");
    expect(strict(`northstar-check ${sixteen}`)).not.toBeNull();
    expect(strict(`northstar-check ${sixteen} a16`)).toBeNull();
    expect(strict(`northstar-check ${"x".repeat(120)}`)).not.toBeNull();
    expect(strict(`northstar-check ${"x".repeat(121)}`)).toBeNull();
    const long = `northstar-check ${Array.from({ length: 3 }, () => "y".repeat(100)).join(" ")}`;
    expect(long.length).toBeGreaterThan(300);
    expect(strict(long)).toBeNull();
  });
  it.each([
    "./bin/northstar-check audit", "bin/northstar-check audit", "/usr/bin/northstar-check audit", "~/northstar-check audit",
    "C:check audit", "northstar-check audit:all", "northstar-check src/check.ts", "northstar-check audit --x=~",
    "northstar-check audit *", "northstar-check audit ?", "northstar-check audit {a,b}", "northstar-check audit #x",
    "northstar-check audit !x", "northstar-check audit %PATH%", "northstar-check audit 'a b'", "northstar-check audit \u0430",
    "nоrthstar-check audit", "northstar-check аudit", "northstar-check audit\u00a0--strict",
  ])("refuses a path, glob, quote, expansion or non-ASCII token: %s", command => {
    expect(strict(JSON.parse(`"${command.replace(/"/g, '\\"')}"`))).toBeNull();
  });
});

describe("Node builtin test verification identity", () => {
  it.each(["node --test", "node --test tests/highlight.test.mjs", "node --test tests/a.js tests/b.cjs", 'node --test "tests/a.js"', "cd packages/shared && node --test tests/a.js"])("admits exact terminating JS invocation %s", command => {
    expect(classifyVerificationCommand(command)?.runner).toBe("node");
    expect(strict(command)).toMatch(/^verification\.v2:/);
    expect(requiredVerificationPassed(command, [evidence(command, true)]).passed).toBe(true);
    expect(requiredVerificationPassed(command, [evidence(command, false)]).passed).toBe(false);
  });
  it.each([
    "node --test --watch", "node --test --test-name-pattern=foo tests/a.js", "node --test --import loader.mjs", "node --test --eval foo", "node --test -e foo",
    "node --test ../a.js", "node --test /private/a.js", "node --test C:/a.js", "node --test tests/*.js", "node --test tests/a.ts", "node --test tests/a.js extra", "node --test tests/a.js -- other",
    "node --test tests/a.js; true", "node --test tests/a.js && echo done", "node --test tests/a.js | tail -1", "node --test tests/a.js > out", "node --test tests/a.js &", "NODE_OPTIONS=--import=loader.mjs node --test tests/a.js", "/other/node --test tests/a.js", "command node --test tests/a.js", "sudo node --test tests/a.js", "node --test tests/a.js''", "node --test 'tests/a.js", "cd ../shared && node --test tests/a.js", "node --test vitest"
  ])("refuses unsupported Node semantics %s", command => {
    expect(classifyVerificationCommand(command)).toBeNull();
    expect(strict(command)).toBeNull();
    expect(requiredVerificationPassed("node --test tests/a.js", [evidence(command, true)]).passed).toBe(false);
  });
  it("cannot satisfy the full suite or another file, argv order or directory", () => {
    const command = "node --test tests/a.js";
    for (const other of ["node --test", "node --test tests/b.js", "node --test tests/a.js tests/b.js", "cd packages/shared && node --test tests/a.js"]) {
      expect(fp(command)).not.toBe(fp(other));expect(strict(command)).not.toBe(strict(other));
      expect(requiredVerificationPassed(other, [evidence(command, true)]).passed).toBe(false);
    }
    expect(strict("node --test tests/a.js tests/b.js")).not.toBe(strict("node --test tests/b.js tests/a.js"));
    expect(fp(command)).toBe("node:test[tests%2Fa.js]#narrowed");
    expect(strict('node --test "tests/a.js"')).toBe(strict(command));
    expect(requiredVerificationPassed(command, [{v:fp(command),ok:1}]).passed).toBe(false);
    expect(fp("node scripts/with-sqlite-native.mjs vitest run")).toBe("vitest");
  });
});
