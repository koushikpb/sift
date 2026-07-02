/**
 * Unit tests for core/src/db/clauseLabels.ts and clauseLabelRow.ts.
 *
 * A minimal mock PoolClient is injected so no live Postgres is required.
 * The tests verify:
 *   - getClauseLabel returns the stored {label,score} for a known span
 *   - getClauseLabel returns null for an absent span
 *   - upsertClauseLabel issues the correct parameterised query
 *   - ClauseLabelRowSchema rejects invalid rows (mirrors schemas/clause-label.schema.json)
 */
import { describe, it, expect, vi } from "vitest";
import type { PoolClient } from "pg";
import { getClauseLabel, upsertClauseLabel } from "../src/db/clauseLabels.js";
import { ClauseLabelRowSchema } from "../src/db/clauseLabelRow.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal PoolClient mock where query() resolves with the given rows. */
function makeClient(rows: Record<string, unknown>[]): PoolClient {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
  } as unknown as PoolClient;
}

// ---------------------------------------------------------------------------
// getClauseLabel
// ---------------------------------------------------------------------------

describe("getClauseLabel", () => {
  it("returns the stored row for a known span", async () => {
    const client = makeClient([{ label: "Governing Law", score: 0.97 }]);
    const result = await getClauseLabel(client, "contractnli_1", 100, 200);
    expect(result).toEqual({ label: "Governing Law", score: 0.97 });
  });

  it("returns null when no row is found for the span", async () => {
    const client = makeClient([]);
    const result = await getClauseLabel(client, "contractnli_1", 0, 50);
    expect(result).toBeNull();
  });

  it("passes the correct parameters to the query", async () => {
    const client = makeClient([{ label: "Confidentiality", score: 0.88 }]);
    await getClauseLabel(client, "contractnli_4", 18, 40);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("clause_labels"),
      ["contractnli_4", 18, 40],
    );
  });
});

// ---------------------------------------------------------------------------
// upsertClauseLabel
// ---------------------------------------------------------------------------

describe("upsertClauseLabel", () => {
  it("calls query with all five values", async () => {
    const client = makeClient([]);
    await upsertClauseLabel(client, "contractnli_6", 55, 120, "Termination", 0.91);
    expect(client.query).toHaveBeenCalledOnce();
    const [sql, params] = (client.query as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(sql).toMatch(/INSERT/i);
    expect(sql).toMatch(/ON CONFLICT/i);
    expect(params).toEqual(["contractnli_6", 55, 120, "Termination", 0.91]);
  });
});

// ---------------------------------------------------------------------------
// ClauseLabelRowSchema — mirrors schemas/clause-label.schema.json
// ---------------------------------------------------------------------------

const validRow = {
  doc_id: "contractnli_4",
  char_start: 18,
  char_end: 40,
  label: "Confidentiality",
  score: 0.97,
};

describe("ClauseLabelRowSchema", () => {
  it("accepts a valid row", () => {
    expect(() => ClauseLabelRowSchema.parse(validRow)).not.toThrow();
  });

  it("rejects score > 1", () => {
    expect(() => ClauseLabelRowSchema.parse({ ...validRow, score: 1.5 })).toThrow();
  });

  it("rejects score < 0", () => {
    expect(() => ClauseLabelRowSchema.parse({ ...validRow, score: -0.1 })).toThrow();
  });

  it("rejects char_end equal to char_start", () => {
    expect(() =>
      ClauseLabelRowSchema.parse({ ...validRow, char_start: 18, char_end: 18 }),
    ).toThrow();
  });

  it("rejects char_end less than char_start", () => {
    expect(() =>
      ClauseLabelRowSchema.parse({ ...validRow, char_start: 40, char_end: 10 }),
    ).toThrow();
  });

  it("rejects empty doc_id", () => {
    expect(() => ClauseLabelRowSchema.parse({ ...validRow, doc_id: "" })).toThrow();
  });

  it("rejects empty label", () => {
    expect(() => ClauseLabelRowSchema.parse({ ...validRow, label: "" })).toThrow();
  });

  it("rejects extra properties (strict)", () => {
    expect(() => ClauseLabelRowSchema.parse({ ...validRow, extra: "oops" })).toThrow();
  });
});
