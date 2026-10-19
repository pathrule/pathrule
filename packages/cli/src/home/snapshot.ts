// SPDX-License-Identifier: Apache-2.0
// Reads the facts of the project home, in two steps so the home paints at once:
//
// - **Quick** (`readQuickFacts`): files only, no network and no host. The mode and capabilities this
//   run loaded, the folder's workspace (read in this process, which opens no store), the
//   integration registry and runtime manifest (the native engine's readers), the agents found on
//   PATH (existence only, no version probes), and whether a Cloud session is stored (never checked:
//   a check may refresh it over the network).
// - **Store** (`readStoreFacts`): what the local store holds, through the Pathrule host, the stores'
//   one owner, plus the delivery ledgers. Opening the home only asks a host that is already running
//   (`launch: false`); starting one (it writes its own files in the Pathrule home) waits for the
//   person's Refresh, or an explicit command (`pathrule home --json`). Only for a folder a local
//   workspace serves; Cloud knowledge is not read here.
//
// Nothing here writes, signs in or reaches the network.
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { readDeliveryLedger } from "@pathrule/integrations/native/delivery-ledger.js";
import { deliveryLedgerPath } from "@pathrule/integrations/native/home.js";
import { detectProviders } from "@pathrule/integrations/native/providers.js";
import { readIntegrationRegistry } from "@pathrule/integrations/native/registry-io.js";
import { readRuntimeManifest } from "@pathrule/integrations/native/runtime-manifest-io.js";
import { connectHost } from "@pathrule/host/client.js";
import { connectRemoteStore, type RemoteStore } from "@pathrule/host/remote-store.js";
import type { HostSession } from "@pathrule/host/session.js";

import { capabilityById } from "../capabilities/catalog.js";
import { folderEdition } from "../capabilities/folder-edition.js";
import { capabilityHost } from "../capabilities/host.js";
import { hasCliSession } from "../capabilities/selection.js";
import { CLI_VERSION } from "../cli-version.js";
import { cliHostSession } from "../local/host-session.js";
import { cliAccount, cliPlugins } from "../plugin.js";
import { explainInstallFailure, sanitize } from "./explain.js";
import {
  ATOM_KINDS,
  contextFacts,
  deferred,
  loading,
  measured,
  unavailable,
  type AccountFact,
  type ActivityItem,
  type AgentFact,
  type AtomCounts,
  type AtomKind,
  type DeliverySummary,
  type Fact,
  type HomeSnapshot,
  type IntegrationsFact,
  type IntelligenceFact,
  type KnowledgeCounts,
  type PathCount,
  type SignalsSummary,
  type WorkspaceFact,
} from "./facts.js";

/** How long the store step may take before the home says it could not read the store. */
export const STORE_TIMEOUT_MS = 15_000;
/** The delivery ledgers read, newest first: enough for the picture, bounded for big homes. */
export const DELIVERY_SESSIONS_READ = 50;
/** Activity entries read: the cockpit shows as many as fit, the one-column home the newest five. */
const ACTIVITY_READ = 12;

export interface SnapshotInput {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The session to read stores through; by default a CLI host session, closed after the read. */
  session?: HostSession;
  now?: () => number;
}

// ── Quick facts ──────────────────────────────────────────────────────────────

function workspaceFact(session: HostSession, cwd: string, env: NodeJS.ProcessEnv): WorkspaceFact {
  const isProject = existsSync(join(cwd, ".git")) || existsSync(join(cwd, ".pathrule"));
  let identity: ReturnType<HostSession["resolveLocal"]> = null;
  try {
    identity = session.resolveLocal(cwd, { includeMirrors: true });
  } catch (err) {
    return {
      kind: "none",
      id: null,
      name: null,
      root: null,
      relativePath: null,
      isProject,
      problem: sanitize(reasonOf(err), env),
    };
  }
  if (!identity) {
    return { kind: "none", id: null, name: null, root: null, relativePath: null, isProject };
  }
  return {
    kind: identity.mirror ? "mirror" : "local",
    id: identity.workspaceId,
    name: basename(identity.root),
    root: identity.root,
    relativePath: identity.relativePath,
    isProject,
  };
}

