import { describe, it, expect } from "vitest";
import { buildTools } from "../src/mcp/tools.js";

describe("MCP tool registry", () => {
  const tools = buildTools({
    retrieve: async () => [],
    generate: async () => ({ answer: "", supporting: [], refused: true, refusal_reason: null }),
    runPredict: async () => [],
    judge: async () => ({ deviation: false, rationale: "" }),
    suggest: async () => "",
    writeFile: async () => {},
  });

  it("registers the RAG wrapper + five SPEC-list tools with unique names", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["classify_clause", "draft_redline", "export_memo", "extract_fields", "flag_risks", "retrieve_clause"]);
  });

  it("marks export_memo as the only write tool", () => {
    const writes = tools.filter((t) => t.sideEffect === "write").map((t) => t.name);
    expect(writes).toEqual(["export_memo"]);
  });

  it("every tool exposes a non-empty input shape and description", () => {
    for (const t of tools) {
      expect(Object.keys(t.inputShape).length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
    }
  });
});
