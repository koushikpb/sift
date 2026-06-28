import { describe, it, expect } from "vitest";
import { compareReports, falseNegativeRate } from "../src/eval/compare.js";
import type { EvalReport, ItemResult } from "../src/eval/runEval.js";

function item(p: Partial<ItemResult>): ItemResult {
  return { id: "x", category: "clean", grader: "span_match", recall_at_k: 1, ndcg_at_k: 1, groundedness: 1, refused: false, num_candidates: 8, num_citations: 1, error: null, ...p };
}
function report(items: ItemResult[], agg: Partial<EvalReport["aggregates"]>): EvalReport {
  return { k: 8, total: items.length, items, aggregates: { mean_recall_at_k: 0, mean_ndcg_at_k: 0, mean_groundedness: 1, refusal_rate: 0, errored: 0, ...agg } };
}

describe("falseNegativeRate", () => {
  it("counts answerable items that refused or never retrieved the gold span", () => {
    const items = [
      item({ category: "clean", refused: true, recall_at_k: 0 }),
      item({ category: "deviated", refused: false, recall_at_k: 0 }),
      item({ category: "clean", refused: false, recall_at_k: 1 }),
      item({ category: "missing", refused: true, recall_at_k: null }), // not answerable → excluded
    ];
    expect(falseNegativeRate(items)).toBeCloseTo(2 / 3, 10);
  });
  it("returns null with no answerable items", () => {
    expect(falseNegativeRate([item({ category: "missing" })])).toBeNull();
  });
});

describe("compareReports", () => {
  it("computes per-metric deltas including FN rate", () => {
    const base = report([item({ recall_at_k: 0, refused: true })], { mean_recall_at_k: 0.75 });
    const cand = report([item({ recall_at_k: 1, refused: false })], { mean_recall_at_k: 0.9 });
    const rows = compareReports(base, cand);
    const recall = rows.find((r) => r.metric === "recall@k")!;
    expect(recall.delta).toBeCloseTo(0.15, 10);
    const fn = rows.find((r) => r.metric === "false_negative_rate")!;
    expect(fn.baseline).toBe(1);
    expect(fn.candidate).toBe(0);
    expect(fn.delta).toBe(-1);
  });
});
