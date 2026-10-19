// SPDX-License-Identifier: Apache-2.0
// A real host process, for the process and launch tests: `node --import tsx run-host.ts`, with the
// Pathrule home in PATHRULE_HOME. `HOST_FIXTURE_IDLE_MS` gives it an idle timeout,
// `HOST_FIXTURE_FAIL` makes it fail before it starts. It exits with the host's exit code.
import { runHostProcess } from "../process.js";

if (process.env.HOST_FIXTURE_FAIL) {
  process.stderr.write(`fixture failure: ${process.env.HOST_FIXTURE_FAIL}\n`);
  process.exit(1);
}
const idle = Number(process.env.HOST_FIXTURE_IDLE_MS);
process.exitCode = await runHostProcess({
  env: process.env,
  ...(Number.isFinite(idle) && idle > 0 ? { idleTimeoutMs: idle } : {}),
});
