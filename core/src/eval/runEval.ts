/**
 * Eval runner: composes retrieve → generate → toClauseCard → metrics into a
 * scored EvalReport. All external dependencies (retrieve, generate, rawText)
 * are injected so the runner is unit-tested with fakes — no real DB or network.
 *
 * Per-item resilience: a thrown retrieve OR generate does not abort the run.
 * Retrieval metrics are computed before generate so they survive an LLM failure.
 * On error, the item is recorded with error set and whatever metrics were
 * computed before the throw; the run always continues to the next item.
 */

import { recallAtK, ndcgAtK, groundedness } from "./metrics.js";
import { toClauseCard } from "../generate/toClauseCard.js";
import type { Candidate } from "../retrieve/retrieve.js";
import type { GenInput, RawGen } from "../generate/types.js";
import type { EvalItem } from "./evalItem.js";

// ─── public interfaces ────────────────────────────────────────────────────────

export interface RunDeps {
  retrieve: (objective: string, docId: string, k: number) => Promise<Candidate[]>;
  generate: (input: GenInput) => Promise<RawGen>;
  rawText: (docId: string) => Promise<string | null>;
  /** Called once per item after it completes (including on error). done is 1-based. */
  onProgress?: (done: number, total: number, item: EvalItem) => void;
}

export interface ItemResult {
  id: string;
  category: string;
  grader: string;
  recall_at_k: number | null;
  ndcg_at_k: number | null;
  groundedness: number | null;
  refused: boolean;
  num_candidates: number;
  num_citations: number;
  /** Non-null when retrieve or generate threw; retains any metrics computed before the throw. */
  error: string | null;
}

export interface EvalReport {
  k: number;
  total: number;
  aggregates: {
    mean_recall_at_k: number | null;
    mean_ndcg_at_k: number | null;
    mean_groundedness: number | null;
    refusal_rate: number;
    /** Count of items where error !== null. */
    errored: number;
  };
  items: ItemResult[];
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Mean of an array that may contain nulls.
 * Excludes null values; returns null if there are no non-null values.
 */
function mean(values: (number | null)[]): number | null {
  const nonNull = values.filter((v): v is number => v !== null);
  if (nonNull.length === 0) return null;
  return nonNull.reduce((a, b) => a + b, 0) / nonNull.length;
}

// ─── runner ───────────────────────────────────────────────────────────────────

/**
 * Run an eval pass over `items` using the supplied dependencies.
 *
 * Items are processed sequentially (the DB-backed deps may not tolerate
 * concurrent requests; keeping it ordered also preserves reproducibility).
 *
 * A failed retrieve or generate does NOT abort the run — the item is recorded
 * with error set and any metrics computed before the failure are retained.
 *
 * @param items - Eval items to process.
 * @param deps  - Injected retrieve / generate / rawText / onProgress dependencies.
 * @param k     - Top-k cut-off for retrieval and metrics (default 8).
 */
export async function runEval(
  items: readonly EvalItem[],
  deps: RunDeps,
  k = 8,
): Promise<EvalReport> {
  const results: ItemResult[] = [];
  const total = items.length;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    // Per-item state — initialised before the try so catch can see what was set.
    let candidates: Candidate[] = [];
    let recall: number | null = null;
    let ndcg: number | null = null;
    let groundednessScore: number | null = null;
    let refused = false;
    let numCitations = 0;
    let error: string | null = null;

    try {
      // 1. Retrieve top-k candidates for this item's document.
      candidates = await deps.retrieve(item.objective, item.doc_id, k);

      // 2. Retrieval metrics (pure, synchronous) — computed BEFORE generate so
      //    they are retained even if the LLM call subsequently fails.
      recall = recallAtK(candidates, item.gold_spans, k);
      ndcg = ndcgAtK(candidates, item.gold_spans, k);

      // 3. Generate a raw answer.
      const raw = await deps.generate({ objective: item.objective, candidates });

      // 4. Convert to a citation-grounded ClauseCard.
      const card = toClauseCard(item.objective, raw, candidates);

      // 5. Groundedness — async bridge: pre-fetch raw text, then call the pure metric.
      refused = card.refused;

      if (!card.refused) {
        numCitations = card.citations.length;

        // Collect distinct doc_ids from this card's citations.
        const docIds = [...new Set(card.citations.map((c) => c.doc_id))];

        // Await each rawText call sequentially and cache into a Map so the pure
        // groundedness() resolver stays synchronous (its signature is unchanged).
        const rawTextMap = new Map<string, string | null>();
        for (const docId of docIds) {
          rawTextMap.set(docId, await deps.rawText(docId));
        }

        groundednessScore = groundedness(
          card.citations,
          (docId) => rawTextMap.get(docId) ?? null,
        );
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      // Retain whatever was already computed (recall/ndcg if retrieve succeeded).
      // refused stays false; numCitations stays 0; groundednessScore stays null.
    }

    results.push({
      id: item.id,
      category: item.category,
      grader: item.grader,
      recall_at_k: recall,
      ndcg_at_k: ndcg,
      groundedness: groundednessScore,
      refused,
      num_candidates: candidates.length,
      num_citations: numCitations,
      error,
    });

    // Progress: 1-based done count.
    deps.onProgress?.(i + 1, total, item);
  }

  // 6. Aggregate.
  const refusedCount = results.filter((r) => r.refused).length;
  const erroredCount = results.filter((r) => r.error !== null).length;

  return {
    k,
    total,
    aggregates: {
      mean_recall_at_k: mean(results.map((r) => r.recall_at_k)),
      mean_ndcg_at_k: mean(results.map((r) => r.ndcg_at_k)),
      mean_groundedness: mean(results.map((r) => r.groundedness)),
      refusal_rate: total === 0 ? 0 : refusedCount / total,
      errored: erroredCount,
    },
    items: results,
  };
}
