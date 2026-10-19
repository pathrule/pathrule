// SPDX-License-Identifier: Apache-2.0
/**
 * The capabilities the person chose, kept in `<PATHRULE_HOME>/capabilities/selection.json`.
 *
 * - **What it holds:** the capabilities this machine runs with, and the mode bare `pathrule setup`
 *   runs (null: setup asks).
 * - **Who writes it:** `pathrule setup` when the person chooses (./onboarding.ts), and once, the
 *   mapping of an install that predates onboarding (below).
 * - **What reads it:** every run of the npm CLI (./host.ts), which loads exactly these capabilities
 *   and installs any that are missing for its version.
 *
 * An install that predates onboarding keeps what it had, and nothing is inferred beyond it: a
 * signed-in CLI session maps to Cloud, since its AI clients' MCP servers serve the account and must
 * keep serving it rather than the local store. Anything else runs the open CLI until the person
 * chooses.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { localRuntimePaths } from "@pathrule/core/storage/paths.js";

import {
  MODE_CAPABILITIES,
  orderedCapabilities,
  type CapabilityId,
  type SetupMode,
} from "./catalog.js";
import { capabilitiesRoot } from "./home.js";

export interface CapabilitySelection {
  schema: 1;
  /** Loaded on every run, in catalog order. */
  capabilities: CapabilityId[];
  /** What bare `pathrule setup` runs; null when it asks. */
  setup: SetupMode | null;
  /** How the selection was made. */
  source: "onboarding" | "flag" | "existing-install";
  updatedAt: string;
}

const SELECTION_FILE = "selection.json";

export function selectionPath(env: NodeJS.ProcessEnv): string {
  return join(capabilitiesRoot(env), SELECTION_FILE);
}

/** The stored selection, or null when there is none or it cannot be read. */
export function readSelection(env: NodeJS.ProcessEnv): CapabilitySelection | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(selectionPath(env), "utf8"));
  } catch {
    return null;
  }
  const value = raw as Partial<CapabilitySelection> | null;
  if (!value || value.schema !== 1 || !Array.isArray(value.capabilities)) return null;
  const setup = value.setup === "cloud" || value.setup === "local" ? value.setup : null;
  return {
    schema: 1,
    capabilities: normalised(value.capabilities.map(String)),
    setup,
    source:
      value.source === "onboarding" || value.source === "flag" ? value.source : "existing-install",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
  };
}

/** Writes the selection atomically (a temporary file renamed over the old one). */
export function writeSelection(
  env: NodeJS.ProcessEnv,
  selection: Omit<CapabilitySelection, "schema" | "updatedAt">,
  now: Date = new Date(),
): CapabilitySelection {
  const stored: CapabilitySelection = {
    schema: 1,
    capabilities: normalised(selection.capabilities),
    setup: selection.setup,
    source: selection.source,
    updatedAt: now.toISOString(),
  };
  const root = capabilitiesRoot(env);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const tmp = join(root, `.${SELECTION_FILE}.${process.pid}.${randomBytes(4).toString("hex")}`);
  try {
    writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, selectionPath(env));
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return stored;
}

/**
 * The selection after the person chose a mode: Cloud adds Cloud to what was chosen before; Local is
 * the open CLI alone, nothing proprietary loaded.
 */
export function chooseMode(
  previous: CapabilitySelection | null,
  mode: SetupMode,
  options: { source: CapabilitySelection["source"] },
): Omit<CapabilitySelection, "schema" | "updatedAt"> {
  if (mode === "local") return { capabilities: [], setup: "local", source: options.source };
  return {
    capabilities: normalised([...(previous?.capabilities ?? []), ...MODE_CAPABILITIES[mode]]),
    setup: mode,
    source: options.source,
  };
}

/**
 * Sets the device default (`pathrule config set default-mode`, or `setup --scope device`): the
 * edition a folder with no edition of its own uses. Folders that have one keep it.
 */
export function writeDeviceDefault(
  env: NodeJS.ProcessEnv,
  mode: SetupMode,
  now: Date = new Date(),
): CapabilitySelection {
  return writeSelection(env, chooseMode(readSelection(env), mode, { source: "flag" }), now);
}

/** The selection an install from before onboarding maps to, or null for a new one. */
export async function mapExistingInstall(
  env: NodeJS.ProcessEnv,
): Promise<Omit<CapabilitySelection, "schema" | "updatedAt"> | null> {
  if (hasCliSession(env)) {
    return {
      capabilities: [...MODE_CAPABILITIES.cloud],
      setup: "cloud",
      source: "existing-install",
    };
  }
  return null;
}

/**
 * Whether the CLI has its own account session. Each Pathrule surface keeps its session under its
 * own key in `credentials.json`; the CLI's key ends in `::cli`. Another surface's session (Studio's,
 * VS Code's) is not a choice made for the CLI.
 */
export function hasCliSession(env: NodeJS.ProcessEnv): boolean {
  let bag: unknown;
  try {
    bag = JSON.parse(readFileSync(localRuntimePaths(env).credentialsFile, "utf8"));
  } catch {
    return false;
  }
  if (!bag || typeof bag !== "object") return false;
  return Object.entries(bag as Record<string, unknown>).some(
    ([key, value]) => key.endsWith("::cli") && value !== null && value !== "",
  );
}

function normalised(ids: readonly string[]): CapabilityId[] {
  return orderedCapabilities(ids);
}
