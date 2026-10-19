// SPDX-License-Identifier: Apache-2.0
// The ONLY module that constructs icons and ThemeColors (design skill rule 1).
// Content kinds use VENDORED LUCIDE GLYPHS (owner decision, round 14: brand
// consistency with the desktop/web icon language): memory=book-open (blue),
// rule=scale (green), skill=sparkles (purple), as light/dark SVG variants
// under resources/icons/. Everything else stays codicons; decoration badges
// stay theme-token colored.

import * as vscode from "vscode";

import type { ContentLeaf } from "../tree/model.js";
import { icons, type IconKey } from "./icons.js";

const DECORATION_COLORS: Record<ContentLeaf["kind"], string> = {
  memory: "charts.blue",
  rule: "charts.green",
  skill: "charts.purple",
};

let extensionUri: vscode.Uri | null = null;

/** Called once from activate() so kindIcon can resolve bundled assets. */
export function initThemeAssets(uri: vscode.Uri): void {
  extensionUri = uri;
}

export function themeIcon(key: IconKey): vscode.ThemeIcon {
  return new vscode.ThemeIcon(icons[key]);
}

/** Lucide light/dark variant pair for a content kind (tree + quick picks). */
export function kindIcon(kind: ContentLeaf["kind"]): { light: vscode.Uri; dark: vscode.Uri } {
  if (!extensionUri) throw new Error("initThemeAssets() must run during activation");
  return {
    light: vscode.Uri.joinPath(extensionUri, "resources", "icons", "light", `${kind}.svg`),
    dark: vscode.Uri.joinPath(extensionUri, "resources", "icons", "dark", `${kind}.svg`),
  };
}

/** Theme-aware color for a content kind — tree decorations (count badges). */
export function kindColor(kind: ContentLeaf["kind"]): vscode.ThemeColor {
  return new vscode.ThemeColor(DECORATION_COLORS[kind]);
}
