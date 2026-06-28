import type { Candidate } from "../retrieve/retrieve.js";
import type { ClauseCard } from "../schemas/clauseCard.js";
import type { RawGen } from "./types.js";

/**
 * Build a ClauseCard from a raw generation. Citations are derived from the model's chosen
 * candidate indices and the candidates' known-good spans, so every citation resolves by
 * construction. If the model refused, or no valid citation survives, return a refusal.
 */
export function toClauseCard(objective: string, raw: RawGen, candidates: Candidate[]): ClauseCard {
  if (raw.refused) {
    return { objective, answer: "", citations: [], refused: true, refusal_reason: raw.refusal_reason ?? "insufficient context" };
  }
  const seen = new Set<number>();
  const citations = [];
  for (const idx of raw.supporting) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length || seen.has(idx)) continue;
    seen.add(idx);
    const c = candidates[idx];
    citations.push({ doc_id: c.doc_id, char_start: c.char_start, char_end: c.char_end, quote: c.text });
  }
  if (citations.length === 0) {
    return { objective, answer: "", citations: [], refused: true, refusal_reason: "insufficient context" };
  }
  return { objective, answer: raw.answer, citations, refused: false, refusal_reason: null };
}
