// The npm packages. There are two, and both are applications: each is one bundle of the CLI
// (scripts/bundle-cli.mjs) with every workspace package inlined, Pathrule Cloud's client included.
// The workspace packages (protocol, agent-ir, core, integrations, host, mcp's library, cloud) are
// not published on their own.
//
//   @pathrule/cli   the `pathrule` command (packages/cli/src/index.ts)
//   @pathrule/mcp   the MCP server over stdio, `npx -y @pathrule/mcp` (packages/cli/src/mcp-bin.ts):
//                   `pathrule mcp run` of the same CLI
//
// `dir` is the workspace package whose metadata, README and licence files the npm package carries;
// `entry` names the bundle's entry (CLI_ENTRIES in bundle-cli.mjs). `description` and `bin`, when
// given, replace the workspace manifest's in the published one. `embeds` are the web apps a bundle
// serves, built and carried as they are (dist/<key>).

export const NPM_PACKAGES = [
  {
    dir: "mcp",
    name: "@pathrule/mcp",
    role: "application",
    entry: "mcp",
    description:
      "Pathrule's MCP server over stdio for AI coding agents (npx -y @pathrule/mcp): the knowledge tools over the local store, or over Pathrule Cloud once chosen with `pathrule setup`.",
    bin: { "pathrule-mcp": "dist/index.js" },
  },
  {
    dir: "cli",
    name: "@pathrule/cli",
    role: "application",
    entry: "pathrule",
    // `pathrule ui` serves dist/ui (packages/cli/src/local/ui/assets.ts).
    embeds: { ui: "local-console" },
  },
];

/**
 * The dependencies a bundle leaves to npm, with the range the CLI's manifest declares: a native
 * module cannot be inlined. Every other import is inlined or a Node builtin.
 */
export const EXTERNAL_DEPENDENCIES = ["better-sqlite3"];

export function npmPackageByDir(dir) {
  const pkg = NPM_PACKAGES.find((p) => p.dir === dir);
  if (!pkg) throw new Error(`packages/${dir} is not an npm package (scripts/npm-packages.mjs)`);
  return pkg;
}
