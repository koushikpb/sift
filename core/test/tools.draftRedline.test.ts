import { describe, it, expect } from "vitest";
import { makeDraftRedlineTool } from "../src/agent/tools/draftRedline.js";

const flag = {
  playbook_id: "confidentiality_term", clause_type: "Term / Duration of Confidentiality",
  severity: "high" as const, deviation: true, rationale: "perpetual term",
  citation: { doc_id: "d1", char_start: 5, char_end: 30, quote: "obligations are perpetual." },
};

describe("draft_redline tool", () => {
  it("returns a grounded redline citing the original span", async () => {
    const tool = makeDraftRedlineTool({ suggest: async () => "Confidentiality obligations survive for three (3) years." });
    const rl = await tool.run({ flag, clause_text: "Obligations are perpetual." });
    expect(rl.playbook_id).toBe("confidentiality_term");
    expect(rl.original).toEqual(flag.citation);
    expect(rl.suggested_text).toMatch(/three/i);
  });
});
