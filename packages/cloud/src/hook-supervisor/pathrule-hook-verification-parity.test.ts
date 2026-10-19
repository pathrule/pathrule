// SPDX-License-Identifier: Apache-2.0
// The hook script cannot import from packages/shared, so it carries an inline mirror of
// `verification-evidence.ts`. Two implementations of "did the required verification
// pass" would eventually disagree, and the disagreement would surface as a false PASS on
// one client and not the other. This runs the same command table through both.
//
// The TS side is called directly; the hook side is driven end to end, as Claude Code
// drives it, and read back out of the outcome buffer it writes.

import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { classifyVerificationCommand, classifyVerificationEvidenceCommand, requiredVerificationPassed } from "@pathrule/agent-ir/verification/verification-evidence.js";

// The open hook, with the extensions this behaviour needs beside it, the way the official build installs them.
const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "../../../integrations/src/hook-supervisor/pathrule-hook.js");
const CLOUD_EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook-cloud.cjs");
const WORKSPACE_ID = "ws-verification-parity";

/**
 * Every form that matters, and every form that must be refused. Kept as one table so a
 * drift on either side fails on the same row.
 */
const COMMANDS: string[] = [
  // Built-in Node tests retain argv identity in both mirrors.
  "node --test",
  "node --test tests/highlight.test.mjs",
  "node --test tests/a.js tests/b.cjs",
  "node --test tests/b.cjs tests/a.js",
  "cd packages/shared && node --test tests/a.js",
  "node --test --watch",
  "node --test --import loader.mjs",
  "node --test tests/*.js",
  "node --test ../a.js",
  "node --test tests/a.js; true",
  "node --test tests/a.js && echo done",
  "NODE_OPTIONS=--import=loader.mjs node --test tests/a.js",
  "/other/node --test tests/a.js",
  "node --test vitest",

  // Concrete CHECK capability repairs: exact targets/flags remain part of identity.
  "python -m pytest tests/receiver",
  "python -m pytest tests/sender",
  "python3 -m pytest -q tests/receiver",
  "python -m other pytest",
  "python -m pytest -k -q",
  "python -m pytest tests/<receiver>",
  "python -m pytest ../tests",
  "python -m pytest | tail -1",
  "cargo test --locked",
  "cargo test --workspace",
  "cargo test --workspace --locked",
  "cd packages/receiver && cargo test --workspace --locked",
  "cargo test",
  "cargo test --package receiver --test protocol",
  "cargo test --package sender --test protocol",
  "cargo test --features=serde,codec",
  "cargo test --features=serde codec",
  "cargo test --package ${PACKAGE}",
  "cargo test --watch=1",
  "cargo test || true",
  "go test ./...",
  "go test ./receiver/...",
  "go test ./sender/...",
  "go test -race -count=1 ./...",
  "cd packages/receiver && go test ./...",
  "cd ../receiver && go test ./...",
  "cd packages/receiver packages/sender && go test ./...",
  "cd -P packages/receiver && go test ./...",
  "go test ./<package>/...",
  "go test ../...",
  "go test ./...; true",
  "go test ./... && echo done",
  "go test ./... &",
  "go test ./... > result.txt",
  "GOFLAGS=-short go test ./...",
  'cargo test --features "codec"',
  'cd "packages/receiver" && go test "./..."',
  "pushd packages/receiver && go test ./...",
  // ── golden corpus: real commands from this repo's own package.json files ──
  // Kept as one table because the shared module and the shipped hook must agree on
  // every row, and a drift on either side fails on the same line.
  "pnpm --filter @pathrule/shared test",          // package-scoped verification
  "pnpm --filter @pathrule/core test",            // a DIFFERENT package, must not collide
  "pnpm typecheck",                               // root verification
  "pnpm -r test",                                 // recursive verification
  "pnpm -r --parallel typecheck",                 // recursive with an extra flag
  "time pnpm --filter @pathrule/web test",        // wrapper in front of a verification
  "pnpm --filter @pathrule/app build-storybook",  // real gate, no verification word in the name
  "pnpm web:prod-security",                       // real gate, no verification word in the name
  "pnpm release:security-gates",                  // composite gate
  "pnpm db:test",                                 // non-vitest verification
  "node scripts/with-sqlite-native.mjs vitest run", // wrapper script handing off to a runner
  "pnpm build",                                   // ordinary script: identity yes, gate no
  "pnpm --filter @pathrule/admin build",          // same name, genuinely just tsup
  "pnpm dev",                                     // ordinary script
  "pnpm format",                                  // mutating script
  "pnpm test:watch",                              // MISLEADING NAME: watch mode, name says test
  "pnpm vitest",                                  // watch by default, must be refused
  "pnpm vitest run --watch",                      // explicit watch flag, must be refused
  "pnpm --filter @pathrule/shared test | tail -5",// pipe: exit code moves, must be refused
  "bash packages/mobile/Scripts/protocol-parity.sh", // unknown shell script, must be refused
  "git status",                                   // not a script at all

  // the five real forms
  "pnpm --filter @pathrule/shared test",
  "pnpm -F @pathrule/shared test",
  "cd packages/shared && pnpm vitest run",
  "pnpm -r test",
  "node scripts/with-sqlite-native.mjs vitest run",
  // other real invocations in this repo
  "pnpm test",
  "pnpm vitest run",
  "pnpm vitest run src/hook-supervisor/x.test.ts",
  "pnpm --filter @pathrule/app test:runtime",
  "pnpm typecheck",
  "pnpm -r --parallel typecheck",
  "pnpm release:gate:fast",
  "pnpm db:test",
  "vitest run",
  "pnpm --filter=@pathrule/core test",
  "time pnpm test",
  "CI=1 pnpm test",
  "pnpm test > out.log",
  // must be refused
  "pnpm test | tail -20",
  "pnpm test 2>&1 | tail -5",
  "pnpm test && pnpm typecheck",
  "cd /Users/someone/repo && pnpm test",
  "cd ~/repo && pnpm test",
  "pnpm --filter './packages/*' test",
  "pnpm build",
  "pnpm natives:node",
  "git status",
  "bash packages/mobile/Scripts/protocol-parity.sh",

  // Human-approved custom CHECK commands: exact argv, no shell, wrapper or path binary.
  "northstar-check audit --strict",
  "northstar-check audit",
  "northstar-check --strict audit",
  "make test",
  "northstar-check  audit --strict",
  "nohup northstar-check audit",
  "nice northstar-check audit",
  "nohup nice",
  "nice nohup",
  "nohup X=1",
  "dash -c ls",
  "xargs northstar-check",
  "./bin/northstar-check audit",
  "northstar-check audit --target=../other",
  "northstar-check audit --watch",
];

