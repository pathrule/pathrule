// SPDX-License-Identifier: Apache-2.0
// Removes a test's scratch folder. Windows refuses to delete a folder while a process (the host a
// test launched, a store still closing) holds a file in it open: it retries, then leaves the folder
// to the OS temp cleanup rather than fail the test on it. POSIX removes it at once.
import { rmSync } from "node:fs";

export function removeScratch(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY")) throw error;
  }
}
