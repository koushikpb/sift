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

describe("optional fields seam contract — omitted fields must parse", () => {
  const RAW_SHA256 = "a".repeat(64); // 64 hex chars

  it("ParsedDocument: omitting optional `title` still parses", () => {
    const doc = {
      doc_id: "test-doc-1",
      source: "cuad",
      contract_type: "NDA",
      raw_text: "Sample text",
      char_length: 11,
      raw_sha256: RAW_SHA256,
      nodes: [],
    };
    // title is absent — schema must not require it
    expect(() => ParsedDocumentSchema.parse(doc)).not.toThrow();
    const parsed = ParsedDocumentSchema.parse(doc);
    expect(parsed.title).toBeUndefined();
  });

  it("GoldLabel: omitting optional `clause_type`, `hypothesis`, `nli_label` still parses", () => {
    const label = {
      label_id: "lbl-1",
      doc_id: "test-doc-1",
      source: "cuad",
      kind: "clause_span",
      spans: [],
    };
    // clause_type, hypothesis, nli_label are absent — schema must not require them
    expect(() => GoldLabelSchema.parse(label)).not.toThrow();
    const parsed = GoldLabelSchema.parse(label);
    expect(parsed.clause_type).toBeUndefined();
    expect(parsed.hypothesis).toBeUndefined();
    expect(parsed.nli_label).toBeUndefined();
  });
});