let isolatedHome: string;
let hookScript: string;
let workspaceRoot: string;

beforeAll(async () => {
  isolatedHome = await mkdtemp(join(tmpdir(), "pathrule-hook-verif-"));
  hookScript = join(isolatedHome, "bin", "pathrule-hook.js");
  await mkdir(dirname(hookScript), { recursive: true });
  await copyFile(HOOK_SCRIPT_SOURCE, hookScript);
  await copyFile(CLOUD_EXTENSION, join(dirname(hookScript), "pathrule-hook-cloud.cjs"));

  workspaceRoot = join(isolatedHome, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  const cacheDir = join(isolatedHome, "cache", WORKSPACE_ID);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    join(cacheDir, "hook-index.json"),
    JSON.stringify({
      workspace_id: WORKSPACE_ID,
      workspace_root: workspaceRoot,
      generated_at: "2026-09-03T00:00:00.000Z",
      project_rules: [],
      path_rules: {},
      fail_patterns: [],
    }),
    "utf8",
  );
});

afterAll(async () => {
  await rm(isolatedHome, { recursive: true, force: true });
});

function runHook(payload: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [hookScript],
      { env: { ...process.env, PATHRULE_HOME: isolatedHome }, timeout: 15_000 },
      (error) => {
        if (error && typeof error.code === "number" && error.code !== 0) {
          reject(new Error(`hook exited ${error.code}`));
          return;
        }
        resolve();
      },
    );
    child.stdin?.end(JSON.stringify(payload));
  });
}

