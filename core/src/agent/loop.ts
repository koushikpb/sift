import type { Candidate } from "../retrieve/types.js";
import type { JudgeVerdict } from "./judge.js";
import { judgeSufficiency } from "./judge.js";
import { denseRetrieve } from "../retrieve/dense.js";
import { lexicalRetrieve } from "../retrieve/lexical.js";
import { rrfFuse } from "../retrieve/rrf.js";
import { rerank as rerankDefault } from "../rerank/model.js";

export interface AgenticDeps {
  dense: (query: string, docId: string, n: number) => Promise<Candidate[]>;
  lexical: (query: string, docId: string, n: number) => Promise<Candidate[]>;
  rerank: (query: string, candidates: Candidate[], topK: number) => Promise<Candidate[]>;
  rrfFuse: (lists: Candidate[][], opts: { k: number }) => Candidate[];
  judge: (objective: string, candidates: Candidate[]) => Promise<JudgeVerdict>;
}

export const AGENT_DEFAULTS = { MAX_ROUNDS: 2, N: 50, M: 100, K_RRF: 60 };
export type AgenticConfig = typeof AGENT_DEFAULTS;

const defaultDeps: AgenticDeps = {
  dense: denseRetrieve,
  lexical: lexicalRetrieve,
  rerank: rerankDefault,
  rrfFuse,
  judge: judgeSufficiency,
};

/** rerank with degrade-to-fused-order on failure (mirrors hybridRetrieve). */
async function safeRerank(
  deps: AgenticDeps,
  query: string,
  pool: Candidate[],
  k: number,
): Promise<Candidate[]> {
  if (pool.length === 0) return [];
  try {
    return await deps.rerank(query, pool, k);
  } catch (e) {
    process.stderr.write(
      `agentic rerank failed, falling back to fused order: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return pool.slice(0, k);
  }
}

/**
 * Agentic doc-scoped retrieval: dense+lexical → RRF → rerank top-k → LLM sufficiency
 * judge → (if insufficient) one multi-query reformulation round, RRF-fused ONCE over all
 * rounds' raw lists and reranked against the ORIGINAL objective. Returns the final top-k
 * Candidate[] (unchanged shape). Degrades to the round-1 result when: MAX_ROUNDS <= 1, the
 * judge says sufficient, the judge throws, there are no reformulations, or a round adds no
 * new candidates. Real implementations are the default deps, so makeRetriever needs no wiring.
 */
export async function agenticRetrieve(
  query: string,
  docId: string,
  k = 8,
  deps: AgenticDeps = defaultDeps,
  cfg: AgenticConfig = AGENT_DEFAULTS,
): Promise<Candidate[]> {
  // Round 1: dense + lexical (parallel) → RRF → cap M → rerank top-k.
  const [d1, x1] = await Promise.all([
    deps.dense(query, docId, cfg.N),
    deps.lexical(query, docId, cfg.N),
  ]);
  const lists: Candidate[][] = [d1, x1];
  const round1Ids = new Set(lists.flat().map((c) => c.node_id));
  const top1 = await safeRerank(deps, query, deps.rrfFuse(lists, { k: cfg.K_RRF }).slice(0, cfg.M), k);

  if (cfg.MAX_ROUNDS <= 1) {
    process.stderr.write(`agentic doc=${docId} rounds=1 retried=false\n`);
    return top1;
  }

  // Sufficiency judge — a throwing judge degrades to "sufficient" (return round-1).
  let verdict: JudgeVerdict;
  try {
    verdict = await deps.judge(query, top1);
  } catch {
    process.stderr.write(`agentic doc=${docId} rounds=1 retried=false judge_error=true\n`);
    return top1;
  }

  if (verdict.sufficient || verdict.reformulations.length === 0) {
    process.stderr.write(
      `agentic doc=${docId} rounds=1 retried=false sufficient=${verdict.sufficient}\n`,
    );
    return top1;
  }

  // Round 2: retrieve each reformulation, accumulate raw lists.
  for (const q of verdict.reformulations) {
    const [d, x] = await Promise.all([
      deps.dense(q, docId, cfg.N),
      deps.lexical(q, docId, cfg.N),
    ]);
    lists.push(d, x);
  }

  // Convergence guard: if round 2 introduced no new node_id, the fusion equals round 1.
  const addedNew = lists.slice(2).flat().some((c) => !round1Ids.has(c.node_id));
  if (!addedNew) {
    process.stderr.write(`agentic doc=${docId} rounds=2 retried=true added_new=false\n`);
    return top1;
  }

  const fused = deps.rrfFuse(lists, { k: cfg.K_RRF }).slice(0, cfg.M);
  const top2 = await safeRerank(deps, query, fused, k);
  process.stderr.write(
    `agentic doc=${docId} rounds=2 retried=true added_new=true reformulations=${verdict.reformulations.length}\n`,
  );
  return top2;
}
