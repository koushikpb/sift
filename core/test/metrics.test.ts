import { describe, it, expect } from "vitest";
import {
  overlaps,
  recallAtK,
  ndcgAtK,
  groundedness,
} from "../src/eval/metrics.js";
import type { RankedSpan, Citation } from "../src/eval/metrics.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function span(doc_id: string, char_start: number, char_end: number): RankedSpan {
  return { doc_id, char_start, char_end };
}

function cite(
  doc_id: string,
  char_start: number,
  char_end: number,
  quote: string,
): Citation {
  return { doc_id, char_start, char_end, quote };
}

// ─── overlaps ───────────────────────────────────────────────────────────────

describe("overlaps", () => {
  it("returns true for half-open ranges that overlap on the same doc", () => {
    // [0, 10) ∩ [5, 15) → overlapping
    expect(overlaps(span("doc1", 0, 10), span("doc1", 5, 15))).toBe(true);
  });

  it("returns false for touching (but not overlapping) ranges on the same doc", () => {
    // [0, 5) and [5, 10) share endpoint 5 but half-open → no overlap
    expect(overlaps(span("doc1", 0, 5), span("doc1", 5, 10))).toBe(false);
  });

  it("returns false when docs differ, even if ranges would overlap", () => {
    expect(overlaps(span("doc1", 0, 10), span("doc2", 5, 15))).toBe(false);
  });

  it("returns true for exact same span on same doc", () => {
    expect(overlaps(span("doc1", 3, 7), span("doc1", 3, 7))).toBe(true);
  });

  it("returns true when one span contains the other", () => {
    expect(overlaps(span("docA", 0, 20), span("docA", 5, 10))).toBe(true);
  });
});

// ─── recallAtK ──────────────────────────────────────────────────────────────

describe("recallAtK", () => {
  it("returns null when gold is empty", () => {
    expect(recallAtK([span("d", 0, 5)], [], 5)).toBeNull();
  });

  it("returns 0.5 when top-k covers only one of two gold spans", () => {
    const gold = [span("doc", 0, 10), span("doc", 50, 60)];
    // retrieved[0] overlaps gold[0]; retrieved[1] is in gold[1]'s range but out of top-1
    const retrieved = [span("doc", 3, 7), span("doc", 52, 58)];
    expect(recallAtK(retrieved, gold, 1)).toBe(0.5);
  });

  it("k truncates the retrieved list — candidates beyond rank k do not count", () => {
    const gold = [span("doc", 0, 10), span("doc", 50, 60)];
    // Both candidates are relevant, but k=1 only sees the first
    const retrieved = [span("doc", 3, 7), span("doc", 52, 58)];
    // With k=1: only retrieved[0] is considered → covers gold[0] but not gold[1] → 0.5
    expect(recallAtK(retrieved, gold, 1)).toBe(0.5);
    // With k=2: both retrieved candidates are considered → covers both gold → 1
    expect(recallAtK(retrieved, gold, 2)).toBe(1);
  });

  it("returns 0 when none of the top-k retrieved spans overlap any gold span", () => {
    const gold = [span("doc", 100, 200)];
    const retrieved = [span("doc", 0, 10), span("doc", 20, 30)];
    expect(recallAtK(retrieved, gold, 2)).toBe(0);
  });

  it("returns 1 when all gold spans are covered within top-k", () => {
    const gold = [span("doc", 0, 10), span("doc", 20, 30)];
    const retrieved = [span("doc", 0, 10), span("doc", 20, 30)];
    expect(recallAtK(retrieved, gold, 5)).toBe(1);
  });
});

// ─── ndcgAtK ────────────────────────────────────────────────────────────────

