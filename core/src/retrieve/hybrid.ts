import type { Candidate } from "./types.js";
import { denseRetrieve } from "./dense.js";
import { lexicalRetrieve } from "./lexical.js";
import { rrfFuse } from "./rrf.js";
import { rerank as rerankDefault } from "../rerank/model.js";

export interface HybridDeps {
  dense: (query: string, docId: string, n: number) => Promise<Candidate[]>;
  lexical: (query: string, docId: string, n: number) => Promise<Candidate[]>;
  rerank: (query: string, candidates: Candidate[], topK: number) => Promise<Candidate[]>;
}

export const HYBRID_DEFAULTS = { N_DENSE: 50, N_LEX: 50, M: 100, K_RRF: 60 };

const defaultDeps: HybridDeps = {
  dense: denseRetrieve,
  lexical: lexicalRetrieve,
  rerank: rerankDefault,
};

/**
 * Hybrid doc-scoped retrieval: dense + lexical (parallel) → RRF fuse → cap at M →
 * cross-encoder rerank → top-k. If rerank throws (e.g. model load failure), falls back
 * to the fused order so a query never hard-fails.
 */
export async function hybridRetrieve(
  query: string,
  docId: string,
  k = 8,
  deps: HybridDeps = defaultDeps,
  cfg = HYBRID_DEFAULTS,
): Promise<Candidate[]> {
  const [dense, lexical] = await Promise.all([
    deps.dense(query, docId, cfg.N_DENSE),
    deps.lexical(query, docId, cfg.N_LEX),
  ]);
  const fused = rrfFuse([dense, lexical], { k: cfg.K_RRF }).slice(0, cfg.M);
  if (fused.length === 0) return [];
  try {
    return await deps.rerank(query, fused, k);
  } catch (e) {
    process.stderr.write(
      `rerank failed, falling back to fused order: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return fused.slice(0, k);
  }
}
