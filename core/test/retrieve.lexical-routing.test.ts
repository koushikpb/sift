import { describe, it, expect, vi } from "vitest";

vi.mock("../src/retrieve/lexical.js", () => ({
  lexicalRetrieve: vi.fn(async () => [
    { node_id: "LEXICAL", doc_id: "d", type: "section", number: null, heading: null, text: "", char_start: 0, char_end: 0, score: 0 },
  ]),
}));

import { makeRetriever } from "../src/retrieve/retrieve.js";
import { lexicalRetrieve } from "../src/retrieve/lexical.js";

describe("makeRetriever lexical routing", () => {
  it("routes lexical mode to lexicalRetrieve with (query, docId, k)", async () => {
    const out = await makeRetriever("lexical")("q", "d", 3);
    expect(lexicalRetrieve as any).toHaveBeenCalledWith("q", "d", 3);
    expect(out[0].node_id).toBe("LEXICAL");
  });
});
