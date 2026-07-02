import { describe, it, expect } from "vitest";
import { runAgentEval } from "../src/agent/agentEval.js";
import type { EvalItem } from "../src/eval/evalItem.js";
import { makeRetrieveClauseTool } from "../src/agent/tools/retrieveClause.js";
import { makeClassifyClauseTool } from "../src/agent/tools/classifyClause.js";
import { makeFlagRisksTool } from "../src/agent/tools/flagRisks.js";
import { makeDraftRedlineTool } from "../src/agent/tools/draftRedline.js";
import { makeExportMemoTool } from "../src/agent/tools/exportMemo.js";
import { fileURLToPath } from "node:url";
import { loadPlaybook } from "../src/eval/playbook.js";
import type { Candidate } from "../src/retrieve/retrieve.js";

const entries = loadPlaybook(fileURLToPath(new URL("../../evals/playbook/nda.yaml", import.meta.url)));
const cand: Candidate = { node_id: "n0", doc_id: "d1", type: "s", number: null, heading: null, text: "law of Delaware", char_start: 5, char_end: 20, score: 1 };

const items: EvalItem[] = [
  { id: "flag1", doc_id: "d1", source: "cuad", contract_type: "nda", category: "deviated", objective: "Find the governing law clause (playbook requires governing_law)",
    expected_fields: [], expected_flags: [{ playbook_id: "governing_law", severity: "low" }], gold_spans: [], grader: "flag_match", notes: "" },
];

function deps() {
  const writes: string[] = [];
  return { writes, deps: {
    playbook: entries,
    retrieveClause: makeRetrieveClauseTool({ retrieve: async () => [cand], generate: async () => ({ answer: "Delaware", supporting: [0], refused: false, refusal_reason: null }) }),
    classifyClause: makeClassifyClauseTool({ runPredict: async (t) => t.map((x) => ({ text: x, label: "Governing Law", score: 0.9 })) }),
    flagRisks: makeFlagRisksTool({ judge: async () => ({ deviation: true, rationale: "foreign law" }) }, entries),
    draftRedline: makeDraftRedlineTool({ suggest: async () => "Delaware law governs." }),
    exportMemo: makeExportMemoTool({ writeFile: async (p) => { writes.push(p); } }),
  } };
}

describe("runAgentEval", () => {
  it("scores task success, flag coverage, and proves the HITL gate held", async () => {
    const { writes, deps: d } = deps();
    const report = await runAgentEval(items, d, { rawText: async () => "xxxxxlaw of Delawarexxxxx", generatedAt: "2026-06-30T00:00:00Z" });
    expect(report.total).toBe(1);
    expect(report.aggregates.task_success_rate).toBe(1);
    expect(report.aggregates.flag_false_negative_rate).toBe(0);
    expect(report.aggregates.unconfirmed_writes).toBe(0);
    expect(writes).toHaveLength(0);
  });
});
