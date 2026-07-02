import { describe, it, expect } from "vitest";
import {
  CitationSchema,
  ExtractedFieldSchema,
  ReviewFlagSchema,
  RedlineProposalSchema,
  ReviewMemoSchema,
} from "../src/agent/tools/types.js";

const cite = { doc_id: "d1", char_start: 0, char_end: 5, quote: "hello" };

describe("tool artifact schemas", () => {
  it("Citation accepts a well-formed span and rejects negative offsets", () => {
    expect(CitationSchema.parse(cite)).toEqual(cite);
    expect(() => CitationSchema.parse({ ...cite, char_start: -1 })).toThrow();
  });

  it("ExtractedField allows a null citation (not found) but not a missing name", () => {
    expect(ExtractedFieldSchema.parse({ name: "Governing Law", value: "", citation: null }).citation).toBeNull();
    expect(() => ExtractedFieldSchema.parse({ value: "x", citation: null })).toThrow();
  });

  it("ReviewFlag requires a grounded citation and a valid severity", () => {
    const flag = { playbook_id: "governing_law", clause_type: "Governing Law", severity: "low", deviation: false, rationale: "standard", citation: cite };
    expect(ReviewFlagSchema.parse(flag)).toEqual(flag);
    expect(() => ReviewFlagSchema.parse({ ...flag, severity: "critical" })).toThrow();
  });

  it("RedlineProposal and ReviewMemo round-trip", () => {
    const redline = { playbook_id: "exclusions", original: cite, suggested_text: "Add standard exclusions.", rationale: "missing exclusions" };
    expect(RedlineProposalSchema.parse(redline)).toEqual(redline);
    const memo = { doc_id: "d1", objective: "review", fields: [], flags: [], redlines: [redline], generated_at: "2026-06-30T00:00:00Z" };
    expect(ReviewMemoSchema.parse(memo)).toEqual(memo);
  });

  it("ReviewFlag allows a null citation (missing-required-clause finding)", () => {
    const missing = { playbook_id: "return_of_materials", clause_type: "Return or Destruction", severity: "low", deviation: true, rationale: "absent", citation: null };
    expect(ReviewFlagSchema.parse(missing).citation).toBeNull();
  });

  it("schemas are strict (reject unknown keys)", () => {
    expect(() => ReviewFlagSchema.parse({ playbook_id: "x", clause_type: "y", severity: "low", deviation: false, rationale: "", citation: cite, extra: 1 })).toThrow();
  });
});
