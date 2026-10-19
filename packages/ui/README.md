# @pathrule/ui

Pathrule's shared interface: design tokens, themes, accessible React
components, application layouts and the Signals Workspace components. The
Local Console and the Pathrule Cloud console are built from it.

```ts
import "@pathrule/ui/styles.css"; // once, at the app root
import { AppShell, Button, DataTable, ThemeProvider } from "@pathrule/ui";
import { SignalsWorkspace } from "@pathrule/ui/signals";
```

## Theming contract

Put `data-theme="dark|light"` and `data-density="comfortable|compact"` on
`<html>` (`ThemeProvider` does this and remembers the choice), and the
`pr-root` class on `<body>`. Every CSS variable is prefixed `--pr-` so the
library never collides with a host app's variables.

Tokens have one source, `src/tokens/tokens.ts`. `pnpm --filter @pathrule/ui
tokens` regenerates `src/styles/tokens.css`; a test fails when they drift.

## Rules the components keep

- Accent means primary action and verified. Never use it for observations,
  hypotheses or untrusted runtime data.
- A failed load renders an error with retry, never an empty list
  (`useAsync`, `AsyncView`).
- Runtime text is untrusted: `UntrustedText` renders it as text only.
- Disabled controls say why (`disabled={{ reason }}`, `locked={{ reason }}`).
- Data comes in through props or an app's adapter (for example a
  `SignalsSource`); the library never imports a backend.

## Develop

`pnpm --filter @pathrule/ui playground` opens the component playground;
`pnpm --filter @pathrule/ui test` runs the tests (behavior, contrast and
axe-core scans).
