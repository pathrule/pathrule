// SPDX-License-Identifier: Apache-2.0
/**
 * The engine slot. Nothing open or shipped installs an engine here, and no open code reads it: every
 * decision an engine could once make runs its open default. The slot stays as a compatibility
 * surface for the Cloud composition and the (undistributed) Engine package and their tests.
 */
import type { EngineParts } from "./contracts.js";

let installed: EngineParts = {};

/** Install engine parts. Later calls replace the parts they name and keep the rest. */
export function installEngine(parts: EngineParts): void {
  installed = { ...installed, ...parts };
}

/** The parts installed in this process; empty when no engine is installed. */
export function engine(): Readonly<EngineParts> {
  return installed;
}

/** Remove every installed part. For tests that prove the open default. */
export function uninstallEngine(): void {
  installed = {};
}
