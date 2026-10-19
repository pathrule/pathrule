// SPDX-License-Identifier: Apache-2.0
// The playground's pages: what each component is for, its props, how to use it, and live states.
// Each component family's pages live in a registry-<family> module; this file sets their order.
import { ACTION_ENTRIES } from "./registry-actions.js";
import { CHART_ENTRIES } from "./registry-charts.js";
import { DATA_ENTRIES } from "./registry-data.js";
import type { Entry } from "./registry-entry.js";
import { FEEDBACK_ENTRIES } from "./registry-feedback.js";
import { FORM_ENTRIES } from "./registry-forms.js";
import { FOUNDATION_ENTRIES, LOCALIZATION_ENTRY, TOKENS_ENTRY } from "./registry-foundations.js";
import { LAYOUT_ENTRIES } from "./registry-layout.js";
import { NAVIGATION_ENTRIES } from "./registry-navigation.js";
import { SIGNALS_ENTRIES } from "./registry-signals.js";

export type { Entry, Kind, Prop } from "./registry-entry.js";

/* ── Registry ─────────────────────────────────────────────────────────── */

export const ENTRIES: Entry[] = [
  ...FOUNDATION_ENTRIES,
  ...ACTION_ENTRIES,
  ...FORM_ENTRIES,
  ...NAVIGATION_ENTRIES,
  ...FEEDBACK_ENTRIES,
  ...DATA_ENTRIES,
  ...CHART_ENTRIES,
  ...LAYOUT_ENTRIES,
  ...SIGNALS_ENTRIES,
  LOCALIZATION_ENTRY,
  TOKENS_ENTRY,
];

export const CATEGORIES = [
  "foundations",
  "actions",
  "forms",
  "navigation",
  "feedback",
  "data",
  "layout",
  "signals",
  "handoff",
] as const;
