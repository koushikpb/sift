import type { Candidate } from "./types.js";

/**
 * Reciprocal Rank Fusion. Each candidate's fused score is the sum, over the input
 * lists, of 1/(k + rank) with rank the 1-based position in that list. Deduped by
 * node_id (first occurrence's fields kept); returns candidates sorted by fused score
 * descending, each with `score` overwritten by its fused value.
 */
export function rrfFuse(lists: Candidate[][], opts: { k: number }): Candidate[] {
  const { k } = opts;
  const fused = new Map<string, number>();
  const byId = new Map<string, Candidate>();
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      fused.set(c.node_id, (fused.get(c.node_id) ?? 0) + 1 / (k + i + 1));
      if (!byId.has(c.node_id)) byId.set(c.node_id, c);
    }
  }
  return [...byId.values()]
    .map((c) => ({ ...c, score: fused.get(c.node_id)! }))
    .sort((a, b) => b.score - a.score);
}
