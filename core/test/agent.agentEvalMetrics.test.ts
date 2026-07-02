import { describe, it, expect } from "vitest";
import { flagCoverage, taskSuccess, trajectoryValid } from "../src/agent/agentEvalMetrics.js";
import type { EvalItem } from "../src/eval/evalItem.js";
import type { ReviewResult } from "../src/agent/reviewAgent.js";

const base = (over: Partial<EvalItem>): EvalItem => ({
  id: "x", doc_id: "d1", source: "cuad", contract_type: "nda", category: "clean",
  objective: "Find governing law", expected_fields: [], expected_flags: [], gold_spans: [],
  grader: "span_match", notes: "", ...over,
});

const result = (over: Partial<ReviewResult>): ReviewResult => ({
  card: { objective: "o", answer: "a", citations: [], refused: false, refusal_reason: null },
  classification: null, flags: [], redlines: [],
  memo: { written: false, path: null, markdown: "" }, trajectory: ["retrieve_clause"], refused: false, ...over,
});

describe("agent eval metrics", () => {
  it("flagCoverage = fraction of expected playbook_ids produced", () => {
    expect(flagCoverage([{ playbook_id: "a" }, { playbook_id: "b" }], [{ playbook_id: "a" }])).toBe(0.5);
    expect(flagCoverage([], [])).toBeNull();
  });

  it("taskSuccess for span_match requires a citation overlapping a gold span", () => {
    const item = base({ grader: "span_match", gold_spans: [{ doc_id: "d1", char_start: 5, char_end: 15, quote: "x" }] });
    const hit = result({ card: { objective: "o", answer: "a", citations: [{ doc_id: "d1", char_start: 10, char_end: 20, quote: "x" }], refused: false, refusal_reason: null } });
    const miss = result({ card: { objective: "o", answer: "a", citations: [{ doc_id: "d1", char_start: 100, char_end: 110, quote: "x" }], refused: false, refusal_reason: null } });
    expect(taskSuccess(item, hit)).toBe(true);
    expect(taskSuccess(item, miss)).toBe(false);
  });

  it("taskSuccess for flag_match requires expected playbook_ids among produced flags", () => {
    const item = base({ grader: "flag_match", expected_flags: [{ playbook_id: "governing_law", severity: "low" }] });
    const hit = result({ flags: [{ playbook_id: "governing_law", clause_type: "Governing Law", severity: "low", deviation: false, rationale: "", citation: { doc_id: "d1", char_start: 0, char_end: 1, quote: "x" } }] });
    expect(taskSuccess(item, hit)).toBe(true);
    expect(taskSuccess(item, result({ flags: [] }))).toBe(false);
  });

  it("taskSuccess for refusal requires the agent to refuse", () => {
    const item = base({ grader: "refusal", category: "missing" });
    expect(taskSuccess(item, result({ refused: true }))).toBe(true);
    expect(taskSuccess(item, result({ refused: false }))).toBe(false);
  });

  it("trajectoryValid: refusal items refuse; answerable items retrieve + check_playbook", () => {
    const refItem = base({ grader: "refusal" });
    expect(trajectoryValid(refItem, result({ refused: true, trajectory: ["retrieve_clause", "check_playbook", "export_memo"] }))).toBe(true);
    const flagItem = base({ grader: "flag_match" });
    expect(trajectoryValid(flagItem, result({ refused: false, trajectory: ["retrieve_clause", "check_playbook", "flag_risks", "export_memo"] }))).toBe(true);
    expect(trajectoryValid(flagItem, result({ refused: true, trajectory: ["retrieve_clause", "check_playbook", "export_memo"] }))).toBe(false);
  });
});
