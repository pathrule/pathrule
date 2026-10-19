// SPDX-License-Identifier: Apache-2.0
//
// Deterministic Louvain (plan D3). The same nodes and edges give the same communities
// in every process: nodes and edges are inserted in sorted order, Louvain runs once per
// fixed seed with a seeded RNG, and the highest modularity wins (ties go to the earlier
// seed). The first prototype ran one seed over Python set order and its sub-regions changed
// from run to run (plan correction 6).

import graphologyExport from "graphology";
import louvainExport from "graphology-communities-louvain";
import type { UndirectedGraph } from "graphology";
import type { DetailedLouvainOutput, LouvainOptions } from "graphology-communities-louvain";

// Both packages ship CommonJS (`module.exports = Graph`, `module.exports = louvain`), so Node ESM,
// esbuild and Vite all hand the default import the export itself. Only the TYPE differs: under NodeNext
// (the CLI, which compiles the MCP server) TypeScript types a CommonJS default import as the module
// namespace. Stating each export's type once keeps both resolutions honest.
const Graph = graphologyExport as unknown as new (options: { type: "undirected"; multi: boolean }) => UndirectedGraph;
const louvain = louvainExport as unknown as { detailed(graph: UndirectedGraph, options: LouvainOptions): DetailedLouvainOutput };

export interface WeightedEdge {
  a: string;
  b: string;
  weight: number;
}

export const PARTITION_SEEDS = [1, 2, 3, 4, 5] as const;

/** mulberry32: a small seeded RNG, so a run never depends on Math.random. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function connectedComponents(graph: UndirectedGraph, nodes: readonly string[]): Record<string, number> {
  const labels: Record<string, number> = {};
  let next = 0;
  for (const start of nodes) {
    if (labels[start] !== undefined) continue;
    const stack = [start];
    labels[start] = next;
    while (stack.length > 0) {
      const id = stack.pop()!;
      for (const other of graph.neighbors(id).sort(byId)) {
        if (labels[other] === undefined) {
          labels[other] = next;
          stack.push(other);
        }
      }
    }
    next++;
  }
  return labels;
}

export interface PartitionResult {
  /** Communities, largest first, members sorted; ties by first member. */
  communities: string[][];
  modularity: number;
}

export function partition(
  nodeIds: readonly string[],
  edges: readonly WeightedEdge[],
  resolution = 1.0,
  /** The seeds tried; the best modularity wins. The benchmark passes one to measure stability. */
  seeds: readonly number[] = PARTITION_SEEDS,
): PartitionResult {
  const nodes = [...new Set(nodeIds)].sort(byId);
  const graph = new Graph({ type: "undirected", multi: false });
  for (const id of nodes) graph.addNode(id);
  const sorted = edges
    .filter((edge) => edge.a !== edge.b && edge.weight > 0)
    .map((edge) => (edge.a < edge.b ? edge : { a: edge.b, b: edge.a, weight: edge.weight }))
    .sort((x, y) => byId(x.a, y.a) || byId(x.b, y.b));
  for (const edge of sorted) {
    if (!graph.hasNode(edge.a) || !graph.hasNode(edge.b)) continue;
    if (graph.hasEdge(edge.a, edge.b)) {
      graph.updateEdgeAttribute(edge.a, edge.b, "weight", (w: number | undefined) => (w ?? 0) + edge.weight);
    } else {
      graph.addEdge(edge.a, edge.b, { weight: edge.weight });
    }
  }
  // Louvain is undefined without edges (modularity divides by the total weight).
  if (graph.size === 0) {
    return { communities: nodes.map((id) => [id]), modularity: 0 };
  }

  let best: { communities: Record<string, number>; modularity: number } | null = null;
  for (const seed of seeds) {
    const run = louvain.detailed(graph, { resolution, getEdgeWeight: "weight", rng: seededRandom(seed) });
    if (!best || run.modularity > best.modularity + 1e-12) best = { communities: run.communities, modularity: run.modularity };
  }

  // A graph with no community structure (one dense topic, as in a small workspace) has
  // modularity <= 0 for every split, and Louvain then stops at arbitrary pairs. Its
  // connected components are the honest answer.
  const labels: Record<string, number> = best!.modularity > 1e-9 ? best!.communities : connectedComponents(graph, nodes);
  const groups = new Map<number, string[]>();
  for (const id of nodes) {
    const community = labels[id]!;
    const list = groups.get(community);
    if (list) list.push(id);
    else groups.set(community, [id]);
  }
  const communities = [...groups.values()]
    .map((members) => members.sort(byId))
    .sort((x, y) => y.length - x.length || byId(x[0]!, y[0]!));
  return { communities, modularity: best!.modularity };
}
