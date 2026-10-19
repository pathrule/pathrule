// SPDX-License-Identifier: Apache-2.0
// The Local Console's workspace sections (memories, rules, skills and activity) and its ⌘K search for another
// console to mount. Pathrule Cloud's console shows them over the same Local UI API contract
// (@pathrule/protocol/local-ui-api.ts), answered by Pathrule Cloud instead of `pathrule ui`: one
// interface, two backends. The host supplies the context (./app/context.tsx) and the route base.
import "./console.css";

export { ConsoleProvider, useConsole, type ConsoleContextValue } from "./app/context.js";
export { LocalApiError, type LocalApi, type LocalErrorCode } from "./api/client.js";
export { KnowledgePage } from "./pages/KnowledgePage.js";
export {
  KnowledgeSearch,
  type KnowledgeSearchProps,
  type SearchAddresses,
  type SearchTarget,
} from "./search/KnowledgeSearch.js";
export { ActivityPage } from "./pages/ActivityPage.js";
export { WorkspaceOverview, type WorkspaceOverviewProps } from "./overview/WorkspaceOverview.js";
export {
  WorkspaceDirectory,
  type WorkspaceDirectoryProps,
} from "./workspaces/WorkspaceDirectory.js";
export { hrefFor, parseRoute, setRouteBase, type Route } from "./router.js";
export { knowledgeAtIndex, useKnowledgeAt } from "./signals/knowledge-at.js";
export { consoleMessages, useConsoleMessages } from "./messages.js";
