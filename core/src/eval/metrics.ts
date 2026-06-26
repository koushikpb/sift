/**
 * Pure retrieval + groundedness metrics. No I/O, no DB, no network.
 *
 * Global constraints honoured:
 *   [1] Citation grounding uses strict === (no trim/normalize).
 *   [5] Pure functions only.
 *   [6] null = not applicable (empty gold → recall/ndcg null; empty citations → groundedness null).
 *   [7] Span overlap is half-open and same-doc.
 */

/** A retrieved or gold span, identified by doc and character offsets (half-open). */
export interface RankedSpan {
  doc_id: string;
  char_start: number;
  char_end: number;
}

/** A model-produced citation that may or may not be grounded in source text. */
export interface Citation {
  doc_id: string;
  char_start: number;
  char_end: number;
  quote: string;
}

/**
 * Returns true iff the two spans are in the same document and their half-open
 * character ranges overlap. Touching ranges ([0,5) and [5,10)) do NOT overlap.
 *
 * Constraint 7: a.doc_id === b.doc_id && a.char_start < b.char_end && b.char_start < a.char_end
 */
export function overlaps(a: RankedSpan, b: RankedSpan): boolean {
  return (
    a.doc_id === b.doc_id &&
    a.char_start < b.char_end &&
    b.char_start < a.char_end
  );
}

/**
 * Recall@k: fraction of gold spans covered by at least one span in the top-k
 * retrieved candidates (coverage = overlaps).
 *
 * Returns null when gold is empty (metric not applicable).
 */
export function recallAtK(
  retrieved: readonly RankedSpan[],
  gold: readonly RankedSpan[],
  k: number,
): number | null {
  if (gold.length === 0) return null;

  const topK = retrieved.slice(0, k);
  let covered = 0;
  for (const g of gold) {
    if (topK.some((r) => overlaps(r, g))) {
      covered++;
    }
  }
  return covered / gold.length;
}

/**
 * NDCG@k: binary-relevance Normalized Discounted Cumulative Gain.
 *
 * rel_i = 1 if candidate at 1-indexed rank i overlaps any gold span, else 0.
 * DCG  = Σ_{i=1..k} rel_i / log2(i + 1)
 * IDCG = Σ_{i=1..numRel} 1 / log2(i + 1)   (ideal: all relevant ranked first)
 * NDCG = DCG / IDCG
 *
 * Returns null when gold is empty (metric not applicable).
 * Returns 0 when gold is non-empty but no top-k candidate overlaps any gold span
 * (total retrieval miss — a real score, not "not applicable").
 */
export function ndcgAtK(
  retrieved: readonly RankedSpan[],
  gold: readonly RankedSpan[],
  k: number,
): number | null {
  if (gold.length === 0) return null;

  const topK = retrieved.slice(0, k);

  let dcg = 0;
  let numRel = 0;
  for (let i = 0; i < topK.length; i++) {
    const rel = gold.some((g) => overlaps(topK[i], g)) ? 1 : 0;
    if (rel === 1) {
      dcg += 1 / Math.log2(i + 2); // i is 0-indexed; rank = i+1; denominator = log2(rank+1) = log2(i+2)
      numRel++;
    }
  }

  if (numRel === 0) return 0;

  let idcg = 0;
  for (let i = 0; i < numRel; i++) {
    idcg += 1 / Math.log2(i + 2);
  }

  return dcg / idcg;
}

/**
 * Groundedness: fraction of citations that are grounded in source text.
 *
 * A citation is grounded iff rawText(doc_id) is non-null AND
 * quote === text.slice(char_start, char_end)  (strict ===, Constraint 1).
 * An unknown doc (rawText returns null) counts as not grounded but still
 * contributes to the denominator.
 *
 * Returns null when citations is empty (metric not applicable).
 */
export function groundedness(
  citations: readonly Citation[],
  rawText: (docId: string) => string | null,
): number | null {
  if (citations.length === 0) return null;

  let grounded = 0;
  for (const c of citations) {
    const text = rawText(c.doc_id);
    if (text !== null && c.quote === text.slice(c.char_start, c.char_end)) {
      grounded++;
    }
  }
  return grounded / citations.length;
}
