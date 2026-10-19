// SPDX-License-Identifier: Apache-2.0
// THE single home of user-facing copy (design skill rule 2). Register:
// sentence case, verb-first command titles, no exclamation marks, NO EM
// DASHES (owner rule), English, "path" never "node". Test-enforced in ui.test.

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export const strings = {
  statusBar: {
    setUp: "Pathrule: Set up",
    resolving: "Pathrule…",
    setUpTooltip: "Connect this folder to Pathrule",
    connect: (account: string): string => `Pathrule: Connect as ${account}`,
    connectTooltip: (account: string): string =>
      `This folder is set up. Connect the extension using your ${account} session.`,
    signIn: "Pathrule: Sign in",
    boundTooltip: (workspace: string, mode: string, summary: string): string =>
      `${workspace} · ${mode} · ${summary}`,
    modeCloud: "Cloud",
    modeLocal: "Local (no account)",
    localSuffix: " · local",
    unreachable: "Pathrule: Cloud unreachable",
    offline: "Pathrule: Offline",
    accessDenied: "Pathrule: No access",
    cloudError: "Pathrule: Cloud error",
    cloudUnavailable: "Pathrule: Cloud not in this build",
    localUnavailable: "Pathrule: Local unavailable",
    conflict: "Pathrule: Choose Cloud or Local",
    failed: "Pathrule: Try again",
  },
  folder: {
    setUp: (edition: string): string => `This folder uses ${edition}. Set up its workspace.`,
    signedOut: (workspace: string): string =>
      `This folder uses the Pathrule Cloud workspace "${workspace}". Sign in to view its knowledge here.`,
    unreachable: (workspace: string): string =>
      `Pathrule Cloud didn't open the workspace "${workspace}" for this folder. You may be offline, or this account may have no access to it.`,
    offline: (workspace: string): string =>
      `Pathrule Cloud can't be reached, so the workspace "${workspace}" isn't shown. Check your connection and try again. Nothing is served from Pathrule Local instead.`,
    accessDenied: (workspace: string): string =>
      `This account has no access to the Pathrule Cloud workspace "${workspace}" (removed, archived or deleted). Sign in with another account, or ask an admin of its organization.`,
    cloudError: (workspace: string): string =>
      `Pathrule Cloud answered with an error for the workspace "${workspace}". Try again in a moment.`,
    cloudUnavailable:
      "This folder uses Pathrule Cloud, which this build of the extension doesn't include.",
    localUnavailable: "This folder uses Pathrule Local, which can't run in this editor.",
    failed: "Pathrule couldn't read which edition serves this folder.",
    signIn: "Sign In",
    tryAgain: "Try Again",
  },
  edition: {
    cloud: "Pathrule Cloud",
    local: "Pathrule Local",
    scopeTitle: (edition: string): string => `Use ${edition} for which projects?`,
    projectScope: "This project only (recommended)",
    projectScopeDetail: (folder: string, edition: string): string =>
      `Only ${folder} uses ${edition}. Other projects keep theirs, and nothing is copied.`,
    deviceScope: "Device default (new projects only)",
    deviceScopeDetail: (edition: string): string =>
      `New projects on this device use ${edition}. Projects already set up keep theirs, and nothing is copied.`,
    deviceOnly: (requested: string, current: string): string =>
      `New projects on this device will use ${requested}. This folder keeps ${current}.`,
    alreadyUses: (edition: string): string => `This folder already uses ${edition}.`,
    nowUses: (edition: string): string => `This folder now uses ${edition}.`,
    useCloud: "Use Pathrule Cloud",
    useLocal: "Use Pathrule Local",
  },
  onboarding: {
    createInOrg: (folder: string, org: string): string => `Create "${folder}" in ${org}`,
    createInOrgDetail: "Cloud workspace, syncs with your team",
    createRecommended: "recommended",
    bindExisting: (name: string): string => `Connect to existing workspace "${name}"`,
    bindExistingDetail: "This folder matches a workspace your team already shares",
    initLocally: "Initialize locally",
    initLocallyNoAccount: "Initialize locally, no account needed",
    initLocallyDetail: "Free, on this machine only. Upgrade to sync with your team anytime.",
    signInCreate: "Sign in & create a cloud workspace",
    signInCreateDetail: "Sign-in opens in your browser on pathrule.io",
    signingIn: "Signing in to Pathrule…",
    signInCode: (code: string): string => `Complete sign-in in your browser. Code: ${code}`,
    switchOrg: "Switch organization…",
    pickTitle: "Set up Pathrule for this folder",
    orgPickTitle: "Choose an organization",
    orgCurrent: "current",
    manageTeamOnWeb: "Manage team on app.pathrule.io",
    progressTitle: "Setting up Pathrule workspace…",
    readyToast: "Workspace ready. Connect your AI clients now?",
    readyConnect: "Connect",
    readyLater: "Later",
    boundExisting: (name: string, path: string): string =>
      `Connected to existing workspace "${name}"${path && path !== "/" ? ` (${path})` : ""}.`,
    signedIn: (account: string): string => `Signed in as ${account}.`,
    signedOut: "Signed out. The Pathrule CLI on this machine is signed out too.",
    signInFailed: "Sign-in didn't complete. Check your connection and try again.",
    localUnavailable: "Local mode isn't available in this build. Sign in to use cloud mode.",
    localUnavailableNoCloud:
      "Local mode isn't available in this editor, and this build has no cloud mode.",
    cloudUnavailable:
      "Pathrule Cloud isn't part of this build of the extension. Local mode works without it.",
    initLocallyOpenDetail: "Free, on this machine only.",
    setupFailed: "Pathrule couldn't set up this folder.",
    retry: "Retry",
    connectFailed: "Pathrule couldn't connect with your existing session. Try signing in.",
    createDespiteMatch: (name: string): string =>
      `This folder already matches the workspace "${name}". Creating a new one will duplicate it. Connect to "${name}" instead?`,
    createAnyway: "Create a new workspace",
    connectMatch: (name: string): string => `Connect to "${name}"`,
  },
  connect: {
    pickTitle: "Connect AI clients to this workspace",
    thisEditor: "this editor",
    targetDetail: (name: string): string => `Write the Pathrule MCP entry into ${name}'s config`,
    copilotAuto: "Copilot agent mode is registered automatically by this extension",
    progressTitle: "Connecting AI clients…",
    wroteConfig: (name: string): string => `${name} MCP config updated`,
    wroteHooks: "Context hooks installed (.claude/settings.json, protocol rules, hook index)",
    done: "AI clients connected.",
    failed: "Pathrule couldn't finish connecting your AI clients.",
    runDoctor: "Check Integration",
  },
  updates: {
    available: (latest: string, current: string): string =>
      `Pathrule ${latest} is available. You're using ${current}.`,
    required:
      "Your Pathrule extension is outdated. Update it to continue using the latest Cloud capabilities.",
    restartToActivate: (version: string): string =>
      `Pathrule ${version} has been installed. Restart Extensions to activate it.`,
    hostUpdatesAnyway: (latest: string): string =>
      `Pathrule ${latest} is available. Your editor updates extensions automatically, so Notify only cannot hold it back. Turn off automatic updates for Pathrule in the Extensions view to choose when it updates.`,
    update: "Update",
    restartExtensions: "Restart Extensions",
    doctorName: "Pathrule extension",
    summary: (v: {
      version: string;
      cliVersion: string;
      marketplace: string;
      autoUpdate: "on" | "off" | "selected";
      latest: string | null;
      policy: "automatic" | "notify";
    }): string =>
      `${v.version} · CLI ${v.cliVersion} · ${v.marketplace} · editor updates ${
        v.autoUpdate === "selected" ? "for selected extensions" : v.autoUpdate
      } · Pathrule ${v.policy === "automatic" ? "Automatic" : "Notify only"}${
        v.latest ? ` · latest ${v.latest}` : ""
      }`,
  },
  doctor: {
    allGood: "Everything checks out.",
    issues: (n: number): string =>
      `${n} ${n === 1 ? "issue" : "issues"} found. Run Connect AI Clients to fix.`,
    fix: "Connect AI Clients",
  },
  editor: {
    conflictShort: "Save conflict: this content changed remotely.",
    conflictBody: "Someone else updated this content while you edited. Your version was not saved.",
    conflictReload: "Reload",
    conflictCopy: "Copy My Version & Reload",
    conflictKeepMine: "Keep Mine (Overwrite)",
    readonlySkill: "This skill is linked to a source on GitHub. Edit the source instead.",
  },
  create: {
    memoryTitlePrompt: "Memory title",
    memoryTitlePlaceholder: "The decision, gotcha or convention to remember",
    ruleNamePrompt: "Rule name",
    ruleNamePlaceholder: "The constraint the AI must follow here",
    skillNamePrompt: "Skill name",
    skillNamePlaceholder: "kebab-case name for this reusable procedure",
    pickPathPrompt: "Scope to which path?",
    memoryTemplate: (title: string): string => `# ${title}\n\n`,
    ruleTemplate: "Describe the constraint. Keep it testable.\n",
    skillTemplate: (name: string): string =>
      `---\nname: ${name}\ndescription: \n---\n\n# ${name}\n\n## Steps\n\n1. \n`,
    selectionDefaultTitle: "Decision from selection",
  },
  remove: {
    confirm: (kind: string, label: string): string => `Delete ${kind} "${label}"?`,
    confirmDetail: "It moves to the archive and can be restored.",
    confirmAction: "Delete",
    undone: (kind: string): string => `The ${kind} was deleted.`,
    undo: "Undo",
  },
  menu: {
    title: "Pathrule",
    browse: "Browse Knowledge for Active File",
    search: "Search Knowledge",
    connect: "Connect AI Clients",
    doctor: "Check Integration",
    switchOrg: "Switch Organization",
    team: "Manage Team on app.pathrule.io",
    pushToCloud: "Push Workspace to Cloud",
    signOut: "Sign Out",
  },
  search: {
    title: "Search knowledge",
    placeholder: "Memories, rules and skills across this workspace",
    nothing: "No knowledge in this workspace yet.",
  },
  rename: {
    prompt: (kind: string): string => `New ${kind} ${kind === "memory" ? "title" : "name"}`,
  },
  move: {
    pickTitle: (count: number): string =>
      count === 1 ? "Move to which path?" : `Move ${count} items to which path?`,
    customPath: "Choose another path…",
    customPrompt: "Workspace-relative path (missing folders are created)",
    done: (count: number, path: string): string =>
      count === 1 ? `Moved to ${path}.` : `Moved ${count} items to ${path}.`,
  },
  bulk: {
    deleteConfirm: (count: number): string => `Delete ${count} items?`,
    deleted: (count: number): string => `${count} items deleted.`,
  },
  push: {
    needsSignIn: "Sign in to push this workspace to the cloud.",
    alreadyCloud: "This folder already has a cloud workspace. Connected to it instead.",
    pickOrg: "Push to which organization?",
    progress: "Pushing workspace to the cloud…",
    progressItem: (label: string): string => `Copying ${label}`,
    done: (memories: number, rules: number, skills: number): string =>
      `Pushed to the cloud: ${strings.counts.summary(memories, rules, skills) || "workspace"}. This folder now uses the cloud workspace.`,
    failed: "Push to cloud didn't finish. Your local workspace is unchanged.",
    note: "Activity history stays local; content and structure move.",
  },
  delivery: {
    header: "Delivers to AI sessions here",
    more: (n: number): string => `and ${n} more`,
    none: "Nothing scoped to this path yet",
  },
  info: {
    title: (kind: string, label: string): string => `${capitalize(kind)} "${label}"`,
    path: (path: string): string => `Path: ${path}`,
    created: (when: string): string => `Created: ${when}`,
    createdBy: (when: string, by: string): string => `Created: ${when} by ${by}`,
    edited: (when: string): string => `Last edited: ${when}`,
    editedBy: (when: string, by: string): string => `Last edited: ${when} by ${by}`,
    version: (n: number): string => `Version: ${n}`,
    source: (source: string): string => `Source: ${source}`,
    open: "Open",
    copyPrompt: "Copy as Prompt",
  },
  prompt: {
    /** Agent-ready pointer. Carries the stable id so the agent can read/update it
     *  directly (no name-resolution roundtrip); name + path stay for humans. */
    forContent: (kind: string, label: string, path: string, id: string): string =>
      `Use the Pathrule ${kind} "${label}" (id: ${id}, scoped to ${path}) for this task. ` +
      `To edit it, call pathrule_update_${kind} with that id and a content_edit delta (no lookup needed).`,
    copied: "Prompt copied. Paste it into any AI chat to point the agent at this content.",
  },
  browse: {
    title: (path: string): string => `Knowledge for ${path}`,
    placeholder: "What an AI session on this path receives. Pick to open.",
    inheritedFrom: (path: string): string => `inherited from ${path}`,
    empty: (path: string): string => `Nothing is scoped to ${path} yet.`,
    addFirst: "New Memory Here",
  },
  counts: {
    summary(memories: number, rules: number, skills: number): string {
      const parts: string[] = [];
      if (memories > 0) parts.push(`${memories} ${memories === 1 ? "memory" : "memories"}`);
      if (rules > 0) parts.push(`${rules} ${rules === 1 ? "rule" : "rules"}`);
      if (skills > 0) parts.push(`${skills} ${skills === 1 ? "skill" : "skills"}`);
      return parts.join(" · ");
    },
    none: "no content yet",
  },
} as const;
