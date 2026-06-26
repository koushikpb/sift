import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { ClauseCardSchema, assertCardCitations, type ClauseCard } from "../src/schemas/clauseCard.js";

const valid: ClauseCard = {
  objective: "Find the governing law clause.",
  answer: "Governed by New York law.",
  citations: [{ doc_id: "d1", char_start: 0, char_end: 5, quote: "ABCDE" }],
  refused: false,
  refusal_reason: null,
};

describe("ClauseCard schema", () => {
  it("accepts a valid card and rejects unknown keys", () => {
    expect(ClauseCardSchema.parse(valid)).toEqual(valid);
    expect(() => ClauseCardSchema.parse({ ...valid, oops: 1 })).toThrow();
  });

  it("conforms to the JSON Schema source of truth (Zod ⇄ JSON Schema seam)", () => {
    const schemaPath = fileURLToPath(new URL("../../schemas/clause-card.schema.json", import.meta.url));
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf-8")));
    expect(validate(valid)).toBe(true);
    expect(validate({ ...valid, oops: 1 })).toBe(false);
  });

  it("assertCardCitations throws when a quote does not match its slice", () => {
    const raw = new Map([["d1", "ABCDEFG"]]);
    expect(() => assertCardCitations(valid, raw)).not.toThrow();
    const bad: ClauseCard = { ...valid, citations: [{ doc_id: "d1", char_start: 0, char_end: 5, quote: "ZZZZZ" }] };
    expect(() => assertCardCitations(bad, raw)).toThrow(/citation/i);
  });

  it("assertCardCitations throws for an unknown doc_id", () => {
    const empty = new Map<string, string>(); // "d1" absent
    expect(() => assertCardCitations(valid, empty)).toThrow(/citation/i);
  });

  it("rejects an unknown key inside a citation Span (Zod strict)", () => {
    const badSpan = { ...valid, citations: [{ doc_id: "d1", char_start: 0, char_end: 5, quote: "ABCDE", extra: 1 }] };
    expect(() => ClauseCardSchema.parse(badSpan)).toThrow();
  });
});
