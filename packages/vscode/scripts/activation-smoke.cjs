// SPDX-License-Identifier: Apache-2.0
// Activation smoke: loads the built bundle with a stubbed vscode module,
// asserts better-sqlite3 stays lazy and activate() completes (gate step).
const Module = require("module");
const orig = Module._load;
const disposable = class { constructor(f){ this.dispose = f || (()=>{}); } };
const emitter = class { constructor(){ this.event = () => new disposable(); } fire(){} dispose(){} };
const vscodeMock = {
  StatusBarAlignment: { Left: 1 },
  Disposable: disposable,
  EventEmitter: emitter,
  TreeItem: class {},
  ThemeIcon: class {},
  TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
  ProgressLocation: { Notification: 15 },
  FileChangeType: { Changed: 1 },
  FileType: { File: 1 },
  FileSystemError: class extends Error {
    static FileNotFound(){ return new this(); }
    static NoPermissions(){ return new this(); }
    static Unavailable(){ return new this(); }
  },
  Uri: { joinPath: () => ({ fsPath: "/x" }), from: (o) => o, parse: (s) => ({ toString: () => s }) },
  FileDecoration: class { constructor(badge, tooltip, color){ this.badge=badge; this.tooltip=tooltip; this.color=color; } },
  window: {
    registerFileDecorationProvider: () => new disposable(),
    createStatusBarItem: () => ({ show(){}, dispose(){} }),
    createTreeView: () => ({ dispose(){}, visible: false, reveal: async()=>{}, selection: [], onDidChangeVisibility: () => new disposable() }),
    createOutputChannel: () => ({ dispose(){}, appendLine(){}, clear(){}, show(){} }),
    onDidChangeActiveTextEditor: () => new disposable(),
    onDidChangeWindowState: () => new disposable(),
    activeTextEditor: undefined,
  },
  workspace: {
    workspaceFolders: undefined,
    registerFileSystemProvider: () => new disposable(),
    getConfiguration: () => ({ get: () => true }),
    onDidChangeConfiguration: () => new disposable(),
  },
  commands: { registerCommand: () => new disposable(), executeCommand: async () => {} },
  lm: {},
  env: { appName: "VSCode", clipboard: { writeText: async () => {} } },
};
Module._load = function (req, ...rest) {
  if (req === "vscode") return vscodeMock;
  // The bundle loads the copy vendored beside its CLI (./cli/node_modules/better-sqlite3/...).
  if (/(^|\/)better-sqlite3(\/|$)/.test(req)) { console.log("FAIL eager sqlite"); process.exit(1); }
  return orig.call(this, req, ...rest);
};
const ext = require(require("path").resolve(process.cwd(), process.argv[2]));
const subs = [];
const t0 = process.hrtime.bigint();
ext.activate({ subscriptions: subs, extensionUri: {} });
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`activation OK — ${subs.length} subscriptions, sync activate ${ms.toFixed(1)}ms, sqlite stayed lazy`);
