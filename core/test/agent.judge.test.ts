import { describe, it, expect, vi } from "vitest";
import { judgeSufficiency } from "../src/agent/judge.js";
import type { Candidate } from "../src/retrieve/types.js";

function cand(id: string, text = id): Candidate {
  return { node_id: id, doc_id: "d", type: "section", number: null, heading: null, text, char_start: 0, char_end: text.length, score: 0 };
}
const cands = [cand("a", "Governed by NY law.")];

function fakeClient(content: string) {
  return { chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content } }] }) } } };
}

describe("judgeSufficiency", () => {
  it("parses a sufficient verdict (no reformulations)", async () => {
    const v = await judgeSufficiency("q", cands, { client: fakeClient('{"sufficient":true,"reformulations":[]}'), model: "m", minIntervalMs: 0 });
    expect(v).toEqual({ sufficient: true, reformulations: [] });
  });

  it("parses an insufficient verdict and trims + caps reformulations at 3", async () => {
    const v = await judgeSufficiency("q", cands, {
      client: fakeClient('{"sufficient":false,"reformulations":["  governing law  ","jurisdiction","choice of law","extra"]}'),
      model: "m", minIntervalMs: 0,
    });
    expect(v.sufficient).toBe(false);
    expect(v.reformulations).toEqual(["governing law", "jurisdiction", "choice of law"]);
  });

  it("tolerates prose around the JSON object", async () => {
    const v = await judgeSufficiency("q", cands, { client: fakeClient('Sure:\n{"sufficient":false,"reformulations":["x"]} done'), model: "m", minIntervalMs: 0 });
    expect(v).toEqual({ sufficient: false, reformulations: ["x"] });
  });

  it("degrades to sufficient when the response is unparseable", async () => {
    const v = await judgeSufficiency("q", cands, { client: fakeClient("garbage, no json"), model: "m", minIntervalMs: 0 });
    expect(v).toEqual({ sufficient: true, reformulations: [] });
  });

  it("degrades to sufficient when the client call throws", async () => {
    const client = { chat: { completions: { create: vi.fn().mockRejectedValue(new Error("network")) } } };
    const v = await judgeSufficiency("q", cands, { client, model: "m", minIntervalMs: 0 });
    expect(v).toEqual({ sufficient: true, reformulations: [] });
  });

  it("sends the objective and numbered candidates to the model", async () => {
    const client = fakeClient('{"sufficient":true,"reformulations":[]}');
    await judgeSufficiency("What law governs?", cands, { client, model: "m", minIntervalMs: 0 });
    const arg = (client.chat.completions.create as any).mock.calls[0][0];
    expect(arg.model).toBe("m");
    expect(arg.messages[0].role).toBe("system");
    expect(arg.messages[1].content).toContain("What law governs?");
    expect(arg.messages[1].content).toContain("[0]");
  });
});
