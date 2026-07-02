import { describe, it, expect } from "vitest";
import { makeExtractFieldsTool } from "../src/agent/tools/extractFields.js";
import type { Candidate } from "../src/retrieve/retrieve.js";

const cand: Candidate = {
  node_id: "n0", doc_id: "d1", type: "section", number: null, heading: null,
  text: "governed by the laws of Delaware", char_start: 10, char_end: 42, score: 1,
};

describe("extract_fields tool", () => {
  it("returns a field grounded in the answer's citation", async () => {
    const tool = makeExtractFieldsTool({
      retrieve: async () => [cand],
      generate: async () => ({ answer: "Delaware", supporting: [0], refused: false, refusal_reason: null }),
    });
    const field = await tool.run({ objective: "Find governing law", doc_id: "d1", field_name: "Governing Law" });
    expect(field.name).toBe("Governing Law");
    expect(field.value).toBe("Delaware");
    expect(field.citation).toMatchObject({ char_start: 10, char_end: 42 });
  });

  it("returns a null citation when the clause is not grounded (refusal)", async () => {
    const tool = makeExtractFieldsTool({
      retrieve: async () => [cand],
      generate: async () => ({ answer: "", supporting: [], refused: true, refusal_reason: "insufficient context" }),
    });
    const field = await tool.run({ objective: "Find arbitration seat", doc_id: "d1", field_name: "Arbitration Seat" });
    expect(field.name).toBe("Arbitration Seat");
    expect(field.citation).toBeNull();
  });
});
