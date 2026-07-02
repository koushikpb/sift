import { describe, it, expect } from "vitest";
import { makeClassifyClauseTool, PredictionSchema } from "../src/agent/tools/classifyClause.js";

describe("classify_clause tool", () => {
  it("returns the label + score from the injected predictor", async () => {
    const tool = makeClassifyClauseTool({
      runPredict: async (texts) => texts.map((t) => ({ text: t, label: "Governing Law", score: 0.97 })),
    });
    const out = await tool.run({ text: "governed by the laws of Delaware" });
    expect(out).toEqual({ clause_type: "Governing Law", score: 0.97 });
  });

  it("throws if the bridge returns no prediction for the input", async () => {
    const tool = makeClassifyClauseTool({ runPredict: async () => [] });
    await expect(tool.run({ text: "x" })).rejects.toThrow(/no prediction/i);
  });

  it("PredictionSchema rejects a malformed prediction", () => {
    expect(() => PredictionSchema.parse({ text: "x", label: "y" })).toThrow();
  });
});