/** Drive one Bash PostToolUse through the hook and read the row it appended. */
async function hookFingerprint(sessionId: string, command: string, ok: boolean): Promise<string | null> {
  await runHook({
    session_id: sessionId,
    cwd: workspaceRoot,
    hook_event_name: ok ? "PostToolUse" : "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: { command },
    ...(ok ? { tool_response: { is_error: false, stdout: "" } } : { error: "command failed" }),
  });
  const file = join(isolatedHome, "cache", "tool-outcomes", `${sessionId}.jsonl`);
  const raw = await readFile(file, "utf8").catch(() => "");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const last = lines[lines.length - 1];
  if (!last) return null;
  const row = JSON.parse(last) as { v?: unknown };
  return typeof row.v === "string" ? row.v : null;
}

async function hookStrictRow(sessionId: string, command: string, response: Record<string,unknown>) {
  await runHook({session_id:sessionId,cwd:workspaceRoot,hook_event_name:"PostToolUse",tool_name:"Bash",tool_input:{command},tool_response:response});
  const file=join(isolatedHome,"cache","tool-outcomes",`${sessionId}.jsonl`);
  return JSON.parse((await readFile(file,"utf8")).trim().split("\n").pop()!) as {v?:string;v2?:string;verificationOk?:boolean|null;ok?:number};
}
const sessionStateFile=(id:string)=>join(isolatedHome,"cache",WORKSPACE_ID,`session-${id}.json`);
const pendingCheck=(command:string)=>({rule_id:"approved-legacy-check",rule_name:"Required check",fingerprint:classifyVerificationCommand(command)!.fingerprint,command,message:"Run the authored command before finishing.",since:"2026-10-11T00:00:00Z"});
async function seedState(id:string,pending:ReturnType<typeof pendingCheck>[],satisfied:ReturnType<typeof pendingCheck>[]=[]){
  await writeFile(sessionStateFile(id),JSON.stringify({session_id:id,pending_checks:pending,satisfied_checks:satisfied}));
}
async function readState(id:string){return JSON.parse(await readFile(sessionStateFile(id),"utf8")) as {pending_checks:ReturnType<typeof pendingCheck>[];satisfied_checks:ReturnType<typeof pendingCheck>[]};}

