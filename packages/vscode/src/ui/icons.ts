// SPDX-License-Identifier: Apache-2.0
// Codicon NAMES live here (pure, testable); theme.ts wraps them in ThemeIcon.
// Design skill rule 1: this map + theme.ts are the only icon sources.

export const icons = {
  brand: "target",
  pathFolder: "folder",
  pathFile: "file",
  organization: "organization",
  cloud: "cloud",
  local: "vm",
  add: "add",
} as const;

export type IconKey = keyof typeof icons;
