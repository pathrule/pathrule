// SPDX-License-Identifier: Apache-2.0
// The data a setup brief is built from: what a repository's documentation, history and stack say,
// as findings and as candidate memories, rules and skills a person reviews. Pure shapes. The
// detectors that produce them are the engine's (`KnowledgeProducer`), and the brief that assembles
// them is the cloud's.

export interface BootstrapStackSignal {
  title: string;
  summary: string;
}

export interface BootstrapEvidence {
  kind: "doc" | "commit" | "stack" | "co_change";
  path?: string;
  heading?: string;
  commit?: string;
  excerpt: string;
}

export interface BootstrapCandidateContent {
  title: string;
  bodyGuidance: string;
  nodePath: string;
  confidence: number;
  evidence: BootstrapEvidence[];
}

export interface BootstrapCandidateSkill {
  name: string;
  description: string;
  bodyGuidance: string;
  nodePath: string;
  confidence: number;
  evidence: BootstrapEvidence[];
}

export interface BootstrapDocumentationFinding {
  path: string;
  heading?: string;
  kind: "architecture" | "workflow" | "testing" | "security" | "release" | "convention";
  summary: string;
  pathMentions: string[];
  commandMentions: string[];
  imperativeScore: number;
  excerpt: string;
}

export interface BootstrapCommitFinding {
  path: string;
  summary: string;
  fixCount: number;
  breakingCount: number;
  refactorCount: number;
  uniqueCommits: number;
  latestDate?: string;
  evidence: BootstrapEvidence[];
}

export interface DocumentationSynthesisResult {
  findings: BootstrapDocumentationFinding[];
  candidateMemories: BootstrapCandidateContent[];
  candidateRules: BootstrapCandidateContent[];
  docsFilesScanned: number;
  filesMentionedByDocs: number;
  warnings: string[];
}

export interface DocumentationSynthesisOptions {
  /**
   * Workspace-relative paths already taken into Pathrule verbatim by the
   * discovery importer (instruction files, `@import` targets, tool rules,
   * decision records).
   *
   * They must be skipped here or the same file is processed twice: measured on a
   * fixture, `docs/adr/001-db.md` produced the memories "ADR 001 / Decision /
   * Rationale" from the importer AND a "Rule: Rationale" candidate from this
   * synthesis, i.e. one rationale becoming two records. The existing guards do
   * not catch it: `filterExisting` compares TITLES (and the importer prefixes
   * its titles by origin), while `alreadyBootstrapped` only counts rows.
   */
  excludePaths?: readonly string[];
}

export interface CommitWisdomResult {
  findings: BootstrapCommitFinding[];
  commitsScanned: number;
}
