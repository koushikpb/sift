import { describe, it, expect } from "vitest";
import { runEval } from "../src/eval/runEval.js";
import type { RunDeps } from "../src/eval/runEval.js";
import type { EvalItem } from "../src/eval/evalItem.js";
import type { Candidate } from "../src/retrieve/retrieve.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeItem(
  overrides: Pick<EvalItem, "id" | "doc_id" | "objective"> & Partial<EvalItem>,
): EvalItem {
  return {
    source: "cuad",
    contract_type: "NDA",
    category: "clean",
    grader: "span_match",
    expected_fields: [],
    expected_flags: [],
    gold_spans: [],
    notes: "",
    ...overrides,
  };
}

function makeCandidate(
  doc_id: string,
  char_start: number,
  char_end: number,
  text: string,
  node_id = "n1",
): Candidate {
  return {
    node_id,
    doc_id,
    type: "section",
    number: null,
    heading: null,
    text,
    char_start,
    char_end,
    score: 0.9,
  };
}

// ─── 2-item run: one grounded, one refused ────────────────────────────────────

describe("runEval — 2-item run (grounded + refused)", () => {
  // "Hello Sift" is exactly 10 chars; slice(0,10) === "Hello Sift"
  const RAW_TEXT_A = "Hello Sift is a contract review copilot.";
  const candidateA = makeCandidate("doc-A", 0, 10, "Hello Sift");

  const item1 = makeItem({
    id: "item-1",
    doc_id: "doc-A",
    objective: "What is Sift?",
    gold_spans: [{ doc_id: "doc-A", char_start: 0, char_end: 10, quote: "Hello Sift" }],
  });

  // Item 2 is refused AND has empty gold_spans — all three metrics are null for this item,
  // so the aggregate means are driven purely by item 1.
  const item2 = makeItem({
    id: "item-2",
    doc_id: "doc-B",
    objective: "What is the governing law?",
    gold_spans: [],
  });

  const deps: RunDeps = {
    retrieve: async (_obj, docId) => {
      if (docId === "doc-A") return [candidateA];
      return [];
    },
    generate: async (input) => {
      if (input.objective === "What is Sift?") {
        // non-refused: supporting index 0 → candidateA
        return { answer: "Sift is a contract review copilot.", supporting: [0], refused: false };
      }
      // refused
      return { answer: "", supporting: [], refused: true, refusal_reason: "insufficient context" };
    },
    rawText: async (docId) => {
      if (docId === "doc-A") return RAW_TEXT_A;
      return null;
    },
  };

  it("item 1 is not refused, has recall=1, ndcg=1, groundedness=1", async () => {
    const report = await runEval([item1, item2], deps);
    const r = report.items[0];
    expect(r.id).toBe("item-1");
    expect(r.refused).toBe(false);
    expect(r.recall_at_k).toBe(1);
    expect(r.ndcg_at_k).toBe(1);
    expect(r.groundedness).toBe(1);
    expect(r.num_candidates).toBe(1);
    expect(r.num_citations).toBe(1);
    expect(r.category).toBe("clean");
    expect(r.grader).toBe("span_match");
  });

  it("item 2 is refused with null groundedness and null retrieval metrics (empty gold)", async () => {
    const report = await runEval([item1, item2], deps);
    const r = report.items[1];
    expect(r.id).toBe("item-2");
    expect(r.refused).toBe(true);
    expect(r.groundedness).toBeNull();
    expect(r.num_citations).toBe(0);
    expect(r.recall_at_k).toBeNull();   // empty gold_spans → null
    expect(r.ndcg_at_k).toBeNull();     // empty gold_spans → null
  });

  it("aggregates: means from non-null values only, refusal_rate === 0.5", async () => {
    const report = await runEval([item1, item2], deps);
    expect(report.total).toBe(2);
    expect(report.k).toBe(8);
    // Only item 1 contributes to every mean (item 2 is all-null)
    expect(report.aggregates.mean_recall_at_k).toBe(1);
    expect(report.aggregates.mean_ndcg_at_k).toBe(1);
    expect(report.aggregates.mean_groundedness).toBe(1);
    expect(report.aggregates.refusal_rate).toBe(0.5);
  });

  it("groundedness exercises the exact-equality path (quote === rawText.slice(start, end))", async () => {
    // RAW_TEXT_A.slice(0, 10) === "Hello Sift" — strict ===, no normalisation
    const report = await runEval([item1], deps);
    const r = report.items[0];
    expect(r.groundedness).toBe(1);
  });
});

// ─── empty gold_spans ─────────────────────────────────────────────────────────

describe("runEval — empty gold_spans item", () => {
  // "Some clause text" is 16 chars; slice(0,16) === "Some clause text"
  const RAW_TEXT_X = "Some clause text and more.";
  const candidateX = makeCandidate("doc-X", 0, 16, "Some clause text");

  const item = makeItem({
    id: "item-empty-gold",
    doc_id: "doc-X",
    objective: "Find confidentiality clause.",
    gold_spans: [], // empty → recall/ndcg not applicable
  });

  const deps: RunDeps = {
    retrieve: async () => [candidateX],
    generate: async () => ({ answer: "Some clause text", supporting: [0], refused: false }),
    rawText: async (docId) => (docId === "doc-X" ? RAW_TEXT_X : null),
  };

  it("recall_at_k and ndcg_at_k are null; excluded from aggregate means", async () => {
    const report = await runEval([item], deps);
    const r = report.items[0];
    expect(r.recall_at_k).toBeNull();
    expect(r.ndcg_at_k).toBeNull();
    expect(r.refused).toBe(false);
    // Means for recall/ndcg are null because no non-null values
    expect(report.aggregates.mean_recall_at_k).toBeNull();
    expect(report.aggregates.mean_ndcg_at_k).toBeNull();
    // Groundedness is computed (non-refused) and contributes to mean
    expect(r.groundedness).toBe(1);
    expect(report.aggregates.mean_groundedness).toBe(1);
  });
});

// ─── empty items list ─────────────────────────────────────────────────────────

describe("runEval — empty items list", () => {
  const deps: RunDeps = {
    retrieve: async () => [],
    generate: async () => ({ answer: "", supporting: [], refused: false }),
    rawText: async () => null,
  };

  it("returns total=0, refusal_rate=0, all means null", async () => {
    const report = await runEval([], deps);
    expect(report.total).toBe(0);
    expect(report.items).toHaveLength(0);
    expect(report.k).toBe(8);
    expect(report.aggregates.refusal_rate).toBe(0);
    expect(report.aggregates.mean_recall_at_k).toBeNull();
    expect(report.aggregates.mean_ndcg_at_k).toBeNull();
    expect(report.aggregates.mean_groundedness).toBeNull();
  });
});

// ─── custom k ─────────────────────────────────────────────────────────────────

describe("runEval — custom k", () => {
  const item = makeItem({
    id: "item-k",
    doc_id: "doc-K",
    objective: "Governing law?",
    gold_spans: [{ doc_id: "doc-K", char_start: 0, char_end: 5, quote: "NewYo" }],
  });

  let capturedK: number | undefined;
  const deps: RunDeps = {
    retrieve: async (_obj, _docId, k) => {
      capturedK = k;
      return [];
    },
    generate: async () => ({ answer: "", supporting: [], refused: true }),
    rawText: async () => null,
  };

  it("passes the supplied k to retrieve and uses it for metrics", async () => {
    const report = await runEval([item], deps, 4);
    expect(report.k).toBe(4);
    expect(capturedK).toBe(4);
  });
});