describe("strict evidence and preserved legacy CHECK debt",()=>{
  it("mirrors exact-argv SHA-256 evidence for the full command table",async()=>{
    for(const [index,command] of COMMANDS.entries()){
      const row=await hookStrictRow(`strict-parity-${index}`,command,{exit_code:0});
      expect(row.v2??null,command).toBe(classifyVerificationEvidenceCommand(command)?.fingerprint??null);
      if(row.v2)expect(row.verificationOk,command).toBe(true);
    }
  },120_000);
  it.each([
    ["pytest tests/receiver","pytest tests/sender"],
    ["jest --runInBand tests/receiver.test.ts","jest --runInBand tests/sender.test.ts"],
    ["pytest","pytest --collect-only"],
    ["jest","jest --listTests"],
    ["pytest tests/receiver","pytest tests/receiver; true"],
    ["pytest tests/receiver","pytest tests/receiver &"],
    ["npm run verify -- --receiver","npm run verify -- --sender"],
    ["pnpm test","pnpm --version test"],
    ["pnpm --filter @pathrule/app --filter @pathrule/core test","pnpm --filter @pathrule/app test"],
    ["node scripts/check-real.mjs jest","node scripts/noop.mjs jest"],
    ["pnpm --dir -F test","pnpm --dir --filter test"],
    ["pnpm -- --filter=@pathrule/core test","pnpm -- --filter @pathrule/core test"],
  ])("cannot clear an approved legacy CHECK for %s with %s",async(required,observed)=>{
    const id=`debt-${Buffer.from(required+observed).toString('hex').slice(0,90)}`;
    const owed=pendingCheck(required);await seedState(id,[owed]);
    const row=await hookStrictRow(id,observed,{exit_code:0});
    expect(requiredVerificationPassed(required,[row]).passed).toBe(false);
    expect((await readState(id)).pending_checks).toEqual([owed]);
  },30_000);
  it("clears the exact command without replacing its legacy stored fingerprint",async()=>{
    const id="stored-file-check",command="pytest tests/receiver",owed=pendingCheck(command);
    expect(owed.fingerprint).toBe("pytest#narrowed");await seedState(id,[owed]);
    const row=await hookStrictRow(id,command,{exit_code:0});
    expect(requiredVerificationPassed(command,[row]).passed).toBe(true);
    expect((await readState(id))).toMatchObject({pending_checks:[],satisfied_checks:[owed]});
  });
  it.each([{stdout:"1 failed",stderr:"",interrupted:false},{},{exit_code:1},{exit_code:0,is_error:true},{exit_code:0,interrupted:true},{exit_code:"1",is_error:false},{exit_code:"0",is_error:false},{exit_code:null,is_error:false}])("retains debt when success is missing or contradicted: %j",async response=>{
    const id="unconfirmed-"+Buffer.from(JSON.stringify(response)).toString('hex').slice(0,60),command="cargo test --locked",owed=pendingCheck(command);
    await seedState(id,[owed]);const row=await hookStrictRow(id,command,response);
    expect(requiredVerificationPassed(command,[row]).passed).toBe(false);
    expect((await readState(id)).pending_checks).toEqual([owed]);
  });
  it("accepts explicit success from the canonical Claude adapter and records a later failure",async()=>{
    const id="rerun-failure",command="pytest tests/receiver",owed=pendingCheck(command);await seedState(id,[owed]);
    const first=await hookStrictRow(id,command,{is_error:false});
    expect((await readState(id)).pending_checks).toEqual([]);
    const second=await hookStrictRow(id,command,{exit_code:1});
    expect(requiredVerificationPassed(command,[first,second]).passed).toBe(false);
    expect(await readState(id)).toMatchObject({pending_checks:[owed],satisfied_checks:[]});
  });
  it("invalidates a previous PASS after an exact rerun with an unknown exit",async()=>{
    const id="rerun-unconfirmed",command="pnpm test",owed=pendingCheck(command);await seedState(id,[owed]);
    const first=await hookStrictRow(id,command,{exit_code:0});
    const second=await hookStrictRow(id,command,{stdout:"unconfirmed process result"});
    expect(second.verificationOk).toBeNull();
    expect(requiredVerificationPassed(command,[first,second]).passed).toBe(false);
    expect(await readState(id)).toMatchObject({pending_checks:[owed],satisfied_checks:[]});
  });
  it.each([undefined,"success"])("trusts Copilot is_error:false only when its resultType attests success: %s",async resultType=>{
    const id=`copilot-attestation-${resultType??'unknown'}`,command="pnpm test",owed=pendingCheck(command);await seedState(id,[owed]);
    await runHook({sessionId:id,cwd:workspaceRoot,hookEventName:"postToolUse",toolName:"bash",toolArgs:{command},toolResult:{resultType,textResultForLlm:"result"}});
    expect((await readState(id)).pending_checks).toEqual(resultType==='success'?[]:[owed]);
    const row=JSON.parse((await readFile(join(isolatedHome,"cache","tool-outcomes",`${id}.jsonl`),"utf8")).trim().split("\n").pop()!);
    expect(row.verificationOk).toBe(resultType==='success'?true:null);
  });
  it("keeps debt owed when the bounded retention ledger is full",async()=>{
    const id="retention-full",command="pytest tests/receiver",owed=pendingCheck(command);
    await seedState(id,[owed],Array.from({length:256},(_,i)=>({...pendingCheck("pnpm test"),rule_id:`prior-${i}`})));
    await hookStrictRow(id,command,{exit_code:0});
    expect((await readState(id)).pending_checks).toEqual([owed]);
  });
  it("invalidates a previous success when the approved scope is mutated again",async()=>{
    const id="mutation-debt",command="pytest tests/receiver",owed=pendingCheck(command);await seedState(id,[],[owed]);
    const indexFile=join(isolatedHome,"cache",WORKSPACE_ID,"hook-index.json"),original=await readFile(indexFile,"utf8"),index=JSON.parse(original);
    index.project_rules=[{id:owed.rule_id,name:owed.rule_name,strictness:"advisory",preview:owed.message,required_check:{command,fingerprint:owed.fingerprint,message:owed.message,scope_path:"/tests"}}];
    try{
      await writeFile(indexFile,JSON.stringify(index));
      await runHook({session_id:id,cwd:workspaceRoot,hook_event_name:"PreToolUse",tool_name:"Edit",tool_input:{file_path:join(workspaceRoot,"tests","receiver.ts"),old_string:"before",new_string:"after"}});
      expect(await readState(id)).toMatchObject({pending_checks:[{command,fingerprint:owed.fingerprint}],satisfied_checks:[]});
    }finally{await writeFile(indexFile,original);}
  });
});