function intelligenceFact(
  agentsMode: IntelligenceFact["agentsMode"],
  env: NodeJS.ProcessEnv,
  cwd: string,
): IntelligenceFact {
  // The edition serving this folder (capabilities/folder-edition.ts). A folder not set up yet (it
  // has no choice and no workspace, so only the device default speaks for it) or whose Local and
  // Cloud workspaces conflict reads as not chosen, and the home offers setup.
  const folder = folderEdition(cwd, env);
  const folderMode: IntelligenceFact["mode"] =
    folder.mode === null || folder.source === "device-default" ? "unset" : folder.mode;
  const host = capabilityHost();
  if (!host) {
    const mode = folderMode;
    return {
      mode,
      chosenBy: mode === "unset" ? null : "built-in",
      capabilities: cliPlugins()
        .filter((plugin) => plugin.account)
        .map(() => ({
          id: "cloud" as const,
          title: "Pathrule Cloud",
          state: "ready" as const,
          detail: "built in",
        })),
      agentsMode,
    };
  }
  const selection = host.selection;
  const mode = folderMode;
  const capabilities = (selection?.capabilities ?? []).map((id) => {
    const loaded = host.loaded.find((c) => c.id === id);
    const problem = host.problems.find((p) => p.id === id);
    return {
      id,
      title: capabilityById(id).title,
      state: loaded ? ("ready" as const) : ("unavailable" as const),
      detail: loaded
        ? `${loaded.version}`
        : problem
          ? explainInstallFailure(problem.reason, env)
          : "not loaded in this run",
    };
  });
  return { mode, chosenBy: selection?.source ?? null, capabilities, agentsMode };
}

function accountFact(mode: IntelligenceFact["mode"], env: NodeJS.ProcessEnv): AccountFact {
  // Local never asks the account anything, even with Pathrule Cloud installed beside it.
  if (mode !== "cloud") {
    return { applicable: false, state: "signed_out", detail: "Local needs no account." };
  }
  if (!cliAccount()) {
    return {
      applicable: true,
      state: "unknown",
      detail: "Pathrule Cloud is not loaded in this run, so there is no sign-in to use.",
    };
  }
  return hasCliSession(env)
    ? {
        applicable: true,
        state: "session_stored",
        detail: "A sign-in is stored on this machine; it is checked only when you ask (s).",
      }
    : { applicable: true, state: "signed_out", detail: "Not signed in: s signs in." };
}

async function integrationsFact(env: NodeJS.ProcessEnv): Promise<IntegrationsFact> {
  const [providers, registry, manifest] = await Promise.all([
    detectProviders({ env, home: env.HOME || undefined, probeVersions: false }).catch(() => []),
    readIntegrationRegistry(env).catch(() => ({ integrations: [] })),
    readRuntimeManifest(env).catch(() => null),
  ]);
  const agents: AgentFact[] = providers.map((provider) => ({
    id: provider.id,
    name: provider.displayName,
    support: provider.support,
    detected: provider.detected,
    connections: registry.integrations
      .filter((record) => record.provider === provider.id)
      .map((record) => ({
        scope: record.scope,
        projectRoot: record.project_root,
        mode: record.mode,
        channel: record.channel,
        status: record.status,
      })),
  }));
  return {
    agents,
    runtime: manifest
      ? {
          version: manifest.runtime_version,
          mode: manifest.mode ?? null,
          maintenance: manifest.maintenance.consent,
        }
      : null,
  };
}

