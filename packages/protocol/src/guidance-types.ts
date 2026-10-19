// SPDX-License-Identifier: Apache-2.0
/**
 * The shapes of the oversight map and expertise leases that cross a process boundary: into the hook
 * index, over IPC to Settings, into the chat renderer. Types only, so the renderer can import them
 * without pulling in the Node-side stores.
 */
/** A security-sensitive area of code (the risk gate's domains). */
export type RiskDomain = "auth" | "crypto" | "payments" | "data" | "security";

export type OversightLevel = "unknown" | "reviewed" | "unreviewed";

/** One domain as the inspect surface shows it. */
export interface OversightSummary {
  domain: RiskDomain;
  level: OversightLevel;
  episodes: number;
  reviewed: number;
}

/** A pre-rendered hook index line under its own heading. */
export interface GuidanceEntry {
  id: string;
  heading: string;
  line: string;
  /** Folded terms; one hit (exact under five letters, prefix from five) makes the entry relevant. */
  terms: string[];
}

export interface ExpertiseLease {
  id: string;
  workspace_id: string;
  /** The workspace folder's name, for the inspect surface only. */
  workspace_label: string | null;
  /** The canonical root it was verified in, so the inspect surface can re-read the installed version. */
  workspace_root: string | null;
  library: string;
  /** The installed version when the lease was taken, and the major.minor it is bound to. */
  version: string;
  version_key: string;
  sources: string[];
  facts: string[];
  replaces: Array<{ habit: string; now: string }>;
  checks: string[];
  thread_id: string | null;
  created_at: string;
  expires_at: string;
}

export interface LeaseRequest {
  workspace_id: string;
  library: string;
  version_key: string;
  at: string;
}

/** A lease as the inspect surface shows it. */
export type LeaseSummary = Omit<ExpertiseLease, "thread_id"> & { current: boolean };

