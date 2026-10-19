// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { missingLaunchFiles, withLaunchCheck } from "./launch-target.js";
import type { ManagedMcpEntryInfo } from "./types.js";

function info(command: string | null, args: string[]): ManagedMcpEntryInfo {
  return {
    present: true,
    entry: { type: "stdio", command: command ?? "", args },
    launchCommand: command,
    launchArgs: args,
  };
}

// The entry Studio writes runs its own executable and the server inside its bundle.
const STUDIO_APP = "/Applications/Pathrule.app/Contents/MacOS/Pathrule";
const STUDIO_SERVER = "/Applications/Pathrule.app/Contents/Resources/pathrule-mcp-server/index.js";

describe("missingLaunchFiles", () => {
  it("names the executable and the server of an entry whose app was uninstalled", () => {
    expect(missingLaunchFiles(info(STUDIO_APP, [STUDIO_SERVER]), () => false)).toEqual([
      STUDIO_APP,
      STUDIO_SERVER,
    ]);
  });

  it("names nothing while both files exist", () => {
    expect(missingLaunchFiles(info(STUDIO_APP, [STUDIO_SERVER]), () => true)).toEqual([]);
  });

  it("checks the CLI's script, not the arguments after it", () => {
    const seen: string[] = [];
    const exists = (path: string) => {
      seen.push(path);
      return path === "/usr/local/bin/node";
    };
    const missing = missingLaunchFiles(
      info("/usr/local/bin/node", ["/opt/pathrule/dist/index.js", "mcp", "run"]),
      exists,
    );
    expect(missing).toEqual(["/opt/pathrule/dist/index.js"]);
    expect(seen).toEqual(["/usr/local/bin/node", "/opt/pathrule/dist/index.js"]);
  });

  it("leaves a bare command to PATH and checks Windows paths", () => {
    expect(missingLaunchFiles(info("node", ["C:\\pathrule\\dist\\index.js"]), () => false)).toEqual(
      ["C:\\pathrule\\dist\\index.js"],
    );
  });

  it("names nothing for an absent entry", () => {
    expect(
      missingLaunchFiles(
        { present: false, entry: null, launchCommand: null, launchArgs: [] },
        () => false,
      ),
    ).toEqual([]);
  });
});

describe("withLaunchCheck", () => {
  it("marks an entry whose files are gone as missing-file", () => {
    expect(withLaunchCheck(info(STUDIO_APP, [STUDIO_SERVER]), () => false).staleReason).toBe(
      "missing-file",
    );
  });

  it("keeps the reason the installer found", () => {
    const repoRelative = {
      ...info("node", ["x"]),
      staleReason: "repo-relative-mcp-server" as const,
    };
    expect(withLaunchCheck(repoRelative, () => false).staleReason).toBe("repo-relative-mcp-server");
  });

  it("leaves a launchable entry alone", () => {
    expect(
      withLaunchCheck(info(STUDIO_APP, [STUDIO_SERVER]), () => true).staleReason,
    ).toBeUndefined();
  });
});
