// SPDX-License-Identifier: Apache-2.0

import type { ProjectMapContext, ProjectMapSnapshot } from "@pathrule/protocol/project-learning-types.js";

const INSTRUCTION =
  "This is a bounded structural map of source paths and manifest declarations, not verified runtime behavior, team policy or full architectural understanding. Git digests describe index entries; sha256 digests describe locally read bytes. Inspect cited source before changing behavior. Dependencies are declarations, not proof that code calls them; same-name workspace modules are resolution candidates. Missing or partial coverage is unknown, never evidence of absence. When your current task reveals a durable architectural finding, use pathrule_record_learning with a concise synthesis and the hashes of sources you actually read. For review history relevant to the task, use pathrule_review_history; it reads merged PR evidence without model inference. Review targets are retained source-change leads, not learned coverage or an instruction to scan everything. Prioritize task-relevant targets and withheld claims; reuse verified findings. Truncated targets mean incomplete review coverage. Do not start a separate model job or copy raw code into learning.";
const under = (path: string, scope: string): boolean =>
  !scope || path === scope || path.startsWith(scope + "/");

export function projectMapContext(
  snapshot: ProjectMapSnapshot | undefined,
  scope = "/",
  persisted = false,
  verifiedSources: Array<{ path: string; digest: string }> = [],
): ProjectMapContext {
  if (!snapshot)
    return {
      status: "unavailable",
      persisted,
      modules: [],
      sourceExamples: [],
      instruction: INSTRUCTION,
    };
  const scoped = scope.replace(/^\/+|\/+$/g, "");
  const verified = new Set(verifiedSources.map((source) => `${source.path}:${source.digest}`));
  const reviewTargets = (snapshot.reviewTargets ?? []).filter(
    (target) => under(target.path, scoped) && !verified.has(`${target.path}:${target.digest}`),
  );
  const manifests = snapshot.files.filter(
    (file) => file.kind === "manifest" && file.facts && file.digest,
  );
  const pathFor = (path: string): string =>
    path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const owners = manifests
    .map((file) => ({ file, directory: pathFor(file.path) }))
    .sort((a, b) => b.directory.length - a.directory.length);
  const ownerByDirectory = new Map<string, string>();
  for (const owner of owners) {
    if (!ownerByDirectory.has(owner.directory))
      ownerByDirectory.set(owner.directory, owner.file.path);
  }
  const ownerFor = (source: string): string | undefined => {
    let directory = pathFor(source);
    for (;;) {
      const found = ownerByDirectory.get(directory);
      if (found || !directory) return found;
      directory = pathFor(directory);
    }
  };
  const relevant = owners.filter(
    (owner) => under(scoped, owner.directory) || under(owner.directory, scoped),
  );
  // Most specific module first, then its local dependency declarations.
  relevant.sort(
    (a, b) =>
      Number(under(scoped, b.directory)) - Number(under(scoped, a.directory)) ||
      (scoped
        ? b.directory.length - a.directory.length
        : a.directory.length - b.directory.length) ||
      a.directory.localeCompare(b.directory),
  );
  const names = new Map<string, typeof owners>();
  for (const owner of owners) {
    const facts = owner.file.facts!;
    if (!facts.name) continue;
    const key = `${facts.ecosystem}:${facts.name}`;
    names.set(key, [...(names.get(key) ?? []), owner]);
  }
  const resolveDependency = (ecosystem: string, name: string): string | undefined => {
    const found = names.get(`${ecosystem}:${name}`);
    return found?.length === 1 ? "/" + found[0]!.directory : undefined;
  };
  const selected = relevant.slice(0, 4);
  const modules = selected.map(({ file, directory }) => {
    const facts = file.facts!;
    return {
      path: "/" + directory,
      name: facts.name,
      ecosystem: facts.ecosystem,
      evidence: { path: file.path, digest: file.digest! },
      dependencies: facts.dependencies
        .slice(0, 12)
        .map((dep) => ({ ...dep, sameNameModule: resolveDependency(facts.ecosystem, dep.name) })),
      taskNames: facts.taskNames.slice(0, 8),
      sourceExamples: snapshot.files
        .filter(
          (source) =>
            source.kind === "source" &&
            under(source.path, directory) &&
            ownerFor(source.path) === file.path,
        )
        .slice(0, 4)
        .map((source) => source.path),
    };
  });
  const context: ProjectMapContext = {
    status:
      snapshot.consistency === "stable" &&
      snapshot.coverage.inventoryComplete &&
      snapshot.coverage.unavailableFiles === 0
        ? "current"
        : "partial",
    phase: snapshot.phase,
    head: snapshot.head,
    observedAt: snapshot.observedAt,
    coverage: snapshot.coverage,
    changes: snapshot.changes,
    reviewTargets: reviewTargets.slice(0, 8),
    reviewTargetsTruncated: snapshot.reviewTargetsTruncated === true || reviewTargets.length > 8,
    persisted,
    modules,
    sourceExamples: snapshot.files
      .filter((file) => file.kind === "source" && under(file.path, scoped))
      .slice(0, 6)
      .map((file) => file.path),
    instruction: INSTRUCTION,
    omittedModules: Math.max(0, relevant.length - modules.length),
  };
  // Preserve whole facts and valid JSON under a hard prompt budget, never cut a path.
  while (JSON.stringify(context).length > 6000) {
    if (context.reviewTargets && JSON.stringify(context.reviewTargets).length > 1800) {
      context.reviewTargets.pop();
      context.reviewTargetsTruncated = true;
    } else if (context.sourceExamples.length) context.sourceExamples.pop();
    else if (context.modules.some((module) => module.sourceExamples.length))
      context.modules.find((module) => module.sourceExamples.length)!.sourceExamples.pop();
    else if (context.modules.some((module) => module.dependencies.length))
      context.modules.find((module) => module.dependencies.length)!.dependencies.pop();
    else if (context.modules.length) {
      context.modules.pop();
      context.omittedModules!++;
    } else if (context.reviewTargets?.length) {
      context.reviewTargets.pop();
      context.reviewTargetsTruncated = true;
    } else break;
  }
  return context;
}
