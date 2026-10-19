// SPDX-License-Identifier: Apache-2.0
// Runs inside a real VS Code's extension host for real-vscode-smoke.mjs (--extensionTestsPath).
// It activates the extension and records what local mode did: the extension resolves the open
// folder with SQLite in this host, then reaches its store through a host it launches with the
// bundled CLI under VS Code's Electron. Nothing here starts a host itself.
const { execFileSync } = require("node:child_process");
const { existsSync, readdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const vscode = require("vscode");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The extension host log's lines about Pathrule, to say why local mode did not bind. */
function extensionLog() {
  const logs = join(process.env.SMOKE_PROFILE ?? "", "logs");
  const lines = [];
  const walk = (dir) => {
    for (const entry of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/exthost.*\.log$/.test(entry.name)) {
        lines.push(
          ...readFileSync(path, "utf8")
            .split("\n")
            .filter((l) => /pathrule/i.test(l)),
        );
      }
    }
  };
  walk(logs);
  return lines.slice(-20);
}

exports.run = async function run() {
  const out = { electron: process.versions.electron, napi: process.versions.napi };
  try {
    const extension = vscode.extensions.all.find((e) => e.packageJSON.name === "pathrule-vscode");
    if (!extension) throw new Error("the extension is not loaded");
    await extension.activate();
    out.activated = extension.isActive;

    out.folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    // What the extension's own probe meets: SQLite in this extension host.
    try {
      const Database = require(
        join(extension.extensionPath, "dist/cli/node_modules/better-sqlite3"),
      );
      new Database(":memory:").close();
      out.sqliteHere = "opens";
    } catch (err) {
      out.sqliteHere = err instanceof Error ? err.message : String(err);
    }

    // The binding launches the host when it resolves the folder to its local store.
    const recordFile = join(process.env.PATHRULE_HOME, "host", "host.json");
    for (let i = 0; i < 150 && !existsSync(recordFile); i++) await sleep(200);
    if (!existsSync(recordFile)) throw new Error("no host was launched: local mode did not bind");
    const record = JSON.parse(readFileSync(recordFile, "utf8"));
    out.hostCommand = execFileSync("ps", ["-p", String(record.pid), "-o", "command="], {
      encoding: "utf8",
    }).trim();

    // A store read through that host, by the extension's own CLI under this Electron.
    const cli = join(extension.extensionPath, "dist", "cli", "dist", "index.js");
    const listed = JSON.parse(
      execFileSync(process.execPath, [cli, "memory", "list", "--local", "--json"], {
        cwd: process.env.SMOKE_PROJECT,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        encoding: "utf8",
      }),
    );
    out.listOk = listed.ok === true;
    const log = readFileSync(join(process.env.PATHRULE_HOME, "host", "host.log"), "utf8");
    out.hostErrors = log
      .split("\n")
      .filter((line) => /internal_error|NODE_MODULE_VERSION/.test(line));
    out.ok =
      out.activated &&
      out.hostCommand.includes(`${cli} host run`) &&
      out.listOk &&
      out.hostErrors.length === 0;
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
    out.ok = false;
    out.extensionLog = extensionLog();
    const hostLog = join(process.env.PATHRULE_HOME, "host", "host.log");
    out.hostLog = existsSync(hostLog) ? readFileSync(hostLog, "utf8").split("\n").slice(-12) : null;
    out.home = existsSync(process.env.PATHRULE_HOME)
      ? readdirSync(process.env.PATHRULE_HOME)
      : null;
  }
  writeFileSync(process.env.SMOKE_OUT, JSON.stringify(out, null, 2));
};