describe("ndcgAtK", () => {
  it("returns 0 when gold is non-empty but no retrieved span overlaps any gold (total retrieval miss)", () => {
    const gold = [span("doc", 100, 200)];
    const retrieved = [span("doc", 0, 5), span("doc", 10, 15)];
    expect(ndcgAtK(retrieved, gold, 2)).toBe(0);
  });

  it("returns 1 when the single relevant candidate is at rank 1", () => {
    const gold = [span("doc", 0, 10)];
    const retrieved = [span("doc", 2, 8)]; // overlaps gold[0]
    expect(ndcgAtK(retrieved, gold, 1)).toBe(1);
  });

  it("returns 1/log2(3) ≈ 0.6309 when relevant is at rank 2 and rank 1 is irrelevant", () => {
    const gold = [span("doc", 50, 60)];
    const retrieved = [
      span("doc", 0, 5),   // rank 1 — irrelevant
      span("doc", 52, 58), // rank 2 — overlaps gold[0]
    ];
    // DCG = 0/log2(2) + 1/log2(3) = 1/log2(3)
    // numRel = 1 → IDCG = 1/log2(2) = 1
    // NDCG = 1/log2(3) ≈ 0.6309
    expect(ndcgAtK(retrieved, gold, 2)).toBeCloseTo(1 / Math.log2(3), 10);
  });

  it("returns null when gold is empty (no possible relevant candidate)", () => {
    const retrieved = [span("doc", 0, 10)];
    expect(ndcgAtK(retrieved, [], 5)).toBeNull();
  });

  it("handles k larger than retrieved length gracefully", () => {
    const gold = [span("doc", 0, 10)];
    const retrieved = [span("doc", 2, 8)];
    // k=10 but only 1 candidate: still NDCG = 1
    expect(ndcgAtK(retrieved, gold, 10)).toBe(1);
  });
});

// ─── groundedness ────────────────────────────────────────────────────────────

describe("groundedness", () => {
  it("returns null when citations list is empty", () => {
    expect(groundedness([], () => "some text")).toBeNull();
  });

  it("returns 0.5 when one of two citations is grounded and one is not", () => {
    const rawTexts: Record<string, string> = { doc1: "Hello, world!" };
    const rawText = (id: string) => rawTexts[id] ?? null;

    const citations: Citation[] = [
      cite("doc1", 0, 5, "Hello"),       // "Hello, world!".slice(0,5) === "Hello" ✓
      cite("doc1", 0, 5, "hello"),       // wrong case — not grounded
    ];
    expect(groundedness(citations, rawText)).toBe(0.5);
  });

  it("counts an unknown doc (rawText returns null) as not grounded", () => {
    const rawText = (_id: string) => null;
    const citations: Citation[] = [cite("missing-doc", 0, 5, "Hello")];
    expect(groundedness(citations, rawText)).toBe(0);
  });

  it("uses strict === comparison — no trimming or normalization", () => {
    const rawTexts: Record<string, string> = { doc1: "Hello World" };
    const rawText = (id: string) => rawTexts[id] ?? null;

    // Trailing space — not exactly equal to slice
    const citations: Citation[] = [cite("doc1", 0, 5, "Hello ")];
    expect(groundedness(citations, rawText)).toBe(0);
  });

  it("returns 1 when all citations are grounded", () => {
    const rawTexts: Record<string, string> = { doc1: "Hello World" };
    const rawText = (id: string) => rawTexts[id] ?? null;

    const citations: Citation[] = [
      cite("doc1", 0, 5, "Hello"),
      cite("doc1", 6, 11, "World"),
    ];
    expect(groundedness(citations, rawText)).toBe(1);
  });

  it("unknown doc counts in the denominator — mixed grounded and unknown", () => {
    const rawTexts: Record<string, string> = { doc1: "Hello World" };
    const rawText = (id: string) => rawTexts[id] ?? null;

    const citations: Citation[] = [
      cite("doc1", 0, 5, "Hello"),    // grounded
      cite("missing", 0, 5, "Hello"), // unknown doc → not grounded
    ];
    expect(groundedness(citations, rawText)).toBe(0.5);
  });
});