/** What the home paints first: files only, no network, no host. */
export async function readQuickFacts(input: SnapshotInput): Promise<HomeSnapshot> {
  const session = input.session ?? cliHostSession(input.env);
  const integrations = await integrationsFact(input.env);
  // Agents run no edition of their own any more: the MCP server they start resolves each folder.
  const intelligence = intelligenceFact(null, input.env, input.cwd);
  const workspace = workspaceFact(session, input.cwd, input.env);
  const local = workspace.kind === "local";
  const notRead = (reason: string) => unavailable<never>(reason);
  const storeFact = <T>(): Fact<T> =>
    local
      ? loading<T>()
      : workspace.problem
        ? notRead(`The workspace could not be read: ${workspace.problem}`)
        : workspace.kind === "mirror"
          ? notRead("This folder is a Cloud workspace; the terminal home reads local stores only.")
          : notRead("No Pathrule workspace serves this folder yet.");
  return {
    schema: 1,
    cliVersion: CLI_VERSION,
    cwd: input.cwd,
    workspace,
    intelligence,
    account: accountFact(intelligence.mode, input.env),
    integrations,
    knowledge: storeFact<KnowledgeCounts>(),
    agentIr: storeFact<AtomCounts>(),
    signals: storeFact<SignalsSummary>(),
    activity: storeFact<ActivityItem[]>(),
    paths: storeFact<PathCount[]>(),
    refreshes: storeFact<number>(),
    deliveries: workspace.id ? loading<DeliverySummary>() : notRead("No workspace, no deliveries."),
    context: contextFacts(),
  };
}

// ── Store facts ──────────────────────────────────────────────────────────────

const STORE_SOURCE = "local store, through the Pathrule host";
/** The facts the store step fills in. */
const STORE_KEYS = ["knowledge", "agentIr", "signals", "activity", "paths", "refreshes"] as const;

