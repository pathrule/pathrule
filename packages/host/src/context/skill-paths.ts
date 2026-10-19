// SPDX-License-Identifier: Apache-2.0
// Where an invoked skill's sub-skills sit on disk. An invoked skill may route to more specific
// `::name` sub-flows; the turn names their materialized SKILL.md paths so the agent reads them with
// its own file tools instead of a Pathrule read. A sub-skill already injected, or whose name
// matches no skill or more than one, is left out.
//
// Moved unchanged from Studio's turn context.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { InvocationSkill, KnowledgeBackend } from "@pathrule/core";
import { AGENT_TARGETS } from "@pathrule/core/skills/agent-targets.js";
import type { InvokedSkillContext } from "@pathrule/core/tools/tree.js";
import { slugifySkillName } from "@pathrule/integrations/skills/slug.js";
import {
  extractSkillInvocationMarkers,
  normalizeSkillInvocationName,
} from "@pathrule/protocol/skill-invocation.js";

/** A sub-skill an invoked skill names, and where its SKILL.md sits on disk. */
export interface ReferencedSkillReadPath {
  id: string;
  name: string;
  paths: string[];
}

const MATERIALIZED_SKILL_MANIFEST = ".pathrule-skills-manifest.json";

interface MaterializedManifestEntry {
  slug?: unknown;
  files?: unknown;
}

interface MaterializedManifest {
  skills?: Record<string, MaterializedManifestEntry>;
}

const MATERIALIZED_SKILL_TARGETS = Object.values(AGENT_TARGETS).filter((spec) => spec.supported);

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

async function readManifestSlugs(
  workspaceRoot: string,
): Promise<Map<string, Array<{ skillsDir: string; slug: string }>>> {
  const out = new Map<string, Array<{ skillsDir: string; slug: string }>>();
  await Promise.all(
    MATERIALIZED_SKILL_TARGETS.map(async (target) => {
      const manifestDir = target.skillsDir.replace(/\/skills$/, "");
      try {
        const raw = await readFile(
          join(workspaceRoot, manifestDir, MATERIALIZED_SKILL_MANIFEST),
          "utf8",
        );
        const parsed = JSON.parse(raw) as MaterializedManifest;
        for (const [skillId, entry] of Object.entries(parsed.skills ?? {})) {
          if (typeof entry.slug !== "string" || !entry.slug) continue;
          const list = out.get(skillId) ?? [];
          list.push({ skillsDir: target.skillsDir, slug: entry.slug });
          out.set(skillId, list);
        }
      } catch {
        // Missing/stale manifests are expected on targets the user has not enabled.
      }
    }),
  );
  return out;
}

function skillReadPaths(
  skill: InvocationSkill,
  manifestSlugs: Map<string, Array<{ skillsDir: string; slug: string }>>,
): string[] {
  const fromManifest = manifestSlugs.get(skill.id) ?? [];
  if (fromManifest.length > 0) {
    return fromManifest.map((entry) =>
      normalizeRelativePath(`${entry.skillsDir}/${entry.slug}/SKILL.md`),
    );
  }
  const slug = slugifySkillName(skill.name);
  return MATERIALIZED_SKILL_TARGETS.map((target) =>
    normalizeRelativePath(`${target.skillsDir}/${slug}/SKILL.md`),
  );
}

export async function referencedSkillReadPaths(
  backend: KnowledgeBackend,
  workspaceId: string,
  workspaceRoot: string,
  invoked: InvokedSkillContext[],
): Promise<ReferencedSkillReadPath[]> {
  const referenced = extractSkillInvocationMarkers(invoked.map((s) => s.content).join("\n"));
  if (referenced.length === 0) return [];

  const alreadyInjected = new Set(invoked.map((s) => normalizeSkillInvocationName(s.name)));
  const wanted = referenced
    .map((marker) => marker.name)
    .filter((name) => !alreadyInjected.has(name));
  if (wanted.length === 0) return [];

  const allSkills = await backend.listSkillsForInvocation(workspaceId);
  const byName = new Map<string, InvocationSkill[]>();
  for (const skill of allSkills) {
    const key = normalizeSkillInvocationName(skill.name);
    byName.set(key, [...(byName.get(key) ?? []), skill]);
  }

  const manifestSlugs = await readManifestSlugs(workspaceRoot);
  const out: ReferencedSkillReadPath[] = [];
  const seen = new Set<string>();
  for (const name of wanted) {
    if (seen.has(name)) continue;
    seen.add(name);
    const matches = byName.get(name) ?? [];
    if (matches.length !== 1) continue;
    const skill = matches[0]!;
    out.push({
      id: skill.id,
      name: skill.name,
      paths: skillReadPaths(skill, manifestSlugs),
    });
  }
  return out;
}
