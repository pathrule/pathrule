// SPDX-License-Identifier: Apache-2.0
import type { LocalUiRoute } from "@pathrule/protocol/local-ui-api.js";
import { ThemeProvider, ToastProvider } from "@pathrule/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { byRole, click, cleanup, flush, render, type } from "../../ui/test/render.js";
import { createLocalApi, LocalApiError, startSession } from "../src/api/client.js";
import { App } from "../src/app/App.js";
import { validatePath } from "../src/knowledge/KnowledgeEditor.js";
import { hrefFor, parseRoute } from "../src/router.js";

describe("router", () => {
  it("parses and builds every route", () => {
    const routes = [
      { name: "overview" },
      { name: "overview", workspaceId: "ws-1" },
      { name: "workspaces" },
      { name: "runtime" },
      { name: "settings" },
      { name: "knowledge", workspaceId: "ws-1", kind: "rule", archived: true, open: "r-9" },
      { name: "activity", workspaceId: "ws-1" },
      { name: "signals", workspaceId: "ws-1", view: "overview", group: null },
      { name: "signals", workspaceId: "ws-1", view: "issues", group: "g-1" },
      { name: "signals", workspaceId: "ws-1", view: "setup", group: null },
      {
        name: "knowledge",
        workspaceId: "ws-1",
        kind: "all",
        archived: false,
        open: null,
        path: "/apps/web",
      },
    ] as const;
    for (const route of routes) {
      const href = hrefFor(route);
      const url = new URL(href, "http://127.0.0.1");
      expect(parseRoute(url.pathname, url.search)).toEqual(route);
    }
    expect(parseRoute("/w/ws-1", "")).toMatchObject({ name: "knowledge", kind: "memory" });
    expect(parseRoute("/nope", "").name).toBe("not-found");
    expect(parseRoute("/w/ws-1/signals/board", "").name).toBe("not-found");
    // Links to the views Signals had before keep working.
    expect(parseRoute("/w/ws-1/signals/instrumentation", "")).toMatchObject({ view: "setup" });
    expect(parseRoute("/w/ws-1/signals/verification", "")).toMatchObject({ view: "overview" });
    expect(parseRoute("/w/ws-1/search", "?kind=bogus")).toMatchObject({
      name: "knowledge",
      kind: "memory",
    });
  });
});

describe("owner path validation", () => {
  it("accepts workspace-relative folders and refuses escapes", () => {
    expect(validatePath("/")).toBeNull();
    expect(validatePath("/src/api")).toBeNull();
    expect(validatePath("src/api")).toBe("pathStart");
    expect(validatePath("/src/../etc")).toBe("pathDots");
    expect(validatePath("/src\\api")).toBe("pathSlashes");
  });
});

describe("session", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("exchanges the launch token once, removes it from the URL and keeps the session for the tab", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ sessionToken: "s-1", expiresAt: "2026-10-10T00:00:00Z" }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const replaced: string[] = [];
    const location = {
      hash: "#launch=abc",
      pathname: "/w/ws/knowledge",
      search: "?kind=rule",
    } as Location;
    const history = {
      replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url),
    } as unknown as History;
    expect(await startSession(location, history)).toBe("s-1");
    expect(replaced).toEqual(["/w/ws/knowledge?kind=rule"]);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/session");
    expect(JSON.parse(String(init.body))).toEqual({ launchToken: "abc" });
    expect(init.credentials).toBe("omit");
    expect(await startSession({ hash: "", pathname: "/", search: "" } as Location, history)).toBe(
      "s-1",
    );
  });

  it("an unauthorized answer clears the session and asks for a relaunch", async () => {
    sessionStorage.setItem("pr-local-session", "old");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "unauthorized", message: "expired" } }), {
            status: 401,
          }),
      ),
    );
    const onUnauthorized = vi.fn();
    const api = createLocalApi("old", onUnauthorized);
    await expect(api.call("runtime.status", {})).rejects.toMatchObject({ code: "unauthorized" });
    expect(onUnauthorized).toHaveBeenCalled();
    expect(sessionStorage.getItem("pr-local-session")).toBeNull();
  });

  it("a server that is gone is a network error, not an empty answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const api = createLocalApi("s", () => {});
    const error = await api.call("workspaces.list", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LocalApiError);
    expect((error as LocalApiError).code).toBe("network");
  });
});

