// SPDX-License-Identifier: Apache-2.0
import {
  breakpoints,
  colors,
  density,
  fonts,
  iconSize,
  layout,
  motion,
  radius,
  rem,
  space,
  themeExtras,
  typography,
  zIndex,
  type DensityName,
  type ThemeName,
} from "./tokens.js";

const HEADER = `/* Generated from src/tokens/tokens.ts by \`pnpm --filter @pathrule/ui tokens\`. Do not edit. */`;

function block(selector: string, declarations: ReadonlyArray<readonly [string, string]>): string {
  const body = declarations.map(([name, value]) => `  ${name}: ${value};`).join("\n");
  return `${selector} {\n${body}\n}`;
}

function themeDeclarations(theme: ThemeName): Array<[string, string]> {
  const out: Array<[string, string]> = colors.map((role) => [role.cssVar, role[theme]]);
  for (const [name, value] of Object.entries(themeExtras[theme])) out.push([name, value]);
  out.push(["color-scheme", theme]);
  return out;
}

function densityDeclarations(name: DensityName): Array<[string, string]> {
  return Object.entries(density[name]).map(([key, px]) => [`--pr-${key}`, rem(px)]);
}

/**
 * The theme contract: `data-theme="dark|light"` and `data-density="comfortable|compact"`
 * on any element (usually <html>); nested scopes are allowed. Dark is the default.
 * `data-theme="system"` follows prefers-color-scheme.
 */
export function renderTokensCss(): string {
  const parts: string[] = [HEADER];

  parts.push(block(':root,\n[data-theme="dark"]', themeDeclarations("dark")));
  parts.push(block('[data-theme="light"]', themeDeclarations("light")));
  parts.push(
    `@media (prefers-color-scheme: light) {\n${block('  [data-theme="system"]', themeDeclarations("light")).replace(/\n/g, "\n  ")}\n}`,
  );
  parts.push(block(':root,\n[data-density="comfortable"]', densityDeclarations("comfortable")));
  parts.push(block('[data-density="compact"]', densityDeclarations("compact")));

  const statics: Array<[string, string]> = [
    ["--pr-sans", fonts.sans],
    ["--pr-mono", fonts.mono],
    ["--pr-ease", motion.ease.standard],
    ["--pr-ease-exit", motion.ease.exit],
    ["--pr-ease-emph", motion.ease.emphasized],
  ];
  for (const [key, ms] of Object.entries(motion.duration))
    statics.push([`--pr-duration-${key}`, `${ms}ms`]);
  for (const [key, px] of Object.entries(space)) statics.push([`--pr-space-${key}`, rem(px)]);
  for (const [key, px] of Object.entries(radius))
    statics.push([`--pr-radius-${key}`, key === "pill" ? "999px" : rem(px)]);
  for (const [key, value] of Object.entries(zIndex)) statics.push([`--pr-z-${key}`, String(value)]);
  for (const [key, px] of Object.entries(iconSize)) statics.push([`--pr-icon-${key}`, rem(px)]);
  for (const [key, style] of Object.entries(typography)) {
    statics.push([`--pr-text-${key}-size`, rem(style.size)]);
    statics.push([`--pr-text-${key}-leading`, String(style.lineHeight)]);
    statics.push([`--pr-text-${key}-weight`, String(style.weight)]);
    statics.push([`--pr-text-${key}-tracking`, style.tracking]);
  }
  for (const [key, px] of Object.entries(breakpoints)) statics.push([`--pr-bp-${key}`, `${px}px`]);
  for (const [key, px] of Object.entries(layout)) statics.push([`--pr-layout-${key}`, rem(px)]);
  parts.push(block(":root", statics));

  return `${parts.join("\n\n")}\n`;
}
