import { describe, it, expect, vi } from "vitest";
import { agenticRetrieve, type AgenticDeps } from "../src/agent/loop.js";
import { rrfFuse } from "../src/retrieve/rrf.js";
import type { Candidate } from "../src/retrieve/types.js";

function cand(id: string): Candidate {
  return { node_id: id, doc_id: "d", type: "section", number: null, heading: null, text: id, char_start: 0, char_end: 1, score: 0 };
}
// Fresh identity-rerank per test (slice top-k), so call counts are not shared across tests.
const rr = () => vi.fn(async (_q: string, cs: Candidate[], topK: number) => cs.slice(0, topK));
const cfg = { MAX_ROUNDS: 2, N: 50, M: 100, K_RRF: 60 };

describe("agenticRetrieve", () => {
  it("returns round-1 result and skips round 2 when the judge says sufficient", async () => {
    const deps: AgenticDeps = {
      dense: vi.fn().mockResolvedValue([cand("a")]),
      lexical: vi.fn().mockResolvedValue([cand("b")]),
      rerank: rr(),
      rrfFuse,
      judge: vi.fn().mockResolvedValue({ sufficient: true, reformulations: [] }),
    };
    const out = await agenticRetrieve("q", "d", 8, deps, cfg);
    expect(out.map((c) => c.node_id).sort()).toEqual(["a", "b"]);
    expect((deps.dense as any)).toHaveBeenCalledTimes(1); // only round 1
    expect((deps.judge as any)).toHaveBeenCalledTimes(1);
  });

  it("runs a reformulation round when insufficient, fusing the new candidates", async () => {
    const dense = vi.fn()
      .mockResolvedValueOnce([cand("a")])   // round 1
      .mockResolvedValueOnce([cand("c")]);  // round 2 (reformulation "r1")
    const lexical = vi.fn()
      .mockResolvedValueOnce([cand("b")])
      .mockResolvedValueOnce([cand("d")]);
    const rerank = rr();
    const deps: AgenticDeps = {
      dense, lexical, rerank, rrfFuse,
      judge: vi.fn().mockResolvedValue({ sufficient: false, reformulations: ["r1"] }),
    };
    const out = await agenticRetrieve("q", "d", 8, deps, cfg);
    expect(dense).toHaveBeenCalledTimes(2);
    expect(dense.mock.calls[1][0]).toBe("r1"); // reformulated query used
    expect(out.map((c) => c.node_id).sort()).toEqual(["a", "b", "c", "d"]); // fused union
    expect(rerank).toHaveBeenCalledTimes(2);
  });

  it("stops early (returns round-1) when a reformulation round adds no new candidates", async () => {
    const dense = vi.fn()
      .mockResolvedValueOnce([cand("a")])
      .mockResolvedValueOnce([cand("a")]); // same id → nothing new
    const lexical = vi.fn()
      .mockResolvedValueOnce([cand("b")])
      .mockResolvedValueOnce([cand("b")]);
    const rerank = rr();
    const deps: AgenticDeps = {
      dense, lexical, rerank, rrfFuse,
      judge: vi.fn().mockResolvedValue({ sufficient: false, reformulations: ["r1"] }),
    };
    const out = await agenticRetrieve("q", "d", 8, deps, cfg);
    expect(out.map((c) => c.node_id).sort()).toEqual(["a", "b"]);
    expect(rerank).toHaveBeenCalledTimes(1); // round-1 rerank only; no second rerank
  });

  it("returns round-1 when the judge proposes no reformulations", async () => {
    const dense = vi.fn().mockResolvedValue([cand("a")]);
    const lexical = vi.fn().mockResolvedValue([cand("b")]);
    const deps: AgenticDeps = {
      dense, lexical, rerank: rr(), rrfFuse,
      judge: vi.fn().mockResolvedValue({ sufficient: false, reformulations: [] }),
    };
    const out = await agenticRetrieve("q", "d", 8, deps, cfg);
    expect(dense).toHaveBeenCalledTimes(1);
    expect(out.map((c) => c.node_id).sort()).toEqual(["a", "b"]);
  });

  it("degrades to round-1 when the judge throws", async () => {
    const deps: AgenticDeps = {
      dense: vi.fn().mockResolvedValue([cand("a")]),
      lexical: vi.fn().mockResolvedValue([cand("b")]),
      rerank: rr(), rrfFuse,
      judge: vi.fn().mockRejectedValue(new Error("llm down")),
    };
    const out = await agenticRetrieve("q", "d", 8, deps, cfg);
    expect(out.map((c) => c.node_id).sort()).toEqual(["a", "b"]);
  });

  it("falls back to fused order when rerank throws", async () => {
    const deps: AgenticDeps = {
      dense: vi.fn().mockResolvedValue([cand("a")]),
      lexical: vi.fn().mockResolvedValue([cand("b")]),
      rerank: vi.fn().mockRejectedValue(new Error("model load failed")),
      rrfFuse,
      judge: vi.fn().mockResolvedValue({ sufficient: true, reformulations: [] }),
    };
    const out = await agenticRetrieve("q", "d", 8, deps, cfg);
    expect(out.map((c) => c.node_id).sort()).toEqual(["a", "b"]); // fused order, no throw
  });
});
