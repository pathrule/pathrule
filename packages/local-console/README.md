# @pathrule/local-console

The accountless Pathrule Local Console: a browser view of the Pathrule
knowledge on this machine, served by `pathrule ui` on `127.0.0.1`.

- Browse, search, create, edit, delete (to Archived) and restore memories,
  rules and skills of every local workspace in the Pathrule home.
- See what agents logged in each workspace, and what the local runtime can do.
- Signals (runtime events) shows the local runtime's honest state: it has no
  runtime event store today, so the module says so instead of showing data.

It has no account, organization, plan or billing surface, and it loads nothing
from the internet. All data comes from `pathrule ui`, which reaches the home's
local stores through the Pathrule host; the contract is
`@pathrule/protocol/local-ui-api.ts`.

## Develop

```sh
pnpm --filter @pathrule/local-console build   # writes dist/
pathrule ui                                   # serves dist/ and opens the console
```

`pathrule ui` looks for the built console in `PATHRULE_UI_ASSETS`, next to the
CLI bundle (`ui/`), or in this package's `dist/` when run from the monorepo.

`pnpm --filter @pathrule/local-console test` runs the component and contract
tests; `build` also runs `scripts/check-bundle.mjs` (no external requests, no
inline script or style, size budget).
