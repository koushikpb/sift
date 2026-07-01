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

/**
 * ContractNLI-hypothesis → playbook_id signatures. Deviated eval objectives are NLI hypotheses
 * tied to a playbook position; each entry fires when ALL its keywords appear in the objective.
 * This encodes the ContractNLI→NDA-playbook correspondence (a curated map, documented as such).
 */
const HYPOTHESIS_SIGNATURES: { keywords: string[]; playbook_id: string }[] = [
  { keywords: ["reverse engineer"], playbook_id: "exclusions" },
  { keywords: ["third-part"], playbook_id: "exclusions" },
  { keywords: ["destroy", "return"], playbook_id: "return_of_materials" },
  { keywords: ["shall not grant", "right"], playbook_id: "definition_scope" },
  { keywords: ["only include", "technical"], playbook_id: "definition_scope" },
];

/**
 * Resolve which playbook position an objective concerns (the review REQUEST, not the answer):
 *  1. explicit "(playbook requires <id>)" tag  (missing-clause items state it verbatim)
 *  2. a ContractNLI-hypothesis signature       (deviated items)
 *  3. fall back to clause_type / synonym match  (matchPlaybookEntry — CUAD-style objectives)
 * Returns null when nothing resolves. Selecting the position does NOT decide deviation/absence.
 */
export function playbookForObjective(objective: string, entries: PlaybookEntry[]): PlaybookEntry | null {
  const byId = (id: string) => entries.find((e) => e.playbook_id === id) ?? null;

  const tag = objective.match(/\(playbook requires ([a-z_]+)\)/i);
  if (tag) {
    const e = byId(tag[1].toLowerCase());
    if (e) return e;
  }

  const lc = objective.toLowerCase();
  for (const sig of HYPOTHESIS_SIGNATURES) {
    if (sig.keywords.every((k) => lc.includes(k))) {
      const e = byId(sig.playbook_id);
      if (e) return e;
    }
  }

  return matchPlaybookEntry(objective, entries);
}
