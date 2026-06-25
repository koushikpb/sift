import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { withClient, pool } from "../src/db/client.js";
import { validateEvalSet } from "../src/eval/validate.js";
import type { EvalItem } from "../src/eval/evalItem.js";

const raw = "Governing law: State of Delaware. Term is perpetual.";

function item(over: Partial<EvalItem>): EvalItem {
  return {
    id: "i1", doc_id: "evaltest_1", source: "cuad", contract_type: "unknown",
    category: "clean", objective: "x", expected_fields: [], expected_flags: [],
    gold_spans: [], grader: "span_match", notes: "", ...over,
  };
}

describe("validateEvalSet", () => {
  beforeAll(async () => {
    await migrate();
    await withClient(async (c) => {
      await c.query("DELETE FROM documents WHERE doc_id='evaltest_1'");
      await c.query(
        `INSERT INTO documents (doc_id, source, title, contract_type, raw_text, char_length, raw_sha256)
         VALUES ('evaltest_1','cuad','T','unknown',$1,$2,$3)`,
        [raw, raw.length, "a".repeat(64)],
      );
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("flags a gold span whose quote does not match the loaded document", async () => {
    const bad = item({
      gold_spans: [{ doc_id: "evaltest_1", char_start: 0, char_end: 5, quote: "WRONG" }],
    });
    const r = await validateEvalSet([bad], { minItems: 1, requireRefusal: false, requireAllCategories: false });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/does not match/i);
  });

  it("flags a gold span pointing at an unknown document", async () => {
    const bad = item({
      doc_id: "ghost", gold_spans: [{ doc_id: "ghost", char_start: 0, char_end: 1, quote: "G" }],
    });
    const r = await validateEvalSet([bad], { minItems: 1, requireRefusal: false, requireAllCategories: false });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/unknown document/i);
  });

  it("passes a correct span and reports category stats", async () => {
    const good = item({
      gold_spans: [{ doc_id: "evaltest_1", char_start: 15, char_end: 32, quote: "State of Delaware" }],
    });
    const r = await validateEvalSet([good], { minItems: 1, requireRefusal: false, requireAllCategories: false });
    expect(r.ok).toBe(true);
    expect(r.stats.byCategory.clean).toBe(1);
  });

  it("fails when below the minimum item count", async () => {
    const good = item({ gold_spans: [] });
    const r = await validateEvalSet([good], { minItems: 50, requireRefusal: false, requireAllCategories: false });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/at least 50/i);
  });
});
