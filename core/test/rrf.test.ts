import { describe, it, expect } from "vitest";
import { rrfFuse } from "../src/retrieve/rrf.js";
import type { Candidate } from "../src/retrieve/types.js";

function cand(id: string, score = 0): Candidate {
  return { node_id: id, doc_id: "d", type: "section", number: null, heading: null, text: id, char_start: 0, char_end: 1, score };
}

describe("rrfFuse", () => {
  it("ranks a node appearing in both lists above singletons", () => {
    const dense = [cand("a"), cand("b"), cand("c")];
    const lexical = [cand("a"), cand("d")];
    const fused = rrfFuse([dense, lexical], { k: 60 });
    expect(fused[0].node_id).toBe("a");
    expect(fused.map((c) => c.node_id).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("sets score to the RRF score (sum of 1/(k+rank))", () => {
    const fused = rrfFuse([[cand("a"), cand("b")]], { k: 60 });
    expect(fused[0].score).toBeCloseTo(1 / 61, 10);
    expect(fused[1].score).toBeCloseTo(1 / 62, 10);
  });

  it("dedupes by node_id, keeping the first occurrence's fields", () => {
    const first = { ...cand("a"), text: "first" };
    const second = { ...cand("a"), text: "second" };
    const fused = rrfFuse([[first], [second]], { k: 60 });
    expect(fused).toHaveLength(1);
    expect(fused[0].text).toBe("first");
  });

  it("handles empty input", () => {
    expect(rrfFuse([], { k: 60 })).toEqual([]);
    expect(rrfFuse([[], []], { k: 60 })).toEqual([]);
  });
});
