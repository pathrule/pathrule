// SPDX-License-Identifier: Apache-2.0
// The library's own strings (namespace "ui"): what components say when the app passes nothing.
// English is the source; a locale catalog translates any subset of it through `I18nProvider`.
import { ENGLISH_RELATIVE_TIME, type DeepPartial } from "./core.js";
import { useMessages } from "./react.js";

export const uiMessages = {
  time: ENGLISH_RELATIVE_TIME,
  common: {
    loading: "Loading",
  },
  status: {
    connected: "Connected",
    degraded: "Degraded",
    disconnected: "Disconnected",
    pending: "Pending",
    paused: "Paused",
  },
  copy: {
    done: "Copied",
    failed: "Copy failed",
    code: "Copy code",
    named: "Copy {name}",
    button: "Copy",
    chip: "copy",
    command: "Copy command: {command}",
  },
  untrusted: {
    region: "Untrusted runtime data: {label}",
    flag: "untrusted · shown as text",
    flagWithSource: "untrusted · shown as text · {source}",
    showLess: "Show less",
    showAll: "Show all {count} characters",
  },
  form: {
    optional: "optional",
    reveal: "Show value",
    hide: "Hide value",
    clearSearch: "Clear search",
    noMatches: "No matches",
    useTyped: "Press Enter to use “{value}”",
  },
  command: {
    title: "Command palette",
    placeholder: "Search or jump to…",
    empty: "Nothing matches.",
    results: "Results",
    searching: "Searching…",
  },
  search: {
    title: "Search",
    preview: "Preview",
    filters: "Show",
    move: "Move",
    open: "Open",
    newTab: "New tab",
    filter: "Filter",
  },
  navigation: {
    breadcrumb: "Breadcrumb",
    pagination: "Pagination",
    previousPage: "Previous page",
    nextPage: "Next page",
    page: "Page {page}",
    range: "{from}–{to} of {total}",
    openNavigation: "Open navigation",
    skipToContent: "Skip to content",
    navigation: "Navigation",
  },
  overlay: {
    close: "Close",
    dialog: "Dialog",
    details: "Details",
    cancel: "Cancel",
    actionFailed: "The action failed. Nothing was changed.",
    typeToConfirm: "Type {text} to confirm",
  },
  meter: {
    notIncluded: "Not included",
    atLimit: "At or over limit",
    approaching: "{percent}% · approaching limit",
    percent: "{percent}%",
    usedNotIncluded: "{value} used, not included",
    valueOfMax: "{value} of {max}",
    valueSlashNotIncluded: "{value} / not included",
    valueSlashMax: "{value} / {max}",
    unlimited: "Unlimited",
    usedUnlimited: "{value} used, unlimited",
  },
  surface: {
    dismiss: "Dismiss",
  },
  chart: {
    total: "Total",
  },
  collection: {
    favorite: "Favorite {name}",
    addFavorite: "Add to favorites",
    removeFavorite: "Remove from favorites",
  },
  table: {
    selectAll: "Select all rows",
    selectRow: "Select row",
    selected: "{count} selected",
  },
  toast: {
    region: "Notifications",
    undo: "Undo",
    dismiss: "Dismiss notification",
  },
  states: {
    retry: "Retry",
    retryNow: "Retry now",
    requestFailed: "The request failed. Your data is safe; try again.",
    notFoundTitle: "Nothing here",
    notFoundDescription: "The page or item does not exist, or it was moved.",
    offline: "Can't reach the runtime. Changes are disabled until it is back.",
    offlineSince: "Can't reach the runtime since {since}. Changes are disabled until it is back.",
    unsavedRegion: "Unsaved changes",
    unsaved: { one: "{count} unsaved change", other: "{count} unsaved changes" },
    discard: "Discard",
    save: "Save",
  },
} as const;

export type UiMessages = typeof uiMessages;
/** A locale's version of the library's strings, any subset. */
export type UiCatalog = DeepPartial<UiMessages>;

/** The library's translator, for components. */
export function useUiMessages() {
  return useMessages("ui", uiMessages);
}
