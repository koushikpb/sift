import { describe, it, expect, vi } from "vitest";
import { hybridRetrieve, type HybridDeps } from "../src/retrieve/hybrid.js";
import { makeRetriever } from "../src/retrieve/retrieve.js";
import type { Candidate } from "../src/retrieve/types.js";

function cand(id: string): Candidate {
  return { node_id: id, doc_id: "d", type: "section", number: null, heading: null, text: id, char_start: 0, char_end: 1, score: 0 };
}

describe("hybridRetrieve", () => {
  it("fuses dense+lexical, caps at M, reranks, returns top-k preserving spans", async () => {
    const deps: HybridDeps = {
      dense: vi.fn().mockResolvedValue([cand("a"), cand("b")]),
      lexical: vi.fn().mockResolvedValue([cand("b"), cand("c")]),
      // rerank returns its input reversed so we can assert it ran and ordered the output
      rerank: vi.fn(async (_q, cs: Candidate[], topK: number) => [...cs].reverse().slice(0, topK)),
    };
    const out = await hybridRetrieve("q", "d", 2, deps, { N_DENSE: 50, N_LEX: 50, M: 100, K_RRF: 60 });
    expect(out).toHaveLength(2);
    expect((deps.dense as any)).toHaveBeenCalledWith("q", "d", 50);
    expect((deps.lexical as any)).toHaveBeenCalledWith("q", "d", 50);
    // rerank received the fused, deduped union {a,b,c}
    const rerankArg = (deps.rerank as any).mock.calls[0][1].map((c: Candidate) => c.node_id).sort();
    expect(rerankArg).toEqual(["a", "b", "c"]);
    expect(out[0].char_start).toBe(0); // span fields preserved
  });

  it("caps the rerank pool at M", async () => {
    const many = Array.from({ length: 80 }, (_, i) => cand("d" + i));
    const deps: HybridDeps = {
      dense: vi.fn().mockResolvedValue(many.slice(0, 50)),
      lexical: vi.fn().mockResolvedValue(many.slice(40, 80)), // union = 80 distinct
      rerank: vi.fn(async (_q, cs: Candidate[], topK: number) => cs.slice(0, topK)),
    };
    await hybridRetrieve("q", "d", 8, deps, { N_DENSE: 50, N_LEX: 50, M: 60, K_RRF: 60 });
    expect((deps.rerank as any).mock.calls[0][1]).toHaveLength(60); // capped at M
  });

  it("falls back to fused order when rerank throws", async () => {
    const deps: HybridDeps = {
      dense: vi.fn().mockResolvedValue([cand("a"), cand("b")]),
      lexical: vi.fn().mockResolvedValue([]),
      rerank: vi.fn().mockRejectedValue(new Error("model load failed")),
    };
    const out = await hybridRetrieve("q", "d", 8, deps);
    expect(out.map((c) => c.node_id)).toEqual(["a", "b"]); // fused order, no throw
  });

  it("returns [] when both stages are empty", async () => {
    const deps: HybridDeps = {
      dense: vi.fn().mockResolvedValue([]),
      lexical: vi.fn().mockResolvedValue([]),
      rerank: vi.fn(),
    };
    expect(await hybridRetrieve("q", "d", 8, deps)).toEqual([]);
    expect((deps.rerank as any)).not.toHaveBeenCalled();
  });
});

describe("makeRetriever", () => {
  it("returns a function for naive (default) and hybrid modes", () => {
    expect(typeof makeRetriever("naive")).toBe("function");
    expect(typeof makeRetriever("hybrid")).toBe("function");
    expect(typeof makeRetriever(undefined)).toBe("function");
  });
});
