import { describe, it, expect, vi } from "vitest";

vi.mock("../src/agent/loop.js", () => ({
  agenticRetrieve: vi.fn(async () => [
    { node_id: "AGENTIC", doc_id: "d", type: "section", number: null, heading: null, text: "", char_start: 0, char_end: 0, score: 0 },
  ]),
  AGENT_DEFAULTS: { MAX_ROUNDS: 2, N: 50, M: 100, K_RRF: 60 },
}));

import { makeRetriever } from "../src/retrieve/retrieve.js";
import { agenticRetrieve } from "../src/agent/loop.js";

describe("makeRetriever agentic routing", () => {
  it("routes agentic mode to agenticRetrieve with (query, docId, k)", async () => {
    const out = await makeRetriever("agentic")("q", "d", 3);
    expect(agenticRetrieve as any).toHaveBeenCalledWith("q", "d", 3);
    expect(out[0].node_id).toBe("AGENTIC");
  });
});
