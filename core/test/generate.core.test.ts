import { describe, it, expect } from "vitest";
import { buildPrompt, extractJsonObject, parseRawGen } from "../src/generate/prompt.js";
import { toClauseCard } from "../src/generate/toClauseCard.js";
import type { Candidate } from "../src/retrieve/retrieve.js";

const cands: Candidate[] = [
  { node_id: "d::0", doc_id: "d", type: "section", number: "1", heading: null, text: "Governed by New York law.", char_start: 0, char_end: 25, score: 0.9 },
  { node_id: "d::1", doc_id: "d", type: "section", number: "2", heading: null, text: "Term is three years.", char_start: 26, char_end: 46, score: 0.5 },
];

describe("buildPrompt", () => {
  it("numbers candidates and instructs index-citation + refusal", () => {
    const { system, user } = buildPrompt({ objective: "What law governs?", candidates: cands });
    expect(system).toMatch(/insufficient context/i);
    expect(user).toContain("[0]");
    expect(user).toContain("Governed by New York law.");
    expect(user).toContain("What law governs?");
  });
});

describe("extractJsonObject", () => {
  it("parses raw JSON, fenced JSON, and JSON with preamble", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('Sure!\n{"a":1}\nDone')).toEqual({ a: 1 });
  });

  it("handles a closing brace inside a string value", () => {
    expect(extractJsonObject('{"answer":"see {clause} applies","refused":false}')).toEqual({ answer: "see {clause} applies", refused: false });
  });
});

describe("parseRawGen", () => {
  it("coerces a valid object and defaults a garbage response to a refusal", () => {
    expect(parseRawGen('{"answer":"x","supporting":[0],"refused":false}')).toEqual({
      answer: "x", supporting: [0], refused: false, refusal_reason: null,
    });
    expect(parseRawGen("not json at all").refused).toBe(true);
  });

  it("keeps a valid answer when refusal_reason is the wrong type", () => {
    const r = parseRawGen('{"answer":"x","supporting":[0],"refused":false,"refusal_reason":42}');
    expect(r.refused).toBe(false);
    expect(r.answer).toBe("x");
    expect(r.refusal_reason).toBeNull();
  });
});

describe("toClauseCard", () => {
  it("maps supporting indices to exact candidate spans", () => {
    const card = toClauseCard("What law governs?", { answer: "NY law.", supporting: [0], refused: false }, cands);
    expect(card.refused).toBe(false);
    expect(card.citations).toEqual([{ doc_id: "d", char_start: 0, char_end: 25, quote: "Governed by New York law." }]);
  });

  it("drops out-of-range / duplicate indices and refuses when none remain", () => {
    const card = toClauseCard("q", { answer: "x", supporting: [9, 9], refused: false }, cands);
    expect(card.refused).toBe(true);
    expect(card.citations).toEqual([]);
  });

  it("passes through an explicit refusal", () => {
    const card = toClauseCard("q", { answer: "", supporting: [], refused: true, refusal_reason: "nope" }, cands);
    expect(card).toMatchObject({ refused: true, citations: [], answer: "" });
    expect(card.refusal_reason).toBe("nope");
  });
});
