import { describe, it, expect } from "vitest";
import { embedTexts, EMBED_DIM } from "../src/embed/model.js";

// First run downloads the bge-large-en-v1.5 ONNX weights (~hundreds of MB), then caches them.
describe("embedTexts", () => {
  it("returns one L2-normalized 1024-d vector per text", async () => {
    const vecs = await embedTexts(["confidential information"], { kind: "passage" });
    expect(vecs).toHaveLength(1);
    expect(vecs[0]).toHaveLength(EMBED_DIM);
    const norm = Math.sqrt(vecs[0].reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 2);
  }, 120_000);

  it("applies the query instruction only to queries (query != passage embedding)", async () => {
    const [q] = await embedTexts(["governing law"], { kind: "query" });
    const [p] = await embedTexts(["governing law"], { kind: "passage" });
    expect(q).not.toEqual(p);
  }, 120_000);

  it("loads a second registry model (mxbai) → normalized 1024-d, distinct from bge", async () => {
    const [m] = await embedTexts(["governing law"], { kind: "passage", model: "mxbai-embed-large-v1" });
    expect(m).toHaveLength(EMBED_DIM);
    const norm = Math.sqrt(m.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 2);
    const [b] = await embedTexts(["governing law"], { kind: "passage", model: "bge-large-en-v1.5" });
    expect(m).not.toEqual(b);
  }, 300_000);
});
