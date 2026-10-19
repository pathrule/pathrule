// SPDX-License-Identifier: Apache-2.0
import type {
  LocalWorkspaceSummary,
  RuntimeStatusResponse,
} from "@pathrule/protocol/local-ui-api.js";
import {
  AppShell,
  Brand,
  Breadcrumbs,
  Button,
  CommandChip,
  Icon,
  IconButton,
  Kbd,
  LoadError,
  MenuRadio,
  OfflineBanner,
  Skeleton,
  StateMessage,
  StatusIndicator,
  useTheme,
  type MessageKey,
} from "@pathrule/ui";
import {
  Activity,
  BookOpen,
  ChevronDown,
  FolderClosed,
  Gauge,
  ListChecks,
  Moon,
  Radio,
  Search,
  Settings,
  SquareTerminal,
  Sun,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createLocalApi, LocalApiError, startSession, type LocalApi } from "../api/client.js";
import { useConsoleMessages, type ConsoleMessages } from "../messages.js";
import { hrefFor, useRouter, type Route } from "../router.js";
import { ConsoleProvider, useConsole, useRuntimeStatus } from "./context.js";
import { OverviewPage } from "../pages/OverviewPage.js";
import { KnowledgePage } from "../pages/KnowledgePage.js";
import { ActivityPage } from "../pages/ActivityPage.js";
import { SignalsPage } from "../pages/SignalsPage.js";
import { RuntimePage } from "../pages/RuntimePage.js";
import { SettingsPage } from "../pages/SettingsPage.js";
import { WorkspacesPage } from "../pages/WorkspacesPage.js";
import { KnowledgeSearch, type SearchTarget } from "../search/KnowledgeSearch.js";

type Boot =
  | { state: "starting" }
  | { state: "relaunch"; reason: "needsLink" | "sessionEnded" }
  | {
      state: "ready";
      api: LocalApi;
      status: RuntimeStatusResponse;
      workspaces: LocalWorkspaceSummary[];
    }
  | { state: "error"; error: Error };

type KnowledgeKind = "memory" | "rule" | "skill";

function workspaceIdOf(route: Route): string | null {
  return "workspaceId" in route ? (route.workspaceId ?? null) : null;
}

