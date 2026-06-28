import { describe, it, expect, vi } from "vitest";
import { makeOpenAICompatGenerator, resolveMinIntervalMs } from "../src/generate/openaiCompat.js";
import type { Candidate } from "../src/retrieve/retrieve.js";

const cands: Candidate[] = [
  { node_id: "d::0", doc_id: "d", type: "section", number: null, heading: null, text: "Governed by NY law.", char_start: 0, char_end: 19, score: 0.9 },
];

describe("makeOpenAICompatGenerator", () => {
  it("sends model + system/user messages and parses the JSON response into RawGen", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '{"answer":"NY law.","supporting":[0],"refused":false}' } }],
    });
    const gen = makeOpenAICompatGenerator({ client: { chat: { completions: { create } } }, model: "test-model" });
    const raw = await gen.generate({ objective: "What law governs?", candidates: cands });

    expect(raw).toMatchObject({ answer: "NY law.", supporting: [0], refused: false });
    const arg = create.mock.calls[0][0];
    expect(arg.model).toBe("test-model");
    expect(arg.messages[0].role).toBe("system");
    expect(arg.messages[1].content).toContain("[0]");
  });

  it("returns a refusal when the response is unparseable", async () => {
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: "garbage" } }] });
    const gen = makeOpenAICompatGenerator({ client: { chat: { completions: { create } } }, model: "m" });
    const raw = await gen.generate({ objective: "q", candidates: cands });
    expect(raw.refused).toBe(true);
  });

  it("paces successive requests by at least minIntervalMs", async () => {
    const callTimes: number[] = [];
    const create = vi.fn().mockImplementation(async () => {
      callTimes.push(Date.now());
      return { choices: [{ message: { content: '{"answer":"a","supporting":[0],"refused":false}' } }] };
    });
    const gen = makeOpenAICompatGenerator({
      client: { chat: { completions: { create } } },
      model: "m",
      minIntervalMs: 40,
    });
    await gen.generate({ objective: "q", candidates: cands });
    await gen.generate({ objective: "q", candidates: cands });
    expect(callTimes).toHaveLength(2);
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(35);
  });
});

describe("resolveMinIntervalMs", () => {
  it("derives the inter-request interval from LLM_RPM", () => {
    expect(resolveMinIntervalMs({ LLM_RPM: "40" })).toBe(1500);
  });

  it("lets LLM_MIN_INTERVAL_MS override LLM_RPM", () => {
    expect(resolveMinIntervalMs({ LLM_RPM: "40", LLM_MIN_INTERVAL_MS: "250" })).toBe(250);
  });

  it("returns 0 (no throttle) when unset or invalid", () => {
    expect(resolveMinIntervalMs({})).toBe(0);
    expect(resolveMinIntervalMs({ LLM_RPM: "abc" })).toBe(0);
    expect(resolveMinIntervalMs({ LLM_RPM: "0" })).toBe(0);
  });
});
