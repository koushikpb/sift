import { describe, it, expect } from "vitest";
import { deriveCandidates, CLAUSE_TYPE_TO_PLAYBOOK } from "../src/eval/derive.js";
import type { GoldLabel } from "../src/schemas/goldLabel.js";

const cuadGold: GoldLabel = {
  label_id: "cuad_x::clause::governing-law::0", doc_id: "cuad_x", source: "cuad",
  kind: "clause_span", clause_type: "Governing Law", hypothesis: null, nli_label: null,
  spans: [{ char_start: 10, char_end: 27, quote: "State of Delaware" }],
};
const nliGold: GoldLabel = {
  label_id: "contractnli_y::nli::nda-11", doc_id: "contractnli_y", source: "contractnli",
  kind: "nli", clause_type: null,
  hypothesis: "Confidentiality survives in perpetuity.", nli_label: "entailment",
  spans: [{ char_start: 0, char_end: 20, quote: "Term is perpetual..." }],
};

describe("deriveCandidates", () => {
  it("turns a CUAD clause span into a span_match item carrying its gold span", () => {
    const items = deriveCandidates([cuadGold], new Set(Object.values(CLAUSE_TYPE_TO_PLAYBOOK)));
    expect(items).toHaveLength(1);
    const it0 = items[0];
    expect(it0.grader).toBe("span_match");
    expect(it0.source).toBe("cuad");
    expect(it0.gold_spans[0].quote).toBe("State of Delaware");
    // Governing Law maps to the governing_law playbook id.
    expect(it0.expected_flags.map((f) => f.playbook_id)).toContain("governing_law");
  });

  it("turns an NLI entailment into a flag_match item", () => {
    const items = deriveCandidates([nliGold], new Set());
    expect(items).toHaveLength(1);
    expect(items[0].grader).toBe("flag_match");
    expect(items[0].source).toBe("contractnli");
    expect(items[0].objective).toContain("perpetuity");
  });

  it("emits unique, schema-valid ids", () => {
    const items = deriveCandidates([cuadGold, nliGold], new Set());
    const ids = new Set(items.map((i) => i.id));
    expect(ids.size).toBe(items.length);
  });
});
