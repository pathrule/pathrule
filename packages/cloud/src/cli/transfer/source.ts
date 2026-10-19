// SPDX-License-Identifier: Apache-2.0
// What a copy of a folder's Local knowledge to Pathrule Cloud reads: the memories, rules and skills of
// the folder's Pathrule Local workspace, left dormant when the folder switched to Cloud. Read through
// the home's Pathrule host, the stores' one owner, as every open command reads a Local store, and only
// with read methods: nothing here writes the store.
import { withCliHostSession } from "@pathrule/cli/local/host-session.js";
import type { HookIndex } from "@pathrule/protocol/hook-index.js";
import type { NodeType, TreeNode } from "@pathrule/protocol/node-types.js";
import type {
  MemorySource,
  RulePriority,
  RuleScope,
  SkillSource,
} from "@pathrule/protocol/content-types.js";
import type { RuleAtom } from "@pathrule/protocol/rule-atoms.js";

export type TransferKind = "memory" | "rule" | "skill";

interface LocalItemBase {
  kind: TransferKind;
  localId: string;
  /** A memory's title, a rule's or a skill's name. */
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  /** The node path the item is attached at; null when Local attached it nowhere. */
  path: string | null;
  nodeType: NodeType | null;
  /**
   * Further Local paths a rule or a skill is attached at. A Cloud item made by this copy is attached
   * at one, so the preview names what it leaves out.
   */
  extraPaths: string[];
}

export interface LocalMemoryItem extends LocalItemBase {
  kind: "memory";
  source: MemorySource;
  relatedPaths: string[];
}

export interface LocalRuleItem extends LocalItemBase {
  kind: "rule";
  scopeType: RuleScope;
  priority: RulePriority;
  constraints: RuleAtom[];
}

export interface LocalSkillItem extends LocalItemBase {
  kind: "skill";
  description: string | null;
  source: SkillSource;
  githubUrl: string | null;
  tags: string[];
  version: string;
}

export type LocalTransferItem = LocalMemoryItem | LocalRuleItem | LocalSkillItem;

export interface LocalTransferSource {
  workspaceId: string;
  root: string;
  name: string | null;
  items: LocalTransferItem[];
}

/** Every Local path an item of `placements` is placed at, by item id, from the hook index. */
function placementsBy(
  placements: Record<string, ReadonlyArray<{ id: string }>> | undefined,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [path, stubs] of Object.entries(placements ?? {}))
    for (const stub of stubs) {
      const paths = out.get(stub.id) ?? new Set<string>();
      paths.add(path);
      out.set(stub.id, paths);
    }
  return out;
}

const sorted = (paths: Iterable<string>): string[] => [...paths].sort();

/**
 * The Local workspace `workspaceId`'s active memories, rules and skills, oldest first by kind.
 *
 * Local's read methods carry a memory's node but not its related paths, and a rule's or a skill's
 * first attachment but not the others. The hook index the store builds places a memory under its
 * owner and each related path, and a rule or a skill under every attachment, so those come from it.
 */
export function readLocalKnowledge(
  env: NodeJS.ProcessEnv,
  local: { workspaceId: string; localRootPath: string },
): Promise<LocalTransferSource> {
  const ws = local.workspaceId;
  return withCliHostSession(env, async (session) => {
    const store = await session.store(ws);
    const tree: TreeNode[] = await store.getTree(ws);
    const nodes = new Map(tree.map((n) => [n.id, n]));
    const index: HookIndex | null = await store.buildHookIndexPayload(ws);
    const memoryPaths = placementsBy(index?.path_memories);
    const rulePaths = placementsBy(index?.path_rules);
    const skillPaths = placementsBy(index?.path_skills);
    const items: LocalTransferItem[] = [];

    for (const m of await store.listMemories({ workspaceId: ws })) {
      const node = m.nodeId ? (nodes.get(m.nodeId) ?? null) : null;
      const path = node?.relativePath ?? null;
      const related = [...(memoryPaths.get(m.id) ?? [])].filter((p) => p !== path);
      items.push({
        kind: "memory",
        localId: m.id,
        title: m.title,
        content: m.content,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        path,
        nodeType: node?.type ?? null,
        extraPaths: [],
        source: m.source,
        relatedPaths: sorted(related),
      });
    }
    for (const r of await store.listRules({ workspaceId: ws })) {
      const node = await store.getNodeForRule(r.id);
      const path = node?.relativePath ?? null;
      items.push({
        kind: "rule",
        localId: r.id,
        title: r.name,
        content: r.content,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        path,
        nodeType: node?.type ?? null,
        extraPaths: sorted([...(rulePaths.get(r.id) ?? [])].filter((p) => p !== path)),
        scopeType: r.scopeType,
        priority: r.priority,
        constraints: r.constraints ?? [],
      });
    }
    for (const s of await store.listSkills({ workspaceId: ws })) {
      const node = await store.getNodeForSkill(s.id);
      const path = node?.relativePath ?? null;
      // The index places a skill attached nowhere at the root; that is not a second attachment.
      const extra = [...(skillPaths.get(s.id) ?? [])].filter(
        (p) => p !== path && !(path === null && p === "/"),
      );
      items.push({
        kind: "skill",
        localId: s.id,
        title: s.name,
        content: s.content,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        path,
        nodeType: node?.type ?? null,
        extraPaths: sorted(extra),
        description: s.description,
        source: s.source,
        githubUrl: s.githubUrl,
        tags: s.tags,
        version: s.version,
      });
    }
    const order: Record<TransferKind, number> = { memory: 0, rule: 1, skill: 2 };
    items.sort(
      (a, b) =>
        order[a.kind] - order[b.kind] ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.localId.localeCompare(b.localId),
    );
    return {
      workspaceId: ws,
      root: local.localRootPath,
      name: (await store.getWorkspaceName(ws)) ?? null,
      items,
    };
  });
}
