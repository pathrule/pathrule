---
description: Explain what Pathrule has on this machine and what is missing.
---

1. Run `sh "${CLAUDE_PLUGIN_ROOT}/scripts/pathrule-launch" status --json` and `sh "${CLAUDE_PLUGIN_ROOT}/scripts/pathrule-setup" status --json`.
2. When the runtime is ready, also run `sh "${CLAUDE_PLUGIN_ROOT}/scripts/pathrule-launch" cli integrations doctor`.
3. Summarize for the user: the runtime, the integrations, and every problem with its fix.
   Do not change anything.
