import type { PlaybookEntry } from "../../eval/playbook.js";

/**
 * CUAD clause labels (classifier output) → playbook_id, for labels whose wording differs from the
 * playbook's `clause_type`. Direct case-insensitive `clause_type` matches need no entry here.
 * Kept explicit (not fuzzy) so the risk-engine's coverage is auditable — a miss is a real, visible
 * false negative, not a silent fuzzy failure.
 */
export const PLAYBOOK_CLAUSE_SYNONYMS: Record<string, string> = {
  "governing law": "governing_law",
  "confidentiality": "definition_scope",
  "confidential information": "definition_scope",
  "term": "confidentiality_term",
  "expiration date": "confidentiality_term",
  "return of confidential information": "return_of_materials",
  "injunctive relief": "remedies",
};

/** Resolve a clause type to a playbook position, or null if none applies. */
export function matchPlaybookEntry(clauseType: string, entries: PlaybookEntry[]): PlaybookEntry | null {
  const key = clauseType.trim().toLowerCase();
  const direct = entries.find((e) => e.clause_type.trim().toLowerCase() === key);
  if (direct) return direct;
  const viaSynonym = PLAYBOOK_CLAUSE_SYNONYMS[key];
  if (viaSynonym) return entries.find((e) => e.playbook_id === viaSynonym) ?? null;
  return null;
}
