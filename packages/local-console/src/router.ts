// SPDX-License-Identifier: Apache-2.0
// A small pathname router: the console has a handful of routes and needs no dependency.
import { useCallback, useEffect, useState } from "react";

/** The Signals Workspace's views, as path segments. */
export type SignalsRouteView = "overview" | "issues" | "setup";
/** The views a link may name, older ones included: Instrumentation became Setup. */
const SIGNALS_VIEWS = new Set<string>([
  "overview",
  "issues",
  "setup",
  "verification",
  "instrumentation",
  "activity",
]);

export type Route =
  /** A workspace's overview; without a workspace, the one the console starts on. */
  | { name: "overview"; workspaceId?: string }
  | { name: "workspaces" }
  | {
      name: "knowledge";
      workspaceId: string;
      /** "all": every kind together. */
      kind: "memory" | "rule" | "skill" | "all";
      archived: boolean;
      open: string | null;
      /** The folder the page opens on, with what is under it. */
      path?: string | null;
      /** Opens the form for a new item (`?new=1`), e.g. from search. */
      create?: boolean;
    }
  | { name: "activity"; workspaceId: string }
  | { name: "signals"; workspaceId: string; view: SignalsRouteView; group: string | null }
  | { name: "runtime" }
  | { name: "settings" }
  | { name: "not-found" };

const KINDS = new Set(["memory", "rule", "skill"]);

/** Where the console's routes start: "" for the Local Console, "/console" inside Pathrule Cloud's. */
let base = "";

/** Mounts the routes under a path, once, before the first render. */
export function setRouteBase(path: string): void {
  base = path.replace(/\/+$/, "");
}

export function parseRoute(pathname: string, search: string): Route {
  const local =
    base && (pathname === base || pathname.startsWith(`${base}/`))
      ? pathname.slice(base.length)
      : pathname;
  const parts = local.split("/").filter(Boolean).map(decodeURIComponent);
  const query = new URLSearchParams(search);
  if (parts.length === 0) return { name: "overview" };
  if (parts[0] === "workspaces" && parts.length === 1) return { name: "workspaces" };
  if (parts[0] === "runtime" && parts.length === 1) return { name: "runtime" };
  if (parts[0] === "settings" && parts.length === 1) return { name: "settings" };
  if (parts[0] === "w" && parts[1]) {
    const workspaceId = parts[1];
    const section = parts[2] ?? "knowledge";
    if (section === "overview" && parts.length === 3) return { name: "overview", workspaceId };
    if (section === "knowledge") {
      const kind = query.get("kind") ?? "memory";
      return {
        name: "knowledge",
        workspaceId,
        kind: (KINDS.has(kind) || kind === "all" ? kind : "memory") as
          | "memory"
          | "rule"
          | "skill"
          | "all",
        archived: query.get("archived") === "1",
        open: query.get("open"),
        ...(query.get("path") ? { path: query.get("path") } : {}),
        ...(query.get("new") === "1" ? { create: true } : {}),
      };
    }
    // The workspace's Search page became ⌘K search: its old address opens the workspace's knowledge.
    if (section === "search" && parts.length === 3)
      return { name: "knowledge", workspaceId, kind: "memory", archived: false, open: null };
    if (section === "activity") return { name: "activity", workspaceId };
    if (section === "signals") {
      const view = parts[3] ?? "overview";
      if (!SIGNALS_VIEWS.has(view) || parts.length > 4) return { name: "not-found" };
      return {
        name: "signals",
        workspaceId,
        view:
          view === "instrumentation"
            ? "setup"
            : view === "issues" || view === "setup"
              ? view
              : "overview",
        group: query.get("group"),
      };
    }
  }
  return { name: "not-found" };
}

export function hrefFor(route: Route): string {
  const href = localHref(route);
  return base ? (href === "/" ? base : `${base}${href}`) : href;
}

function localHref(route: Route): string {
  switch (route.name) {
    case "overview":
      return route.workspaceId ? `/w/${encodeURIComponent(route.workspaceId)}/overview` : "/";
    case "workspaces":
      return "/workspaces";
    case "runtime":
      return "/runtime";
    case "settings":
      return "/settings";
    case "knowledge": {
      const q = new URLSearchParams();
      if (route.kind !== "memory") q.set("kind", route.kind);
      if (route.archived) q.set("archived", "1");
      if (route.open) q.set("open", route.open);
      if (route.path) q.set("path", route.path);
      if (route.create) q.set("new", "1");
      const s = q.toString();
      return `/w/${encodeURIComponent(route.workspaceId)}/knowledge${s ? `?${s}` : ""}`;
    }
    case "activity":
      return `/w/${encodeURIComponent(route.workspaceId)}/activity`;
    case "signals": {
      const base = `/w/${encodeURIComponent(route.workspaceId)}/signals`;
      const path = route.view === "overview" ? base : `${base}/${route.view}`;
      return route.group ? `${path}?group=${encodeURIComponent(route.group)}` : path;
    }
    case "not-found":
      return "/";
  }
}

export function useRouter(): {
  route: Route;
  navigate: (href: string, options?: { replace?: boolean }) => void;
} {
  const read = () => parseRoute(window.location.pathname, window.location.search);
  const [route, setRoute] = useState<Route>(read);
  useEffect(() => {
    const onPop = () => setRoute(read());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((href: string, options?: { replace?: boolean }) => {
    if (options?.replace) window.history.replaceState(null, "", href);
    else window.history.pushState(null, "", href);
    setRoute(parseRoute(window.location.pathname, window.location.search));
    if (!options?.replace) document.getElementById("pr-main")?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, []);
  return { route, navigate };
}
