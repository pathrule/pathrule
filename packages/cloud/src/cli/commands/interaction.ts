// SPDX-License-Identifier: Apache-2.0
// Prompts, the editor, stdin and the browser: how the account commands talk to the person at the
// terminal.
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";

import type { CliOutputMode } from "@pathrule/cli/output.js";
import type { CliRuntime } from "@pathrule/cli/plugin.js";

/** A command that cannot run as asked: `code` names why, the message says what to do instead. */
export class CliContentUsageError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CliContentUsageError";
  }
}

export const execFileAsync = promisify(execFile);

async function openExternalUrl(url: string): Promise<void> {
  if (process.platform === "darwin") {
    await execFileAsync("open", [url]);
    return;
  }
  if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", url]);
    return;
  }
  await execFileAsync("xdg-open", [url]);
}

export async function openRuntimeUrl(runtime: CliRuntime, url: string): Promise<void> {
  if (runtime.openUrl) {
    await runtime.openUrl(url);
    return;
  }
  await openExternalUrl(url);
}

export async function readRuntimeStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      body += chunk;
    });
    process.stdin.on("end", () => resolve(body));
    process.stdin.on("error", reject);
  });
}

export async function editRuntimeText(
  runtime: CliRuntime,
  initialValue: string,
  fileNameHint: string,
): Promise<string> {
  const editor = runtime.env.VISUAL?.trim() || runtime.env.EDITOR?.trim();
  if (!editor) {
    throw new CliContentUsageError(
      "editor_required",
      "Set $EDITOR or pass --body / stdin for this command.",
    );
  }

  const scratchDir = await mkdtemp(join(tmpdir(), "pathrule-cli-edit-"));
  const scratchFile = join(scratchDir, fileNameHint);
  await writeFile(scratchFile, initialValue, "utf8");

  try {
    await runEditorCommand(editor, scratchFile, runtime.env);
    return await readFile(scratchFile, "utf8");
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

async function runEditorCommand(
  editor: string,
  filePath: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const command = `${editor} ${JSON.stringify(filePath)}`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, {
      env,
      shell: true,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`editor_exit_${code ?? "signal"}`));
    });
  });
}

export function shouldPromptForContentSelection(runtime: CliRuntime, mode: CliOutputMode): boolean {
  if (!mode.interactive || mode.noOpen) return false;
  if (runtime.promptLine) return true;
  if (process.env.NODE_ENV === "test") return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function shouldPromptForSetup(runtime: CliRuntime, mode: CliOutputMode): boolean {
  if (!mode.interactive || mode.json) return false;
  if (runtime.promptLine) return true;
  if (process.env.NODE_ENV === "test") return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function shouldUseKeyPrompt(runtime: CliRuntime, mode: CliOutputMode): boolean {
  if (!mode.interactive || mode.json || runtime.promptLine) return false;
  if (process.env.NODE_ENV === "test") return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function promptYesNo(
  runtime: CliRuntime,
  prompt: string,
  defaultYes: boolean,
): Promise<boolean> {
  const suffix = defaultYes ? " [Y/n]: " : " [y/N]: ";
  if (!runtime.promptLine && process.stdin.isTTY && process.stdout.isTTY) {
    return promptYesNoKey(prompt, suffix, defaultYes);
  }
  const answer = (await promptRuntimeLine(runtime, `${prompt}${suffix}`)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

async function promptYesNoKey(
  prompt: string,
  suffix: string,
  defaultYes: boolean,
): Promise<boolean> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const wasPaused = stdin.isPaused();

  stdout.write(`${prompt}${suffix}`);
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();

  try {
    return await new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        stdin.off("data", onData);
        if (stdin.isTTY) stdin.setRawMode(false);
        stdin.pause();
      };
      const finish = (value: boolean, echo: string) => {
        if (settled) return;
        settled = true;
        stdout.write(`${echo}\n`);
        cleanup();
        resolve(value);
      };
      const onData = (chunk: Buffer | string) => {
        const text = chunk.toString("utf8");
        if (text.includes("\u0003")) {
          if (settled) return;
          settled = true;
          cleanup();
          stdout.write("\n");
          reject(new Error("setup_canceled"));
          return;
        }
        if (text.includes("\r") || text.includes("\n")) {
          finish(defaultYes, defaultYes ? "Y" : "N");
          return;
        }
        if (/[yY]/.test(text)) {
          finish(true, "Y");
          return;
        }
        if (/[nN]/.test(text)) {
          finish(false, "N");
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    if (stdin.isTTY) stdin.setRawMode(false);
    if (wasPaused || !stdin.isPaused()) stdin.pause();
  }
}

export async function promptRuntimeLine(runtime: CliRuntime, prompt: string): Promise<string> {
  if (runtime.promptLine) return runtime.promptLine(prompt);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
