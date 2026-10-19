// SPDX-License-Identifier: Apache-2.0
// Opens a URL in the person's default browser with the platform's own opener, run directly (no
// shell), so nothing in the URL is ever interpreted by one. The same openers the account commands
// use.
import { execFile } from "node:child_process";

export function browserOpener(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  // `start` is cmd's own; its first argument is the window title, left empty.
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

export function openInBrowser(url: string): Promise<void> {
  const { command, args } = browserOpener(url);
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  });
}