/** Boots the session, then renders the console. Never asks for an account. */
export function App() {
  const m = useConsoleMessages();
  const [boot, setBoot] = useState<Boot>({ state: "starting" });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = await startSession();
      if (!token) {
        if (!cancelled) setBoot({ state: "relaunch", reason: "needsLink" });
        return;
      }
      const api = createLocalApi(token, () =>
        setBoot({ state: "relaunch", reason: "sessionEnded" }),
      );
      try {
        const [status, list] = await Promise.all([
          api.call("runtime.status", {}),
          api.call("workspaces.list", {}),
        ]);
        if (!cancelled) setBoot({ state: "ready", api, status, workspaces: list.workspaces });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof LocalApiError && error.code === "unauthorized") return;
        setBoot({
          state: "error",
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  if (boot.state === "starting") {
    return (
      <div className="lc-boot" aria-busy="true">
        <Skeleton shape="card" />
      </div>
    );
  }
  if (boot.state === "relaunch") {
    return (
      <main className="lc-boot">
        <StateMessage
          icon={SquareTerminal}
          title={m.t("boot.relaunchTitle")}
          description={`${m.t(`boot.${boot.reason}`)} ${m.t("boot.relaunchHelp")}`}
          actions={<CommandChip command="pathrule ui" />}
        />
      </main>
    );
  }
  if (boot.state === "error") {
    return (
      <main className="lc-boot">
        <LoadError
          title={m.t("boot.unreachable")}
          error={boot.error}
          onRetry={() => setTick((n) => n + 1)}
        />
      </main>
    );
  }
  return (
    <Ready
      api={boot.api}
      status={boot.status}
      workspaces={boot.workspaces}
      onRefresh={() => setTick((n) => n + 1)}
    />
  );
}

function Ready({
  api,
  status,
  workspaces,
  onRefresh,
}: {
  api: LocalApi;
  status: RuntimeStatusResponse;
  workspaces: LocalWorkspaceSummary[];
  onRefresh: () => void;
}) {
  const { route, navigate } = useRouter();
  const routeWorkspaceId = workspaceIdOf(route);
  const workspace =
    workspaces.find((w) => w.id === routeWorkspaceId) ??
    workspaces.find((w) => w.id === status.currentWorkspaceId) ??
    workspaces[0] ??
    null;

  const value = useMemo(
    () => ({
      api,
      capabilities: status.capabilities,
      status,
      workspaces,
      workspace,
      route,
      navigate,
      refreshRuntime: onRefresh,
    }),
    [api, status, workspaces, workspace, route, navigate, onRefresh],
  );
  return (
    <ConsoleProvider value={value}>
      <Shell />
    </ConsoleProvider>
  );
}

const CRUMB = {
  overview: "crumbs.overview",
  workspaces: "crumbs.workspaces",
  knowledge: "crumbs.knowledge",
  activity: "crumbs.activity",
  signals: "crumbs.signals",
  runtime: "crumbs.runtime",
  settings: "crumbs.settings",
  "not-found": "crumbs.notFound",
} as const satisfies Record<Route["name"], MessageKey<ConsoleMessages>>;

const KIND_ICON: Record<KnowledgeKind, typeof BookOpen> = {
  memory: BookOpen,
  rule: ListChecks,
  skill: Wrench,
};

function Shell() {
  const m = useConsoleMessages();
  const { route, navigate, workspace, workspaces, api, capabilities } = useConsole();
  const status = useRuntimeStatus();
  const { resolvedTheme, setTheme } = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchEverywhere, setSearchEverywhere] = useState(false);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        // ⌘⇧K searches every workspace on this machine.
        setSearchEverywhere(event.shiftKey);
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onNetwork = (event: Event) => setOffline((event as CustomEvent<boolean>).detail);
    window.addEventListener("pr-local-offline", onNetwork);
    return () => window.removeEventListener("pr-local-offline", onNetwork);
  }, []);

  const wsId = workspace?.id ?? null;
  const knowledge = (workspaceId: string, kind: KnowledgeKind): Route => ({
    name: "knowledge",
    workspaceId,
    kind,
    archived: false,
    open: null,
  });
  const kinds: KnowledgeKind[] = ["memory", "rule", "skill"];
  const toggleLabel = resolvedTheme === "dark" ? m.t("palette.toLight") : m.t("palette.toDark");

  const workspaceItems = wsId
    ? [
        ...kinds.map((kind) => ({
          label: m.t(`kinds.plural.${kind}`),
          icon: KIND_ICON[kind],
          href: hrefFor(knowledge(wsId, kind)),
          active: route.name === "knowledge" && route.kind === kind,
        })),
        {
          label: m.t("nav.activity"),
          icon: Activity,
          href: hrefFor({ name: "activity", workspaceId: wsId }),
          active: route.name === "activity",
        },
        {
          label: m.t("nav.signals"),
          icon: Radio,
          href: hrefFor({ name: "signals", workspaceId: wsId, view: "overview", group: null }),
          active: route.name === "signals",
        },
      ]
    : [];

  // ⌘K: the shared knowledge search, with this console's pages and actions.
  const pages: SearchTarget[] = [
    {
      id: "overview",
      title: m.t("nav.overview"),
      icon: Gauge,
      href: hrefFor({ name: "overview" }),
    },
    {
      id: "workspaces",
      title: m.t("nav.workspaces"),
      icon: FolderClosed,
      href: hrefFor({ name: "workspaces" }),
    },
    ...(wsId
      ? [
          ...kinds.map((kind) => ({
            id: `kind-${kind}`,
            title: m.t(`kinds.plural.${kind}`),
            icon: KIND_ICON[kind],
            href: hrefFor(knowledge(wsId, kind)),
          })),
          {
            id: "activity",
            title: m.t("nav.activity"),
            icon: Activity,
            href: hrefFor({ name: "activity", workspaceId: wsId }),
          },
          {
            id: "signals",
            title: m.t("nav.signals"),
            icon: Radio,
            href: hrefFor({ name: "signals", workspaceId: wsId, view: "overview", group: null }),
          },
        ]
      : []),
    {
      id: "runtime",
      title: m.t("nav.runtime"),
      icon: SquareTerminal,
      href: hrefFor({ name: "runtime" }),
    },
    {
      id: "settings",
      title: m.t("nav.settings"),
      icon: Settings,
      href: hrefFor({ name: "settings" }),
    },
  ];
  const actions: SearchTarget[] = [
    {
      id: "theme",
      title: toggleLabel,
      icon: resolvedTheme === "dark" ? Sun : Moon,
      onSelect: () => setTheme(resolvedTheme === "dark" ? "light" : "dark"),
    },
  ];
  const addresses = {
    knowledge: (workspaceId: string, kind: KnowledgeKind, id: string) =>
      hrefFor({ name: "knowledge", workspaceId, kind, archived: false, open: id }),
    workspace: (workspaceId: string) => hrefFor(knowledge(workspaceId, "memory")),
    newMemory: (workspaceId: string) =>
      hrefFor({
        name: "knowledge",
        workspaceId,
        kind: "memory",
        archived: false,
        open: null,
        create: true,
      }),
  };

  const switcher =
    workspaces.length > 0 && workspace ? (
      <MenuRadio
        label={m.t("switcher.label")}
        heading={m.t("switcher.heading")}
        value={workspace.id}
        onValueChange={(id) => {
          // Stay on the same section in the other workspace, without per-item state.
          const target: Route =
            route.name === "activity"
              ? { ...route, workspaceId: id }
              : route.name === "signals"
                ? { name: "signals", workspaceId: id, view: route.view, group: null }
                : route.name === "knowledge"
                  ? { ...route, workspaceId: id, open: null }
                  : route.name === "overview"
                    ? { name: "overview", workspaceId: id }
                    : knowledge(id, "memory");
          navigate(hrefFor(target));
        }}
        options={workspaces.map((w) => ({
          value: w.id,
          label: w.name,
          meta: w.rootPath,
        }))}
        footer={[
          {
            label: m.t("switcher.add"),
            description: m.t("switcher.addHint"),
            disabled: { reason: m.t("switcher.addHint") },
            onSelect: () => {},
          },
        ]}
        trigger={
          <button
            type="button"
            className="pr-switcher pr-switcher--workspace"
            aria-label={m.t("switcher.trigger", { name: workspace.name })}
          >
            <span className="pr-dot pr-dot--accent" aria-hidden />
            <span className="pr-switcher__name">{workspace.name}</span>
            <span className="pr-switcher__chevron" aria-hidden>
              <Icon icon={ChevronDown} size="sm" />
            </span>
          </button>
        }
      />
    ) : null;

  const crumbs = [
    { label: m.t("crumbs.local") },
    ...(workspace && "workspaceId" in route ? [{ label: workspace.name }] : []),
    { label: m.t(CRUMB[route.name]) },
  ];

  return (
    <AppShell
      navigationKey={hrefFor(route)}
      sidebar={{
        label: m.t("nav.label"),
        brand: <Brand product="Pathrule" edition="local" />,
        switchers: switcher,
        sections: [
          {
            items: [
              {
                label: m.t("nav.overview"),
                icon: Gauge,
                // The chosen workspace's overview, so the sidebar never switches workspace.
                href: hrefFor(
                  wsId ? { name: "overview", workspaceId: wsId } : { name: "overview" },
                ),
                active: route.name === "overview",
                onNavigate: navigate,
              },
              {
                label: m.t("nav.workspaces"),
                icon: FolderClosed,
                href: hrefFor({ name: "workspaces" }),
                active: route.name === "workspaces",
                meta: m.number(workspaces.length),
                onNavigate: navigate,
              },
            ],
          },
          ...(workspaceItems.length
            ? [
                {
                  heading: m.t("nav.workspace"),
                  items: workspaceItems.map((item) => ({ ...item, onNavigate: navigate })),
                },
              ]
            : []),
          {
            heading: m.t("nav.machine"),
            items: [
              {
                label: m.t("nav.runtime"),
                icon: SquareTerminal,
                href: "/runtime",
                active: route.name === "runtime",
                onNavigate: navigate,
              },
              {
                label: m.t("nav.settings"),
                icon: Settings,
                href: "/settings",
                active: route.name === "settings",
                onNavigate: navigate,
              },
            ],
          },
        ],
        footer: (
          <div className="lc-sidebar-footer">
            <StatusIndicator
              status={status.host.mode === "degraded" ? "disconnected" : "connected"}
              label={
                status.host.mode === "degraded" ? m.t("shell.unavailable") : m.t("shell.runtime")
              }
              live={false}
            />
            <span className="pr-text-caption-mono">{m.t("shell.private")}</span>
          </div>
        ),
      }}
      topbar={{
        leading: <Breadcrumbs items={crumbs} />,
        actions: (
          <>
            <button
              type="button"
              className="pr-search-trigger"
              onClick={() => {
                setSearchEverywhere(false);
                setPaletteOpen(true);
              }}
              aria-label={m.t("shell.search")}
            >
              <Search size={14} strokeWidth={1.5} aria-hidden />
              <span className="pr-search-trigger__text">{m.t("shell.searchShort")}</span>
              <Kbd>⌘K</Kbd>
            </button>
            <IconButton
              icon={resolvedTheme === "dark" ? Sun : Moon}
              label={toggleLabel}
              variant="secondary"
              size="sm"
              onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
            />
          </>
        ),
      }}
      banner={offline ? <OfflineBanner onRetry={() => window.location.reload()} /> : undefined}
    >
      <KnowledgeSearch
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        everywhere={searchEverywhere}
        api={api}
        workspaces={workspaces}
        workspace={workspace}
        canSearchAll={capabilities.searchAll?.available === true}
        recentKey="pathrule.local.recent"
        addresses={addresses}
        navigate={navigate}
        pages={pages}
        actions={actions}
      />
      <RouteView />
    </AppShell>
  );
}

function RouteView() {
  const m = useConsoleMessages();
  const { route, workspace, navigate } = useConsole();
  if (route.name === "overview" && (!route.workspaceId || workspace?.id === route.workspaceId))
    return <OverviewPage />;
  if (route.name === "workspaces") return <WorkspacesPage />;
  if (route.name === "runtime") return <RuntimePage />;
  if (route.name === "settings") return <SettingsPage />;
  if (
    route.name === "not-found" ||
    route.name === "overview" ||
    !workspace ||
    workspace.id !== ("workspaceId" in route ? route.workspaceId : workspace.id)
  ) {
    return (
      <StateMessage
        title={m.t("notFound.title")}
        description={m.t("notFound.description")}
        actions={<Button onClick={() => navigate("/")}>{m.t("notFound.action")}</Button>}
      />
    );
  }
  if (route.name === "knowledge") return <KnowledgePage key={workspace.id} route={route} />;
  if (route.name === "activity") return <ActivityPage key={workspace.id} />;
  return <SignalsPage key={workspace.id} view={route.view} group={route.group} />;
}
