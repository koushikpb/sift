import { describe, it, expect, vi } from "vitest";
import { makeAnthropicGenerator } from "../src/generate/anthropic.js";
import type { Candidate } from "../src/retrieve/retrieve.js";

const cands: Candidate[] = [
  { node_id: "d::0", doc_id: "d", type: "section", number: null, heading: null, text: "Governed by NY law.", char_start: 0, char_end: 19, score: 0.9 },
];

describe("makeAnthropicGenerator", () => {
  it("sends model + system + user message and parses the response into RawGen", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"answer":"NY law.","supporting":[0],"refused":false}' }],
    });
    const gen = makeAnthropicGenerator({ client: { messages: { create } }, model: "claude-sonnet-4-6" });
    const raw = await gen.generate({ objective: "What law governs?", candidates: cands });

    expect(raw).toMatchObject({ answer: "NY law.", supporting: [0], refused: false });
    const arg = create.mock.calls[0][0];
    expect(arg.model).toBe("claude-sonnet-4-6");
    expect(typeof arg.system).toBe("string");
    expect(arg.messages[0].content).toContain("[0]");
  });
});
