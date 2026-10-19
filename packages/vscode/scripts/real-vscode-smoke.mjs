// SPDX-License-Identifier: Apache-2.0
// The extension in a real VS Code. It packages the .vsix (or takes one), unpacks it as a
// development extension, makes a local workspace in a scratch home with the extension's own CLI
// under VS Code's Electron, and opens it in VS Code with real-vscode-smoke-runner.cjs, which
// checks from inside the extension host that local mode reaches its store. A VS Code window
// opens for a few seconds; the home, profile and folder are temporary.
//
//   node scripts/real-vscode-smoke.mjs [--vsix <file>] [--code <VS Code executable>]
//
// The CLI steps run under the extension host's own executable (macOS: "Code Helper (Plugin)"), as
// the extension runs them. VS Code's main executable refuses a native module signed by another
// team (library validation); the plugin helper is entitled to load one.
//
// Exit 0 when local mode worked, 1 otherwise, with the runner's record on stdout.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const option = (name) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const code =
  option("--code") ??
  process.env.VSCODE_BIN ??
  "/Applications/Visual Studio Code.app/Contents/MacOS/Code";
const pluginHost = code.endsWith("/Contents/MacOS/Code")
  ? resolve(code, "../../Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)")
  : code;

// A short root: VS Code's IPC socket lives in the profile, and a socket path is capped at 103 bytes.
const root = realpathSync(
  mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "pvs-")),
);
const home = join(root, "home");
const project = join(root, "project");
const unpacked = join(root, "vsix");
for (const dir of [home, project, unpacked]) mkdirSync(dir, { recursive: true });
const env = {
  ...process.env,
  HOME: home,
  PATHRULE_HOME: join(home, ".pathrule"),
  PATHRULE_DAEMON_AUTOSTART: "0",
  PATHRULE_UPDATE_POLICY: "manual",
};

const extension = join(unpacked, "extension");
const cli = join(extension, "dist", "cli", "dist", "index.js");
const asNode = { ...env, ELECTRON_RUN_AS_NODE: "1" };
let ok = false;
try {
  const vsix = option("--vsix") ?? join(root, "pathrule.vsix");
  if (!option("--vsix")) {
    execFileSync("npx", ["vsce", "package", "--no-dependencies", "-o", vsix], {
      cwd: resolve(here, ".."),
      stdio: "ignore",
    });
  }
  execFileSync("unzip", ["-q", vsix, "-d", unpacked]);
  execFileSync(pluginHost, [cli, "init", "--local", "--json"], { cwd: project, env: asNode });
  // Stopped, so that the extension has to launch the host itself.
  execFileSync(pluginHost, [cli, "host", "stop"], { cwd: project, env: asNode });

  const out = join(root, "result.json");
  const run = spawnSync(
    code,
    [
      "--user-data-dir",
      join(root, "profile"),
      "--extensions-dir",
      join(root, "extensions"),
      "--disable-extensions",
      "--disable-workspace-trust",
      "--use-inmemory-secretstorage",
      "--skip-welcome",
      "--skip-release-notes",
      `--extensionDevelopmentPath=${extension}`,
      `--extensionTestsPath=${join(here, "real-vscode-smoke-runner.cjs")}`,
      project,
    ],
    {
      env: { ...env, SMOKE_OUT: out, SMOKE_PROJECT: project, SMOKE_PROFILE: join(root, "profile") },
      timeout: 180_000,
      encoding: "utf8",
    },
  );
  const result = existsSync(out)
    ? JSON.parse(readFileSync(out, "utf8"))
    : {
        ok: false,
        error: `VS Code exited (${run.status ?? run.signal}) without a result`,
        output: `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().split("\n").slice(-15),
      };
  console.log(JSON.stringify(result, null, 2));
  ok = result.ok === true;
} finally {
  if (existsSync(cli)) spawnSync(pluginHost, [cli, "host", "stop"], { cwd: project, env: asNode });
  rmSync(root, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