describe("verification fingerprint parity: shared module vs the shipped hook", () => {
  it("agrees on every command in the table", async () => {
    const mismatches: string[] = [];
    for (const [i, command] of COMMANDS.entries()) {
      const fromModule = classifyVerificationCommand(command)?.fingerprint ?? null;
      const fromHook = await hookFingerprint(`parity-${i}`, command, true);
      if (fromModule !== fromHook) {
        mismatches.push(`${command}\n    module=${String(fromModule)}\n    hook  =${String(fromHook)}`);
      }
    }
    expect(mismatches, `fingerprint drift:\n  ${mismatches.join("\n  ")}`).toEqual([]);
  }, 120_000);

  it.each([
    ["cargo test --features '' codec", "cargo test --features codec"],
    ['cargo test --features "" codec', "cargo test --features codec"],
    ["cargo test --features 'codec", "cargo test --features codec"],
    ['cargo test --features "codec', "cargo test --features codec"],
    ["command go test ./...", "go test ./..."],
    ["time go test ./...", "go test ./..."],
    ["pushd +1 && go test ./...", "cd +1 && go test ./..."],
    ["pushd -1 && go test ./...", "go test ./..."],
  ])("never writes a colliding PASS for erased syntax: %s", async (ambiguous, concrete) => {
    const index = Buffer.from(ambiguous).toString('hex');
    const observed = await hookFingerprint(`concrete-safe-${index}`, concrete, true);
    expect(observed).toBe(classifyVerificationCommand(concrete)?.fingerprint);
    expect(observed).not.toBeNull();
    const erased = await hookFingerprint(`concrete-ambiguous-${index}`, ambiguous, true);
    expect(erased).toBeNull();
    expect(classifyVerificationCommand(ambiguous)).toBeNull();
    expect(requiredVerificationPassed(ambiguous, [{v:observed,ok:1}]).passed).toBe(false);
    expect(requiredVerificationPassed(concrete, [{v:erased,ok:1}]).passed).toBe(false);
  }, 30_000);

  it("writes the fingerprint alongside a failing outcome, so FAIL is recorded too", async () => {
    const fingerprint = await hookFingerprint("parity-fail", "pnpm --filter @pathrule/shared test", false);
    expect(fingerprint).toBe("pnpm:test@package:@pathrule/shared");
    const file = join(isolatedHome, "cache", "tool-outcomes", "parity-fail.jsonl");
    const row = JSON.parse((await readFile(file, "utf8")).trim().split("\n").pop()!) as Record<string, unknown>;
    expect(row["ok"]).toBe(0);
    expect(row["v"]).toBe("pnpm:test@package:@pathrule/shared");
  }, 30_000);

  it("omits the field entirely rather than writing null when nothing is recognised", async () => {
    // `git status` names no runner and no script, so there is nothing to identify.
    // `pnpm build` used to belong here and no longer does: it has an identity now, and
    // an identity is not a claim that it verifies anything.
    await hookFingerprint("parity-omit", "git status", true);
    const file = join(isolatedHome, "cache", "tool-outcomes", "parity-omit.jsonl");
    const row = JSON.parse((await readFile(file, "utf8")).trim().split("\n").pop()!) as Record<string, unknown>;
    expect("v" in row).toBe(false);
    // And the existing category field is untouched by any of this.
    expect(row["cat"]).toBeDefined();
  }, 30_000);
});
