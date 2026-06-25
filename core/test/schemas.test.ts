import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ParsedDocumentSchema } from "../src/schemas/parsedDocument.js";
import { GoldLabelSchema } from "../src/schemas/goldLabel.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(root + p, "utf-8"));

describe("artifact schemas (TS) match the shared examples", () => {
  it("parses the parsed-document example and enforces the citation invariant", () => {
    const doc = ParsedDocumentSchema.parse(read("/schemas/examples/parsed-document.example.json"));
    for (const n of doc.nodes) {
      expect(doc.raw_text.slice(n.char_start, n.char_end)).toBe(n.text);
    }
  });
  it("parses the gold-label example", () => {
    const label = GoldLabelSchema.parse(read("/schemas/examples/gold-label.example.json"));
    expect(label.spans[0].quote).toBe("ARTICLE I TERM");
  });
});