const person = { id: "sertan", name: "sertan" };
const knowledge = [
  {
    id: "m-1",
    kind: "memory",
    title: "Tokens refresh through the gateway",
    preview: "The gateway refreshes access tokens before they expire.",
    path: "/src/api",
    paths: ["/src/api"],
    updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    createdAt: "2026-10-01T10:00:00.000Z",
    versionNumber: 3,
    createdBy: person,
    lastEditedBy: person,
    addedVia: "agent",
  },
  {
    id: "m-2",
    kind: "memory",
    title: "Sessions end after an hour idle",
    preview: "Idle sessions expire after sixty minutes.",
    path: "/src/api/auth",
    paths: ["/src/api/auth"],
    updatedAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    createdAt: "2026-09-01T10:00:00.000Z",
    versionNumber: 1,
    createdBy: person,
    lastEditedBy: person,
    addedVia: "person",
  },
  {
    id: "m-3",
    kind: "memory",
    title: "Write commit messages in English",
    preview: "Every commit message is in English.",
    path: "/",
    paths: ["/"],
    updatedAt: new Date(Date.now() - 200 * 86_400_000).toISOString(),
    createdAt: "2026-01-01T10:00:00.000Z",
    versionNumber: 1,
    createdBy: person,
    lastEditedBy: person,
    addedVia: "person",
  },
  {
    id: "r-1",
    kind: "rule",
    title: "Never log tokens",
    preview: "Redact tokens in every log line.",
    path: "/src/api",
    paths: ["/src/api"],
    updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
    createdAt: "2026-10-01T10:00:00.000Z",
    versionNumber: 1,
    priority: "high",
    scopeType: "folder",
    createdBy: person,
    lastEditedBy: person,
    addedVia: null,
  },
];