/** A workspace path as the home shows it: "/" for the root, a leading slash otherwise. */
export function displayPath(relativePath: string): string {
  const trimmed = relativePath.replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}` : "/";
}

/** What each node of the overview holds directly, in the overview's path order. */
function pathCounts(
  overview: Array<{
    relative_path: string;
    memories: unknown[];
    rules: unknown[];
    skills: unknown[];
  }>,
): PathCount[] {
  return overview.map((node) => ({
    path: displayPath(node.relative_path),
    memories: node.memories.length,
    rules: node.rules.length,
    skills: node.skills.length,
  }));
}

export function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A store method an older host lacks says so; the fact is unavailable rather than the home broken. */
async function optional<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (err) {
    if (/method_not_found|not a function|unknown method/i.test(reasonOf(err))) return undefined;
    throw err;
  }
}

async function knowledgeCounts(store: RemoteStore, workspaceId: string): Promise<KnowledgeCounts> {
  const count = async (list: Promise<unknown[]>) => (await list).length;
  const [ma, mx, ra, rx, sa, sx] = await Promise.all([
    count(store.listMemories({ workspaceId, status: "active" })),
    count(store.listMemories({ workspaceId, status: "archived" })),
    count(store.listRules({ workspaceId, status: "active" })),
    count(store.listRules({ workspaceId, status: "archived" })),
    count(store.listSkills({ workspaceId, status: "active" })),
    count(store.listSkills({ workspaceId, status: "archived" })),
  ]);
  return {
    memories: { active: ma, archived: mx },
    rules: { active: ra, archived: rx },
    skills: { active: sa, archived: sx },
  };
}

async function atomCounts(
  store: RemoteStore,
  workspaceId: string,
): Promise<AtomCounts | undefined> {
  const readers: Record<AtomKind, [() => Promise<unknown[]>, () => Promise<unknown[]>]> = {
    remedy: [
      () => store.listActiveScopedRemedies(workspaceId),
      () => store.listProposedRemedyAtoms(workspaceId),
    ],
    selection: [
      () => store.listActiveScopedSelections(workspaceId),
      () => store.listProposedSelectionAtoms(workspaceId),
    ],
    procedure: [
      () => store.listActiveScopedProcedures(workspaceId),
      () => store.listProposedProcedureAtoms(workspaceId),
    ],
    context: [
      () => store.listActiveScopedContexts(workspaceId),
      () => store.listProposedContextAtoms(workspaceId),
    ],
    rationale: [
      () => store.listActiveScopedRationales(workspaceId),
      () => store.listProposedRationaleAtoms(workspaceId),
    ],
    precedence: [
      () => store.listActiveScopedPrecedences(workspaceId),
      () => store.listProposedPrecedenceAtoms(workspaceId),
    ],
  };
  const byKind = {} as AtomCounts["byKind"];
  let approved = 0;
  let proposed = 0;
  for (const kind of ATOM_KINDS) {
    const [active, pending] = readers[kind];
    const [a, p] = await Promise.all([optional(active), optional(pending)]);
    if (a === undefined || p === undefined) return undefined;
    byKind[kind] = { approved: a.length, proposed: p.length };
    approved += a.length;
    proposed += p.length;
  }
  return { approved, proposed, byKind };
}

/** The delivery ledgers of a workspace, newest first, read with the native engine's reader. */
export async function deliverySummary(
  workspaceId: string,
  env: NodeJS.ProcessEnv,
  limit = DELIVERY_SESSIONS_READ,
  now = Date.now(),
): Promise<DeliverySummary> {
  const dir = dirname(deliveryLedgerPath(workspaceId, "home", env));
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    names = [];
  }
  const dated = await Promise.all(
    names.map(async (name) => ({
      stem: name.slice(0, -".jsonl".length),
      mtime: await stat(join(dir, name)).then(
        (info) => info.mtimeMs,
        () => 0,
      ),
    })),
  );
  dated.sort((a, b) => b.mtime - a.mtime);
  const summary: DeliverySummary = {
    sessions: 0,
    items: 0,
    byChannel: { hook: 0, mcp: 0 },
    byKind: {},
    lastAt: null,
    hourly: new Array<number>(24).fill(0),
    sessionsRead: 0,
    sessionsTotal: dated.length,
  };
  for (const { stem } of dated.slice(0, limit)) {
    const state = await readDeliveryLedger(workspaceId, stem, env);
    summary.sessionsRead += 1;
    if (state.delivered.size === 0) continue;
    summary.sessions += 1;
    for (const [key, entry] of state.delivered) {
      summary.items += 1;
      summary.byChannel[entry.channel] += 1;
      const kind = key.slice(0, key.indexOf(":"));
      summary.byKind[kind] = (summary.byKind[kind] ?? 0) + 1;
      if (!summary.lastAt || entry.at > summary.lastAt) summary.lastAt = entry.at;
      const age = (now - Date.parse(entry.at)) / 3_600_000;
      if (age >= 0 && age < 24) summary.hourly[23 - Math.floor(age)]! += 1;
    }
  }
  return summary;
}

/** How the store step reaches the stores: a running host only, or a session that may start one. */
interface StoreAccess {
  workspaces(): Promise<Array<{ id: string; name: string }>>;
  store(workspaceId: string): Promise<RemoteStore>;
  close(): Promise<void>;
}

async function runningHostAccess(env: NodeJS.ProcessEnv): Promise<StoreAccess | null> {
  const client = await connectHost({ env });
  if (!client) return null;
  return {
    workspaces: () => client.call("workspace.list", {}),
    store: (workspaceId) => connectRemoteStore(client, workspaceId),
    close: async () => {},
  };
}

function sessionAccess(session: HostSession, owned: boolean): StoreAccess {
  return {
    workspaces: () => session.listWorkspaces(),
    store: (workspaceId) => session.store(workspaceId),
    close: async () => {
      if (owned) await session.close().catch(() => {});
    },
  };
}

export interface StoreReadOptions {
  /**
   * Whether this read may start the Pathrule host. False when the home opens: a host that runs
   * already is asked, and otherwise the store facts wait for Refresh.
   */
  launch: boolean;
}

/** The reason a store fact waits for the person, while no host runs. */
export const NOT_READ_YET =
  "r reads it (starts the local Pathrule host, as any knowledge command does)";

/**
 * The facts that need the store and the ledgers: `snapshot` with them filled in. Each one that
 * cannot be read says why; one failing never hides the others.
 */
export async function readStoreFacts(
  snapshot: HomeSnapshot,
  input: SnapshotInput,
  options: StoreReadOptions = { launch: true },
): Promise<HomeSnapshot> {
  const next: HomeSnapshot = { ...snapshot };
  const deliveries = snapshot.workspace.id
    ? deliverySummary(
        snapshot.workspace.id,
        input.env,
        DELIVERY_SESSIONS_READ,
        input.now?.() ?? Date.now(),
      ).then(
        (value) => measured(value, "session delivery ledgers (receipts)"),
        (err) =>
          unavailable<DeliverySummary>(
            `The ledgers could not be read: ${sanitize(reasonOf(err), input.env)}`,
          ),
      )
    : Promise.resolve(snapshot.deliveries);

  if (snapshot.workspace.kind === "local" && snapshot.workspace.id) {
    const workspaceId = snapshot.workspace.id;
    let access: StoreAccess | null = null;
    try {
      access = options.launch
        ? sessionAccess(input.session ?? cliHostSession(input.env), !input.session)
        : await runningHostAccess(input.env);
      if (!access) {
        for (const key of STORE_KEYS) {
          next[key] = deferred(NOT_READ_YET);
        }
      } else {
        const reading = access;
        await withTimeout(
          (async () => {
            const listed = await reading.workspaces();
            const named = listed.find((w) => w.id === workspaceId);
            if (named) next.workspace = { ...snapshot.workspace, name: named.name };
            const store = await reading.store(workspaceId);
            const [knowledge, atoms, signals, activity, overview, refreshes] =
              await Promise.allSettled([
                knowledgeCounts(store, workspaceId),
                atomCounts(store, workspaceId),
                optional(() => store.runtimeEventStatus(workspaceId)),
                store.recentActivities({ workspaceId, relativePath: "" }, ACTIVITY_READ),
                optional(() => store.workspaceOverview(workspaceId)),
                optional(() => store.listPendingRefreshes(workspaceId, true)),
              ]);
            const failed = (what: string, err: unknown) =>
              unavailable<never>(
                `${what} could not be read: ${sanitize(reasonOf(err), input.env)}`,
              );
            next.knowledge =
              knowledge.status === "fulfilled"
                ? measured(knowledge.value, STORE_SOURCE)
                : failed("The store", knowledge.reason);
            next.agentIr =
              atoms.status === "fulfilled"
                ? atoms.value
                  ? measured(atoms.value, STORE_SOURCE)
                  : unavailable("The running Pathrule host predates Agent IR atoms.")
                : failed("Agent IR atoms", atoms.reason);
            next.signals =
              signals.status === "fulfilled"
                ? signals.value
                  ? measured(
                      {
                        groups: signals.value.groupCount,
                        active: signals.value.activeCount,
                        declared: signals.value.declaredCount,
                        lastSeen: signals.value.lastSeen,
                      },
                      STORE_SOURCE,
                    )
                  : unavailable("The running Pathrule host predates Signals.")
                : failed("Signals", signals.reason);
            next.activity =
              activity.status === "fulfilled"
                ? measured(
                    activity.value.map((row) => ({
                      at: row.createdAt,
                      path: row.nodePath ?? null,
                      summary: sanitize(row.taskSummary ?? "", input.env, 400),
                    })),
                    "activity log written by agents (not verified)",
                  )
                : failed("Activity", activity.reason);
            next.paths =
              overview.status === "fulfilled"
                ? overview.value
                  ? measured(pathCounts(overview.value), STORE_SOURCE)
                  : unavailable("The running Pathrule host predates the knowledge overview.")
                : failed("The knowledge overview", overview.reason);
            next.refreshes =
              refreshes.status === "fulfilled"
                ? refreshes.value
                  ? measured(refreshes.value.length, STORE_SOURCE)
                  : unavailable("The running Pathrule host predates refresh tasks.")
                : failed("Refresh tasks", refreshes.reason);
          })(),
          STORE_TIMEOUT_MS,
          `The Pathrule host did not answer within ${STORE_TIMEOUT_MS / 1000} s.`,
        );
      }
    } catch (err) {
      const reason = sanitize(reasonOf(err), input.env);
      for (const key of STORE_KEYS) {
        if (next[key].state === "loading") next[key] = unavailable(reason);
      }
    } finally {
      await access?.close();
    }
  }

  next.deliveries = await deliveries;
  return next;
}

/** Quick facts, then store facts (starting the host): what `pathrule home --json` prints. */
export async function readHomeSnapshot(input: SnapshotInput): Promise<HomeSnapshot> {
  return readStoreFacts(await readQuickFacts(input), input, { launch: true });
}
