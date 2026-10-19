// SPDX-License-Identifier: Apache-2.0
// Path mentions must be found in ANY repo, not just TypeScript monorepos.
//
// The rule this replaced was a fixed directory list
// (`packages|apps|src|docs|supabase|types|scripts|config|public|tests?`), i.e.
// literally Pathrule's own tree, with `supabase` in it. Measured against eight
// real-world paths it found one: ours. Xcode, Rails, Flutter, Unity and Go all
// returned nothing, so path linking silently did nothing for most users.

import { describe, expect, it } from "vitest";
import { extractPathMentions } from "./path-linking.js";

describe("extractPathMentions across real stacks", () => {
  const cases: Array<[string, string, string]> = [
    ["Xcode", "see Sources/Networking/APIClient.swift for details", "Sources/Networking/APIClient.swift"],
    ["Xcode app group", "MyApp/Views/ProfileView.swift needs a state fix", "MyApp/Views/ProfileView.swift"],
    ["Rails", "check app/models/user.rb", "app/models/user.rb"],
    ["Flutter", "lib/screens/home_page.dart has the bug", "lib/screens/home_page.dart"],
    ["Unity", "Assets/Scripts/PlayerController.cs is huge", "Assets/Scripts/PlayerController.cs"],
    ["Go cmd", "cmd/server/main.go boots the thing", "cmd/server/main.go"],
    ["Go internal", "internal/auth/token.go validates it", "internal/auth/token.go"],
    ["TS monorepo", "packages/api/src/index.ts exports it", "packages/api/src/index.ts"],
    ["Android", "app/src/main/AndroidManifest.xml declares it", "app/src/main/AndroidManifest.xml"],
    ["Python", "django_app/settings.py holds the config", "django_app/settings.py"],
    ["dotfile path", "look at .github/workflows/ci.yml", ".github/workflows/ci.yml"],
  ];

  it.each(cases)("finds the path in a %s project", (_stack, text, expected) => {
    expect(extractPathMentions(text)).toContain(expected);
  });

  it("strips trailing punctuation", () => {
    expect(extractPathMentions("broken in lib/main.dart.")).toContain("lib/main.dart");
    expect(extractPathMentions("see (src/app.ts),")).toContain("src/app.ts");
  });

  it("finds extension-less directory paths too", () => {
    // "packages/api must be changed with packages/shared" is real knowledge:
    // a coupling between two directories. Requiring a file extension lost it.
    expect(extractPathMentions("packages/api must change with packages/shared")).toEqual(
      expect.arrayContaining(["packages/api", "packages/shared"]),
    );
    expect(extractPathMentions("logic lives in Sources/Networking")).toContain(
      "Sources/Networking",
    );
    expect(extractPathMentions("see supabase/functions for the edge fns")).toContain(
      "supabase/functions",
    );
  });

  it("does not invent paths out of ordinary prose", () => {
    for (const prose of [
      "we need read/write access",
      "this and/or that",
      "the ratio is 3/4",
      "TCP/IP is fine",
      "input/output handling",
      "our CI/CD pipeline",
      "available 24/7",
      "pass/fail only",
    ]) {
      expect(extractPathMentions(prose), prose).toEqual([]);
    }
  });

  it("ignores URLs, which are not repo paths", () => {
    expect(extractPathMentions("docs at https://example.com/guide/setup.md")).toEqual([]);
  });

  it("deduplicates and stays bounded", () => {
    const many = Array.from({ length: 40 }, (_, i) => `src/mod${i}/file.ts`).join(" ");
    const found = extractPathMentions(`${many} src/mod0/file.ts`);
    expect(found.length).toBeLessThanOrEqual(20);
    expect(new Set(found).size).toBe(found.length);
  });

  it("returns nothing for empty input", () => {
    expect(extractPathMentions("")).toEqual([]);
  });
});
