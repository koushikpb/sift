import { describe, it, expect } from "vitest";
import { makeRetrieveClauseTool } from "../src/agent/tools/retrieveClause.js";
import type { Candidate } from "../src/retrieve/retrieve.js";

const cand = (i: number): Candidate => ({
  node_id: `n${i}`, doc_id: "d1", type: "section", number: null, heading: null,
  text: "This Agreement is governed by the laws of Delaware.", char_start: 10, char_end: 61, score: 1 - i * 0.1,
});

describe("retrieve_clause tool", () => {
  it("produces a grounded ClauseCard from the chosen candidate", async () => {
    const tool = makeRetrieveClauseTool({
      retrieve: async () => [cand(0)],
      generate: async () => ({ answer: "Delaware law governs.", supporting: [0], refused: false, refusal_reason: null }),
    });
    const card = await tool.run({ objective: "Find governing law", doc_id: "d1" });
    expect(card.refused).toBe(false);
    expect(card.citations).toHaveLength(1);
    expect(card.citations[0]).toMatchObject({ doc_id: "d1", char_start: 10, char_end: 61 });
  });

  it("refuses when the model refuses (no citations invented)", async () => {
    const tool = makeRetrieveClauseTool({
      retrieve: async () => [cand(0)],
      generate: async () => ({ answer: "", supporting: [], refused: true, refusal_reason: "insufficient context" }),
    });
    const card = await tool.run({ objective: "Find arbitration seat", doc_id: "d1" });
    expect(card.refused).toBe(true);
    expect(card.citations).toHaveLength(0);
  });

  it("declares itself a read tool", () => {
    const tool = makeRetrieveClauseTool({ retrieve: async () => [], generate: async () => ({ answer: "", supporting: [], refused: true }) });
    expect(tool.name).toBe("retrieve_clause");
    expect(tool.sideEffect).toBe("read");
  });
});
