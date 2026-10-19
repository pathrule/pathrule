// SPDX-License-Identifier: Apache-2.0
//
// Pathrule runs on any repo, not just TypeScript monorepos. This suite pins
// leaf classification against real leaf names from the stacks users actually
// bring: Xcode, Gradle/Android, Flutter, Unity, Go, Rails, and plain dotfiles.
//
// The rule we hold: a leaf with an extension is a FILE, unless its extension
// is a known directory-bundle suffix (.xcodeproj, .app, .framework, ...), which
// macOS presents as a folder.

import { describe, expect, it } from "vitest";
import { guessLeafType } from "./node-path.js";

const FILES = [
  // Dotfiles present in nearly every repo. These were misclassified as folders
  // because their extension is longer than 8 characters.
  ".gitignore",
  ".dockerignore",
  ".gitattributes",
  ".env.production",
  ".editorconfig",
  // Xcode / iOS
  "MyApp.entitlements",
  "Main.storyboard",
  "LaunchScreen.storyboard",
  "project.pbxproj",
  "Info.plist",
  "Package.swift",
  "Config.xcconfig",
  "ContentView.swift",
  // Android / JVM
  "gradle.properties",
  "local.properties",
  "build.gradle.kts",
  "AndroidManifest.xml",
  "MainActivity.kt",
  // Flutter / Dart
  "pubspec.yaml",
  "home_page.dart",
  // Unity / C#
  "PlayerController.cs",
  "ProjectSettings.asset",
  // Go / Rust / Ruby / Python
  "main.go",
  "Cargo.toml",
  "user.rb",
  "requirements.txt",
  "settings.py",
  // Web
  "index.tsx",
  "vite.config.ts",
  "package.json",
];

const DIRECTORIES = [
  // Plain directories
  "Sources",
  "Assets",
  "node_modules",
  "src",
  "app",
  // macOS bundles: extensions, but genuinely directories.
  "MyApp.xcodeproj",
  "MyApp.xcworkspace",
  "MyApp.app",
  "Pathrule.framework",
  "Resources.bundle",
  "en.lproj",
  // Tool dot-directories, which must not be mistaken for dotfiles.
  ".claude",
  ".cursor",
  ".codex",
  ".github",
  ".vscode",
  ".git",
  ".pathrule",
];

describe("guessLeafType across real stacks", () => {
  it.each(FILES)("classifies %s as a file", (leaf) => {
    expect(guessLeafType(leaf)).toBe("file");
  });

  it.each(DIRECTORIES)("classifies %s as a folder", (leaf) => {
    expect(guessLeafType(leaf)).toBe("folder");
  });

  it("classifies full paths by their last segment", () => {
    expect(guessLeafType("/Sources/Networking/APIClient.swift")).toBe("file");
    expect(guessLeafType("/Sources/Networking")).toBe("folder");
    expect(guessLeafType("/MyApp.xcodeproj")).toBe("folder");
    expect(guessLeafType("/")).toBe("folder");
    expect(guessLeafType("")).toBe("folder");
  });
});