describe("the console against a stand-in for `pathrule ui`", () => {
  const calls: LocalUiRoute[] = [];
  const bodies: Array<{ route: LocalUiRoute; body: unknown }> = [];
  let favorites: string[] = [];
  let knowledgeItems: typeof knowledge = [];
  let topicsUnavailable: string | null = null;
  let activityEntries: unknown[] = [];
  beforeEach(() => {
    knowledgeItems = [];
    topicsUnavailable = null;
    activityEntries = [];
    calls.length = 0;
    bodies.length = 0;
    favorites = ["ws-2"];
    localStorage.clear();
    sessionStorage.setItem("pr-local-session", "s-1");
    window.history.replaceState(null, "", "/");
    const answers: Partial<Record<LocalUiRoute, unknown>> = {
      "runtime.status": {
        edition: "local",
        account: "none",
        apiVersion: 1,
        cliVersion: "0.6.1",
        host: { mode: "client", version: "0.6.1", pid: 42, plugins: [] },
        home: "/home/me/.pathrule",
        currentWorkspaceId: "ws-1",
        capabilities: {
          knowledgeRead: { available: true },
          knowledgeWrite: { available: true },
          search: { available: true },
          semanticSearch: {
            available: false,
            reason: "Needs an embedding key (bring your own key).",
          },
          activity: { available: true },
          runtimeEvents: { available: true },
          deliveryStats: { available: true },
          workspaceSummary: { available: true },
          favorites: { available: true },
          knowledgeTopics: { available: true },
          knowledgeHistory: {
            available: false,
            reason: "Pathrule Local keeps no history of edits.",
          },
        },
      },
      "deliveries.stats": {
        days: Array.from({ length: 30 }, (_, index) => ({
          date: new Date(Date.UTC(2026, 8, 14 + index)).toISOString().slice(0, 10),
          memory: 0,
          rule: 0,
          skill: 0,
        })),
        previousTotal: 0,
        items: [{ kind: "memory", id: "m-1", count: 42, previous: 30 }],
        recordedSince: null,
      },
      "knowledge.read": {
        record: {
          kind: "memory",
          path: "/src/api",
          item: {
            id: "m-1",
            workspaceId: "ws-1",
            nodeId: "n1",
            title: "Tokens refresh through the gateway",
            content: "The gateway refreshes access tokens before they expire.",
            source: "claude",
            versionId: "v3",
            versionNumber: 3,
            createdBy: "sertan",
            lastEditedBy: "sertan",
            lastEditedAt: "2026-10-13T10:00:00.000Z",
            createdAt: "2026-10-01T10:00:00.000Z",
            updatedAt: "2026-10-13T10:00:00.000Z",
          },
        },
      },
      "knowledge.topics": {
        status: "ready",
        topics: [
          {
            id: "rg_1",
            name: "Auth & sessions",
            terms: ["auth", "token", "session"],
            homePath: "/src/api",
            items: [
              { kind: "memory", id: "m-1" },
              { kind: "memory", id: "m-2" },
            ],
          },
        ],
        conventions: [{ kind: "memory", id: "m-3" }],
        naming: { status: "named", model: "anthropic/claude-haiku" },
      },
      "workspaces.list": {
        workspaces: [
          { id: "ws-1", name: "acme-web", rootPath: "/home/me/code/acme-web", current: true },
          { id: "ws-2", name: "docs-site", rootPath: "/home/me/code/docs-site", current: false },
        ],
      },
      "workspaces.summary": {
        favorites: ["ws-2"],
        workspaces: [
          {
            id: "ws-1",
            items: { memory: 12, rule: 3, skill: 1 },
            lastActivityAt: new Date(Date.now() - 5 * 60_000).toISOString(),
            deliveries: Array.from({ length: 30 }, (_, i) => (i % 2 ? 4 : 2)),
            previousDeliveries: 60,
            activeSignals: 2,
          },
          {
            id: "ws-2",
            items: { memory: 0, rule: 0, skill: 0 },
            lastActivityAt: new Date(Date.now() - 45 * 86_400_000).toISOString(),
            deliveries: Array.from({ length: 30 }, () => 0),
            previousDeliveries: 0,
            activeSignals: 0,
          },
        ],
      },
      "knowledge.list": { items: [] },
      "knowledge.search": {
        items: [
          {
            kind: "memory",
            id: "m-1",
            title: "Tokens refresh through the gateway",
            preview: "The gateway refreshes access tokens before they expire.",
            path: "/src/api",
            updatedAt: "2026-10-13T10:00:00.000Z",
            versionNumber: 3,
            score: 2,
          },
        ],
      },
      "activity.recent": { entries: [] },
      "tree.get": {
        nodes: [{ id: "n1", relativePath: "/src/api", type: "folder", status: "active" }],
      },
      "signals.status": {
        status: {
          source: "local",
          connected: true,
          lastSeen: "2026-10-09T10:00:00.000Z",
          activeCount: 1,
          declaredCount: 0,
          groupCount: 1,
          releases: [
            {
              environment: "production",
              release: "1.0.0",
              envelopes: 3,
              firstSeen: "2026-10-08T10:00:00.000Z",
              lastSeen: "2026-10-09T10:00:00.000Z",
            },
          ],
        },
      },
      "signals.groups": {
        truncated: false,
        groups: [
          {
            id: "g-1",
            workspaceId: "ws-1",
            environment: "production",
            kind: "error",
            fingerprint: "fp1",
            status: "active",
            nodePath: "/src/api",
            label: "TypeError",
            flow: "login",
            release: "1.0.0",
            message: "TypeError: boom <img src=x onerror=alert(1)>",
            metadata: { stack: "at login (src/api/auth.ts:1:1)", route: "/pay" },
            occurrenceCount: 4,
            releaseOccurrenceCount: 4,
            firstSeen: "2026-10-08T10:00:00.000Z",
            lastSeen: "2026-10-09T10:00:00.000Z",
            revision: 2,
            verification: {
              state: "unobserved",
              candidateRelease: null,
              observationStartedAt: null,
              updatedAt: "2026-10-09T09:00:00.000Z",
              evidence: {
                candidateEnvelopes: 0,
                candidateLastSeenAt: null,
                successes: 0,
                recurrences: 0,
                recurredRelease: null,
              },
              blockedReason: null,
            },
            correction: {
              attemptId: "fix-1",
              recordedAt: "2026-10-09T09:00:00.000Z",
              baselineRelease: "1.0.0",
              note: "guarded the refresh",
              knowledgeRefs: [],
              actor: "Local Console",
            },
          },
        ],
      },
      "signals.group": { group: null, history: [] },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const route = url.replace("/api/", "") as LocalUiRoute;
        calls.push(route);
        bodies.push({ route, body: JSON.parse(String(init.body ?? "{}")) });
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer s-1");
        if (route === "knowledge.list") {
          const body = JSON.parse(String(init.body)) as { kind: string; status?: string };
          const items =
            body.status === "archived" ? [] : knowledgeItems.filter((i) => i.kind === body.kind);
          return new Response(JSON.stringify({ items }), { status: 200 });
        }
        if (route === "activity.recent") {
          return new Response(JSON.stringify({ entries: activityEntries, truncated: false }), {
            status: 200,
          });
        }
        if (route === "knowledge.topics" && topicsUnavailable) {
          return new Response(
            JSON.stringify({ error: { code: "unavailable", message: topicsUnavailable } }),
            { status: 503 },
          );
        }
        if (route === "workspaces.favorite") {
          const body = JSON.parse(String(init.body)) as { workspaceId: string; favorite: boolean };
          favorites = body.favorite
            ? [...favorites.filter((id) => id !== body.workspaceId), body.workspaceId]
            : favorites.filter((id) => id !== body.workspaceId);
          return new Response(JSON.stringify({ favorites }), { status: 200 });
        }
        return new Response(
          JSON.stringify(answers[route] ?? { error: { code: "not_found", message: route } }),
          { status: answers[route] ? 200 : 404 },
        );
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("boots into the overview with no account, organization or billing anywhere", async () => {
    const { container } = render(
      <ThemeProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </ThemeProvider>,
    );
    await flush();
    await flush();
    expect(container.querySelector("h1")?.textContent).toBe("Overview");
    expect(container.textContent).toContain("acme-web");
    expect(container.textContent).toContain("no account · data stays on this machine");
    // An empty workspace: every card keeps its shape and says what will appear, never blank.
    expect(container.textContent).toContain("No deliveries yet");
    expect(container.textContent).toContain("No knowledge yet");
    expect(container.textContent).toContain("No paths with knowledge");
    expect(container.textContent).toContain("No activity yet");
    expect(calls).toContain("deliveries.stats");
    for (const word of [
      "Sign in",
      "Log in",
      "Billing",
      "Subscription",
      "Upgrade",
      "Organization",
      "Seats",
    ]) {
      expect(container.textContent).not.toContain(word);
    }
    expect(calls).toEqual(expect.arrayContaining(["runtime.status", "workspaces.list"]));
    expect(calls.every((route) => !/login|billing|org/.test(route))).toBe(true);
  });

  it("opens a deep link to a runtime group with its fix record, runtime text shown as text", async () => {
    window.history.replaceState(null, "", "/w/ws-1/signals/issues?group=g-1");
    const { container } = render(
      <ThemeProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </ThemeProvider>,
    );
    for (let i = 0; i < 4; i += 1) await flush();
    expect(container.querySelector("h1")?.textContent).toBe("Signals");
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("fix record · a claim, not proof");
    expect(dialog?.textContent).toContain("guarded the refresh");
    expect(dialog?.textContent).toContain("at login (src/api/auth.ts:1:1)");
    expect(document.querySelector("img")).toBeNull();
    expect(calls).toEqual(expect.arrayContaining(["signals.groups", "signals.group", "tree.get"]));
  });

  it("lists the workspaces favorites first, stars one through the backend, and remembers the view", async () => {
    window.history.replaceState(null, "", "/workspaces");
    const { container } = render(
      <ThemeProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </ThemeProvider>,
    );
    for (let i = 0; i < 4; i += 1) await flush();
    expect(container.querySelector("h1")?.textContent).toBe("Workspaces");
    // The figures cover every workspace.
    expect(container.textContent).toContain("16");
    expect(container.textContent).toContain("1 active in the last 7 days");
    expect(container.textContent).toContain("Quiet workspaces");
    // The favorite leads although the other was active more recently.
    const names = () =>
      [...container.querySelectorAll(".lc-ws-card__name")].map((link) => link.textContent);
    expect(names()).toEqual(["docs-site", "acme-web"]);
    expect(
      [...container.querySelectorAll(".pr-group-heading__title")].map((h) => h.textContent),
    ).toEqual(["Favorites1", "Other workspaces1"]);
    expect(container.textContent).toContain("~/code/acme-web");
    expect(container.textContent).toContain("2 signals");
    expect(container.querySelector('a[href="/w/ws-1/overview"]')).not.toBeNull();

    // Starring goes to the backend (this machine's home), never the browser's storage.
    click(byRole(container, "button", "Favorite acme-web")[0]!);
    await flush();
    await flush();
    expect(bodies.at(-1)).toEqual({
      route: "workspaces.favorite",
      body: { workspaceId: "ws-1", favorite: true },
    });
    expect(byRole(container, "button", "Favorite acme-web")[0]!.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(Object.keys(localStorage)).not.toContain(expect.stringContaining("favorite"));

    // A search with no match says so and clears.
    type(container.querySelector('input[type="search"]'), "nothing-like-this");
    await flush();
    expect(container.textContent).toContain("No workspaces match “nothing-like-this”");
    click(byRole(container, "button", "Clear search")[0]!);
    await flush();
    expect(names()).toHaveLength(2);

    // The table view is the browser's choice, kept for the next visit.
    click(byRole(container, "radio", "Table")[0]!);
    await flush();
    expect(container.querySelector("table")).not.toBeNull();
    expect(localStorage.getItem("pathrule.console.workspaces.view")).toBe("table");
    for (const word of ["Billing", "Organization", "Sign in"]) {
      expect(container.textContent).not.toContain(word);
    }
  });

  it("browses knowledge by path and topic, finds it, filters it by health and opens it with its figures", async () => {
    window.history.replaceState(null, "", "/w/ws-1/knowledge");
    knowledgeItems = knowledge;
    const { container } = render(
      <ThemeProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </ThemeProvider>,
    );
    for (let i = 0; i < 4; i += 1) await flush();
    expect(container.querySelector("h1")?.textContent).toBe("Memories");
    // The rail: every folder that holds knowledge, under All paths.
    const tree = container.querySelector(".lc-kn-tree")!;
    expect(tree.textContent).toContain("All paths");
    expect(tree.textContent).toContain("src");
    // Groups by path, the largest and most delivered first; rows carry the person who added them
    // and the topic.
    const titles = () =>
      [...container.querySelectorAll(".lc-kn-row__title")].map((a) => a.textContent);
    expect(titles()).toEqual([
      "Tokens refresh through the gateway",
      "Write commit messages in English",
      "Sessions end after an hour idle",
    ]);
    expect(container.querySelector(".lc-kn-row")?.textContent).toContain("sertan");
    expect(container.querySelector(".lc-kn-row")?.textContent).toContain("Auth & sessions");
    expect(container.querySelector(".lc-kn-row")?.textContent).toContain("42");

    // One box finds by title, path or topic.
    type(container.querySelector('input[type="search"]'), "sessions");
    await flush();
    expect(titles()).toEqual([
      "Tokens refresh through the gateway",
      "Sessions end after an hour idle",
    ]);
    type(container.querySelector('input[type="search"]'), "");
    await flush();

    // Health: only what agents did not receive.
    click(byRole(container, "button", /Not delivered/)[0]!);
    await flush();
    expect(titles()).toEqual([
      "Write commit messages in English",
      "Sessions end after an hour idle",
    ]);
    click(byRole(container, "button", /Not delivered/)[0]!);
    await flush();

    // Topics: the map's groups, by name.
    click(byRole(container, "radio", "Topics")[0]!);
    await flush();
    expect(container.querySelector(".lc-kn-topics")?.textContent).toContain("Auth & sessions");
    // The note says AI names topics, never which provider or model does.
    const note = container.querySelector(".lc-kn-rail__note")?.textContent ?? "";
    expect(note).toBe("Topics are grouped by their links and shared words. AI names them.");
    expect(note).not.toMatch(/anthropic|claude|haiku/i);

    // Opening an item shows its figures and who added it, through an agent.
    click(container.querySelector(".lc-kn-row__title"));
    for (let i = 0; i < 3; i += 1) await flush();
    const panel = document.querySelector('[role="dialog"]');
    expect(panel?.textContent).toContain("Added by sertan through an agent");
    expect(panel?.textContent).toContain("+40%");
  });

  it("groups what agents logged into work sessions, says where knowledge was missing and opens a session", async () => {
    window.history.replaceState(null, "", "/w/ws-1/activity");
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    activityEntries = [
      {
        id: "e1",
        nodePath: "/apps/api/src",
        domain: "backend",
        action: "update",
        summary: "Cloud keeps daily delivery counts",
        createdAt: at(50),
        files: [
          "apps/api/src/knowledge-deliveries.ts",
          "apps/api/migrations/0031_knowledge_deliveries.sql",
        ],
        subjects: ["deliveries", "d1"],
        client: "claude-code",
        person: null,
      },
      {
        id: "e2",
        nodePath: "/apps/api/src",
        domain: "ui",
        action: "create",
        summary: "Overview shows deliveries by kind",
        createdAt: at(40),
        files: [],
        subjects: ["console"],
        client: "claude-code",
        person: null,
      },
    ];
    const { container } = render(
      <ThemeProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </ThemeProvider>,
    );
    for (let i = 0; i < 4; i += 1) await flush();
    expect(container.querySelector("h1")?.textContent).toBe("Activity");
    // One session of two entries, with the folder agents knew nothing about.
    expect(container.querySelectorAll(".lc-ac-session")).toHaveLength(1);
    expect(container.querySelector(".lc-ac-session__title")?.textContent).toBe(
      "Cloud keeps daily delivery counts",
    );
    expect(container.querySelector(".lc-ac-session__uncovered")?.textContent).toContain(
      "No knowledge in /apps/api/src",
    );
    expect(container.textContent).toContain("Worked without knowledge");
    // The page does not repeat that agents wrote the entries; the session drawer says it once.
    expect(container.textContent).not.toContain("Agents write these entries themselves");
    click(container.querySelector(".lc-ac-session__title"));
    for (let i = 0; i < 3; i += 1) await flush();
    const panel = document.querySelector('[role="dialog"]');
    expect(panel?.textContent).toContain("Pathrule does not check them against the code");
    expect(panel?.textContent).toContain("Entries in this session");
    expect(panel?.textContent).toContain("Overview shows deliveries by kind");
    expect(panel?.textContent).toContain("Write a memory");
  });

  it("says why a backend groups no topics for a workspace", async () => {
    window.history.replaceState(null, "", "/w/ws-1/knowledge");
    knowledgeItems = knowledge;
    topicsUnavailable = "Pathrule Cloud groups topics for up to 3,000 items.";
    const { container } = render(
      <ThemeProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </ThemeProvider>,
    );
    for (let i = 0; i < 4; i += 1) await flush();
    click(byRole(container, "radio", "Topics")[0]!);
    await flush();
    expect(container.querySelector(".lc-kn-rail__note")?.textContent).toBe(
      "Topics are not available here: Pathrule Cloud groups topics for up to 3,000 items.",
    );
    // Paths still browse everything.
    click(byRole(container, "radio", "Paths")[0]!);
    await flush();
    expect(container.querySelectorAll(".lc-kn-row__title")).toHaveLength(3);
  });

  it("searches the workspace's knowledge with ⌘K, and has no Search page of its own", async () => {
    const { container } = render(
      <ThemeProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </ThemeProvider>,
    );
    for (let i = 0; i < 3; i += 1) await flush();
    expect(
      [...container.querySelectorAll("a")].some((a) => a.getAttribute("href")?.endsWith("/search")),
    ).toBe(false);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    await flush();
    type(document.body.querySelector('input[role="combobox"]'), "tokens");
    await new Promise((resolve) => setTimeout(resolve, 220));
    for (let i = 0; i < 3; i += 1) await flush();
    expect(bodies.find((b) => b.route === "knowledge.search")?.body).toEqual({
      workspaceId: "ws-1",
      query: "tokens",
      limit: 20,
    });
    expect(document.body.textContent).toContain("Tokens refresh through the gateway");
    expect(document.body.textContent).toContain("Knowledge in acme-web");
  });
});
