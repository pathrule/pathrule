// SPDX-License-Identifier: Apache-2.0
// Tiny platform resolver used by the CLI so fixtures can simulate Windows
// or Linux from a macOS host (and vice versa) without monkey-patching
// `process.platform`. Pass `cliPlatform(runtime.env)` anywhere the CLI
// branches on the OS.

export function cliPlatform(env: NodeJS.ProcessEnv = process.env): NodeJS.Platform {
  const override = env.PATHRULE_TEST_PLATFORM;
  if (override) return override as NodeJS.Platform;
  return process.platform;
}
