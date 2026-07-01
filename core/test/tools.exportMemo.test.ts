import { describe, it, expect } from "vitest";
import { makeExportMemoTool, renderMemoMarkdown } from "../src/agent/tools/exportMemo.js";
import type { ReviewMemo } from "../src/agent/tools/types.js";

const memo: ReviewMemo = {
  doc_id: "d1", objective: "Review NDA", generated_at: "2026-06-30T00:00:00Z",
  fields: [{ name: "Governing Law", value: "Delaware", citation: { doc_id: "d1", char_start: 0, char_end: 8, quote: "Delaware" } }],
  flags: [{ playbook_id: "confidentiality_term", clause_type: "Term", severity: "high", deviation: true, rationale: "perpetual", citation: { doc_id: "d1", char_start: 0, char_end: 8, quote: "Delaware" } }],
  redlines: [],
};

describe("export_memo tool (HITL gate)", () => {
  it("does NOT write without confirm — returns a preview", async () => {
    const writes: string[] = [];
    const tool = makeExportMemoTool({ writeFile: async (p) => { writes.push(p); } });
    const res = await tool.run({ memo });
    expect(res.written).toBe(false);
    expect(res.path).toBeNull();
    expect(res.markdown).toContain("confidentiality_term");
    expect(writes).toHaveLength(0);          // the gate held — nothing hit disk
  });

  it("writes exactly once when confirm === true", async () => {
    const writes: { path: string; body: string }[] = [];
    const tool = makeExportMemoTool({ writeFile: async (path, body) => { writes.push({ path, body }); } });
    const res = await tool.run({ memo, confirm: true, out_dir: "/tmp/reviews" });
    expect(res.written).toBe(true);
    expect(res.path).toBe("/tmp/reviews/d1-2026-06-30T00:00:00Z.md");
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toContain("perpetual");
  });

  it("declares itself a write tool", () => {
    const tool = makeExportMemoTool({ writeFile: async () => {} });
    expect(tool.sideEffect).toBe("write");
  });

  it("renderMemoMarkdown lists flags and fields", () => {
    const md = renderMemoMarkdown(memo);
    expect(md).toContain("# Contract Review Memo");
    expect(md).toContain("Governing Law");
    expect(md).toContain("high");
  });

  it("renders a missing-clause flag (null citation) as missing", () => {
    const md = renderMemoMarkdown({ ...memo, flags: [{ playbook_id: "return_of_materials", clause_type: "Return or Destruction", severity: "low", deviation: true, rationale: "absent", citation: null }] });
    expect(md).toContain("clause not found — missing");
  });
});
