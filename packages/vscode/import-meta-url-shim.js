// SPDX-License-Identifier: Apache-2.0
// esbuild inject shim: ESM-authored sources (cli/shared) use import.meta.url
// (e.g. createRequire); the CJS extension bundle must map it to __filename.
export var import_meta_url = require("node:url").pathToFileURL(__filename).href;
