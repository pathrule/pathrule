// SPDX-License-Identifier: Apache-2.0
import type {
  LocalCapabilities,
  LocalWorkspaceSummary,
  RuntimeStatusResponse,
} from "@pathrule/protocol/local-ui-api.js";
import { createContext, useContext, type ReactNode } from "react";
import type { LocalApi } from "../api/client.js";
import type { Route } from "../router.js";

export interface ConsoleContextValue {
  api: LocalApi;
  /** What the backend behind `api` can do; the workspace sections read only this. */
  capabilities: LocalCapabilities;
  /**
   * The local runtime's status, or null where no local runtime serves the console: Pathrule
   * Cloud's console mounts the workspace sections (./workspace.ts) over its own backend.
   */
  status: RuntimeStatusResponse | null;
  workspaces: LocalWorkspaceSummary[];
  /** The workspace the current route is about, or the default one. */
  workspace: LocalWorkspaceSummary | null;
  route: Route;
  navigate: (href: string, options?: { replace?: boolean }) => void;
  /** Re-reads runtime status and the workspace list. */
  refreshRuntime: () => void;
  /**
   * Whether an item's detail shows its id. The Local Console does (`pathrule` commands take it);
   * Pathrule Cloud's console does not, where an id is nothing a person acts on. Default: shown.
   */
  itemIds?: boolean;
}

const ConsoleContext = createContext<ConsoleContextValue | null>(null);

export function ConsoleProvider({
  value,
  children,
}: {
  value: ConsoleContextValue;
  children: ReactNode;
}) {
  return <ConsoleContext.Provider value={value}>{children}</ConsoleContext.Provider>;
}

export function useConsole(): ConsoleContextValue {
  const value = useContext(ConsoleContext);
  if (!value) throw new Error("useConsole must be used inside <ConsoleProvider>");
  return value;
}

/** The local runtime's status, for the pages only the Local Console has (overview, runtime, signals). */
export function useRuntimeStatus(): RuntimeStatusResponse {
  const { status } = useConsole();
  if (!status) throw new Error("useRuntimeStatus needs the local runtime's status");
  return status;
}
