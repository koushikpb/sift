import { describe, it, expect } from "vitest";
import { rerankScores } from "../src/rerank/model.js";

// First run downloads the cross-encoder ONNX weights (~tens of MB), then caches them.
describe("rerankScores", () => {
  it("scores a relevant passage above an irrelevant one", async () => {
    const q = "Which state's law governs this agreement?";
    const [relevant, irrelevant] = await rerankScores(q, [
      "This Agreement shall be governed by the laws of the State of New York.",
      "The cafeteria serves lunch between noon and 2pm on weekdays.",
    ]);
    expect(relevant).toBeGreaterThan(irrelevant);
  }, 120_000);

  it("returns [] for no passages", async () => {
    expect(await rerankScores("q", [])).toEqual([]);
  });
});
