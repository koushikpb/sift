import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { loadPlaybook } from "../src/eval/playbook.js";
import { makeFlagRisksTool } from "../src/agent/tools/flagRisks.js";

const entries = loadPlaybook(fileURLToPath(new URL("../../evals/playbook/nda.yaml", import.meta.url)));
const cite = { doc_id: "d1", char_start: 0, char_end: 20, quote: "perpetual and forever" };

describe("flag_risks tool", () => {
  it("emits a flag with the playbook severity and the clause citation when a position matches", async () => {
    const tool = makeFlagRisksTool({ judge: async () => ({ deviation: true, rationale: "perpetual term" }) }, entries);
    const flag = await tool.run({ clause_text: "Obligations are perpetual.", clause_type: "Term / Duration of Confidentiality", citation: cite });
    expect(flag).not.toBeNull();
    expect(flag!.playbook_id).toBe("confidentiality_term");
    expect(flag!.severity).toBe("high");        // from the playbook, not the judge
    expect(flag!.deviation).toBe(true);
    expect(flag!.citation).toEqual(cite);
  });

  it("still emits the matched position (deviation=false) so coverage is measurable", async () => {
    const tool = makeFlagRisksTool({ judge: async () => ({ deviation: false, rationale: "standard 3-year term" }) }, entries);
    const flag = await tool.run({ clause_text: "3 year term.", clause_type: "Governing Law", citation: cite });
    expect(flag!.playbook_id).toBe("governing_law");
    expect(flag!.deviation).toBe(false);
  });

  it("returns null when no playbook position matches the clause type", async () => {
    const tool = makeFlagRisksTool({ judge: async () => ({ deviation: true, rationale: "" }) }, entries);
    expect(await tool.run({ clause_text: "x", clause_type: "Volume Restriction", citation: cite })).toBeNull();
  });
});
