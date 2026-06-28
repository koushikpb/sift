import { describe, it, expect, vi } from "vitest";
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
    expect(r).toMatchObject({
      id: "item-1",
      refused: false,
      recall_at_k: 1,
      ndcg_at_k: 1,
      groundedness: 1,
      num_candidates: 1,
      num_citations: 1,
      category: "clean",
      grader: "span_match",
      error: null,
    });
  });

  it("item 2 is refused with null groundedness and null retrieval metrics (empty gold)", async () => {
    const report = await runEval([item1, item2], deps);
    const r = report.items[1];
    expect(r).toMatchObject({
      id: "item-2",
      refused: true,
      groundedness: null,
      num_citations: 0,
      recall_at_k: null,   // empty gold_spans → null
      ndcg_at_k: null,     // empty gold_spans → null
      error: null,
    });
  });

  it("aggregates: means from non-null values only, refusal_rate === 0.5, errored === 0", async () => {
    const report = await runEval([item1, item2], deps);
    expect(report.total).toBe(2);
    expect(report.k).toBe(8);
    // Only item 1 contributes to every mean (item 2 is all-null)
    expect(report.aggregates.mean_recall_at_k).toBe(1);
    expect(report.aggregates.mean_ndcg_at_k).toBe(1);
    expect(report.aggregates.mean_groundedness).toBe(1);
    expect(report.aggregates.refusal_rate).toBe(0.5);
    expect(report.aggregates.errored).toBe(0);
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

// ─── LLM failure: retrieve OK, generate throws ───────────────────────────────

describe("runEval — LLM failure (retrieve OK, generate throws for one item)", () => {
  const RAW_TEXT_A = "Hello Sift is a contract review copilot.";
  const candidateA = makeCandidate("doc-A", 0, 10, "Hello Sift");

  const item1 = makeItem({
    id: "llm-fail-item-1",
    doc_id: "doc-A",
    objective: "What is Sift?",
    gold_spans: [{ doc_id: "doc-A", char_start: 0, char_end: 10, quote: "Hello Sift" }],
  });
  const item2 = makeItem({
    id: "llm-fail-item-2",
    doc_id: "doc-B",
    objective: "What is the term?",
    gold_spans: [{ doc_id: "doc-B", char_start: 0, char_end: 5, quote: "Three" }],
  });
  const candidateB = makeCandidate("doc-B", 0, 5, "Three", "n2");
  const RAW_TEXT_B = "Three years duration.";

  const deps: RunDeps = {
    retrieve: async (_obj, docId) => {
      if (docId === "doc-A") return [candidateA];
      return [candidateB];
    },
    generate: async (input) => {
      if (input.objective === "What is the term?") throw new Error("rate limit exceeded");
      return { answer: "Sift is a contract review copilot.", supporting: [0], refused: false };
    },
    rawText: async (docId) => {
      if (docId === "doc-A") return RAW_TEXT_A;
      if (docId === "doc-B") return RAW_TEXT_B;
      return null;
    },
  };

  it("run resolves (does not reject)", async () => {
    await expect(runEval([item1, item2], deps)).resolves.toBeDefined();
  });

  it("failing item has error set, retrieval metrics non-null, groundedness null, refused false", async () => {
    const report = await runEval([item1, item2], deps);
    const failing = report.items.find((r) => r.id === "llm-fail-item-2")!;
    expect(failing.error).toBe("rate limit exceeded");
    expect(failing.recall_at_k).not.toBeNull();
    expect(failing.ndcg_at_k).not.toBeNull();
    expect(failing.groundedness).toBeNull();
    expect(failing.refused).toBe(false);
  });

  it("aggregates.errored === 1", async () => {
    const report = await runEval([item1, item2], deps);
    expect(report.aggregates.errored).toBe(1);
  });

  it("failing item's recall/ndcg ARE included in means; excluded from mean_groundedness", async () => {
    const report = await runEval([item1, item2], deps);
    const failing = report.items.find((r) => r.id === "llm-fail-item-2")!;
    const passing = report.items.find((r) => r.id === "llm-fail-item-1")!;
    // Both items have recall/ndcg → mean uses both
    const expectedMeanRecall = ((passing.recall_at_k ?? 0) + (failing.recall_at_k ?? 0)) / 2;
    expect(report.aggregates.mean_recall_at_k).toBeCloseTo(expectedMeanRecall);
    const expectedMeanNdcg = ((passing.ndcg_at_k ?? 0) + (failing.ndcg_at_k ?? 0)) / 2;
    expect(report.aggregates.mean_ndcg_at_k).toBeCloseTo(expectedMeanNdcg);
    // Only passing item has groundedness
    expect(report.aggregates.mean_groundedness).toBe(passing.groundedness);
  });

  it("successful item has error: null", async () => {
    const report = await runEval([item1, item2], deps);
    const passing = report.items.find((r) => r.id === "llm-fail-item-1")!;
    expect(passing.error).toBeNull();
  });
});

// ─── retrieve failure: retrieve throws for one item ───────────────────────────

describe("runEval — retrieve failure (retrieve throws for one item)", () => {
  const RAW_TEXT_A = "Hello Sift is a contract review copilot.";
  const candidateA = makeCandidate("doc-A", 0, 10, "Hello Sift");

  const item1 = makeItem({
    id: "ret-fail-item-1",
    doc_id: "doc-A",
    objective: "What is Sift?",
    gold_spans: [{ doc_id: "doc-A", char_start: 0, char_end: 10, quote: "Hello Sift" }],
  });
  const item2 = makeItem({
    id: "ret-fail-item-2",
    doc_id: "doc-B",
    objective: "What is the term?",
    gold_spans: [{ doc_id: "doc-B", char_start: 0, char_end: 5, quote: "Three" }],
  });

  const deps: RunDeps = {
    retrieve: async (_obj, docId) => {
      if (docId === "doc-B") throw new Error("DB connection failed");
      return [candidateA];
    },
    generate: async () => ({ answer: "Sift is a contract review copilot.", supporting: [0], refused: false }),
    rawText: async (docId) => (docId === "doc-A" ? RAW_TEXT_A : null),
  };

  it("run resolves (does not reject)", async () => {
    await expect(runEval([item1, item2], deps)).resolves.toBeDefined();
  });

  it("failing item has all three metrics null and error set", async () => {
    const report = await runEval([item1, item2], deps);
    const failing = report.items.find((r) => r.id === "ret-fail-item-2")!;
    expect(failing.recall_at_k).toBeNull();
    expect(failing.ndcg_at_k).toBeNull();
    expect(failing.groundedness).toBeNull();
    expect(failing.error).toBe("DB connection failed");
  });

  it("failing item is excluded from all means and counted in errored", async () => {
    const report = await runEval([item1, item2], deps);
    const passing = report.items.find((r) => r.id === "ret-fail-item-1")!;
    expect(report.aggregates.errored).toBe(1);
    // Only passing item contributes to means
    expect(report.aggregates.mean_recall_at_k).toBe(passing.recall_at_k);
    expect(report.aggregates.mean_ndcg_at_k).toBe(passing.ndcg_at_k);
    expect(report.aggregates.mean_groundedness).toBe(passing.groundedness);
  });
});

// ─── progress callback ────────────────────────────────────────────────────────

describe("runEval — onProgress callback", () => {
  const items = [
    makeItem({ id: "p1", doc_id: "doc-P", objective: "Q1", gold_spans: [] }),
    makeItem({ id: "p2", doc_id: "doc-P", objective: "Q2", gold_spans: [] }),
    makeItem({ id: "p3", doc_id: "doc-P", objective: "Q3", gold_spans: [] }),
  ];

  const deps: RunDeps = {
    retrieve: async () => [],
    generate: async () => ({ answer: "", supporting: [], refused: true }),
    rawText: async () => null,
  };

  it("onProgress is called exactly items.length times with monotonically increasing done ending at total", async () => {
    const calls: Array<{ done: number; total: number; itemId: string }> = [];
    const onProgress = vi.fn((done: number, total: number, item: EvalItem) => {
      calls.push({ done, total, itemId: item.id });
    });

    await runEval(items, { ...deps, onProgress });

    expect(onProgress).toHaveBeenCalledTimes(items.length);
    expect(calls.map((c) => c.done)).toEqual([1, 2, 3]);
    expect(calls.every((c) => c.total === items.length)).toBe(true);
    expect(calls[calls.length - 1].done).toBe(items.length);
  });
});
