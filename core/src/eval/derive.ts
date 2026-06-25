import type { GoldLabel } from "../schemas/goldLabel.js";
import { EvalItemSchema, type EvalItem } from "./evalItem.js";

/** Best-effort map from CUAD clause-type strings to NDA playbook ids. */
export const CLAUSE_TYPE_TO_PLAYBOOK: Record<string, string> = {
  "Governing Law": "governing_law",
  "Expiration Date": "confidentiality_term",
  "Post-Termination Services": "return_of_materials",
};

const SEVERITY_DEFAULT = "medium" as const;

export function deriveCandidates(golds: GoldLabel[], playbookIds: Set<string>): EvalItem[] {
  const items: EvalItem[] = [];
  golds.forEach((g, i) => {
    const gold_spans = g.spans.map((s) => ({
      doc_id: g.doc_id, char_start: s.char_start, char_end: s.char_end, quote: s.quote,
    }));

    if (g.kind === "clause_span") {
      const pid = g.clause_type ? CLAUSE_TYPE_TO_PLAYBOOK[g.clause_type] : undefined;
      const expected_flags = pid && playbookIds.has(pid)
        ? [{ playbook_id: pid, severity: SEVERITY_DEFAULT }]
        : [];
      items.push(EvalItemSchema.parse({
        id: `cand_${i}_${g.label_id}`,
        doc_id: g.doc_id, source: g.source, contract_type: "unknown",
        category: "clean",
        objective: `Locate and extract the "${g.clause_type ?? "clause"}" clause.`,
        expected_fields: [{ name: g.clause_type ?? "clause", value: null }],
        expected_flags,
        gold_spans,
        grader: "span_match",
        notes: "auto-derived from CUAD; curate before inclusion in v1",
      }));
      return;
    }

    // NLI label -> risk-flag item. Contradiction/entailment of a risky hypothesis => deviated.
    items.push(EvalItemSchema.parse({
      id: `cand_${i}_${g.label_id}`,
      doc_id: g.doc_id, source: g.source, contract_type: "nda",
      category: g.nli_label === "not_mentioned" ? "missing" : "deviated",
      objective: `Assess the hypothesis: ${g.hypothesis ?? "(none)"}`,
      expected_fields: [],
      expected_flags: [],
      gold_spans,
      grader: "flag_match",
      notes: `auto-derived from ContractNLI (${g.nli_label}); curate before inclusion in v1`,
    }));
  });
  return items;
}
