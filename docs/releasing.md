# Releasing

Two npm packages are released from this repository, together and with one version, by its
[release workflow](../.github/workflows/release.yml): `@pathrule/cli` (the `pathrule` command) and
`@pathrule/mcp` (the MCP server, `npx -y @pathrule/mcp`). Each is one bundle of the CLI
(`scripts/bundle-cli.mjs`) with every package of this repository inlined, Pathrule Cloud's client
included; the workspace packages are not published on their own.

## How a release is published

- **npm Trusted Publishing.** The workflow publishes with GitHub's OIDC token, so no npm token
  exists, and every package carries a provenance attestation naming this repository and the
  commit it was built from.
- **Approval.** The publish job runs in the `npm` environment, whose required reviewers approve
  every publish.
- **Verification first.** Before anything publishes, the workflow runs the typecheck, the tests
  and the no-account end-to-end smoke, then stages both packages
  (`scripts/stage-npm-packages.mjs`). Staging builds each bundle, writes its publish manifest
  (`better-sqlite3` its only dependency, no `private`, no scripts, no devDependencies), packs it,
  and refuses a tarball that holds anything but its manifest, `LICENSE`, `NOTICE`, `README.md`,
  `dist/` and the `npm-shrinkwrap.json` that pins its install tree.
  `artifacts/npm/staging.json` lists each tarball with its integrity hash.
- **No telemetry key.** The CLI and the MCP server send no product telemetry, and no build
  variable changes what they are built from.
- **No install scripts.** Neither package has one. `better-sqlite3`, the dependency, fetches
  its prebuilt binary at install time.

## Cutting a release

1. Set the new version in `packages/cli/package.json` and `packages/mcp/package.json` (they share
   one version).
2. Merge that change to `main` with green CI.
3. Run the release workflow by hand without `publish`: a dry run that stages and uploads the
   tarballs as an artifact. Inspect them.
4. Tag the commit `vX.Y.Z` and push the tag. The workflow checks that the tag matches the
   version, stages again and, once a reviewer approves the `npm` environment, publishes
   `@pathrule/mcp`, then `@pathrule/cli`.
5. Create the GitHub release for the tag, with the notes generated from the Conventional Commit
   titles since the previous tag.

## Reproducing a build

The toolchain is pinned: Node.js in `.nvmrc` (the workflow uses the current LTS), pnpm in
`package.json`'s `packageManager`, and every dependency, esbuild and TypeScript included, in
`pnpm-lock.yaml`. To rebuild a release and compare it with what npm serves:

```bash
git checkout vX.Y.Z
pnpm install --frozen-lockfile
node scripts/stage-npm-packages.mjs --out /tmp/pathrule-npm
npm view @pathrule/cli@X.Y.Z dist.integrity
```

and compare that integrity with the one `staging.json` records for the package.

## Rolling back

npm versions are immutable. A bad release is replaced, not edited:

1. **Point `latest` back** at the previous good version, for both packages, so new installs stop
   getting the bad one at once:
   `npm dist-tag add @pathrule/cli@<previous> latest` (and the same for `@pathrule/mcp`).
2. **Deprecate the bad version** with the reason and the version to use:
   `npm deprecate @pathrule/cli@<bad> "Broken: <reason>. Use <previous>."`
3. **Fix forward**: release the fix as the next patch version through the normal procedure.

`npm unpublish` is a last resort, for a release that must disappear (a leaked secret, for
example). npm allows it only within 72 hours and only when no other package depends on the
version; for a leaked secret, revoke the secret first, since a published tarball may already be
mirrored.
