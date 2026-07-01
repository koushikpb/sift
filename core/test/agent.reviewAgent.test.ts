import { describe, it, expect } from "vitest";
import { reviewContract } from "../src/agent/reviewAgent.js";
import { makeRetrieveClauseTool } from "../src/agent/tools/retrieveClause.js";
import { makeClassifyClauseTool } from "../src/agent/tools/classifyClause.js";
import { makeFlagRisksTool } from "../src/agent/tools/flagRisks.js";
import { makeDraftRedlineTool } from "../src/agent/tools/draftRedline.js";
import { makeExportMemoTool } from "../src/agent/tools/exportMemo.js";
import { fileURLToPath } from "node:url";
import { loadPlaybook } from "../src/eval/playbook.js";
import type { Candidate } from "../src/retrieve/retrieve.js";

const entries = loadPlaybook(fileURLToPath(new URL("../../evals/playbook/nda.yaml", import.meta.url)));
const cand: Candidate = { node_id: "n0", doc_id: "d1", type: "s", number: null, heading: null, text: "Obligations are perpetual.", char_start: 0, char_end: 26, score: 1 };

function deps(refuse: boolean) {
  const writes: string[] = [];
  return {
    writes,
    deps: {
      retrieveClause: makeRetrieveClauseTool({
        retrieve: async () => [cand],
        generate: async () => refuse ? { answer: "", supporting: [], refused: true, refusal_reason: "n/a" } : { answer: "perpetual term", supporting: [0], refused: false, refusal_reason: null },
      }),
      classifyClause: makeClassifyClauseTool({ runPredict: async (t) => t.map((x) => ({ text: x, label: "Term / Duration of Confidentiality", score: 0.9 })) }),
      flagRisks: makeFlagRisksTool({ judge: async () => ({ deviation: true, rationale: "perpetual" }) }, entries),
      draftRedline: makeDraftRedlineTool({ suggest: async () => "Three (3) year term." }),
      exportMemo: makeExportMemoTool({ writeFile: async (p) => { writes.push(p); } }),
    },
  };
}

describe("reviewContract orchestrator", () => {
  it("runs the full trajectory and returns a grounded flag + memo preview (no write)", async () => {
    const { writes, deps: d } = deps(false);
    const r = await reviewContract("Review confidentiality term", "d1", d, { generatedAt: "2026-06-30T00:00:00Z" });
    expect(r.refused).toBe(false);
    expect(r.trajectory).toEqual(["retrieve_clause", "classify_clause", "flag_risks", "draft_redline", "export_memo"]);
    expect(r.flags[0].playbook_id).toBe("confidentiality_term");
    expect(r.redlines).toHaveLength(1);
    expect(r.memo.written).toBe(false);      // eval path never confirms → HITL gate holds
    expect(writes).toHaveLength(0);
  });

  it("stops after retrieval and refuses when the clause is ungrounded", async () => {
    const { deps: d } = deps(true);
    const r = await reviewContract("Find arbitration seat", "d1", d, { generatedAt: "2026-06-30T00:00:00Z" });
    expect(r.refused).toBe(true);
    expect(r.trajectory).toEqual(["retrieve_clause"]);
    expect(r.flags).toHaveLength(0);
  });
});
