import { describe, it, expect } from "vitest";
import { streamAnswer, sseEncode } from "../src/serve/answerStream.js";
import type { AnswerEvent, AnswerDeps } from "../src/serve/answerStream.js";
import { toClauseCard } from "../src/generate/toClauseCard.js";
import type { Candidate } from "../src/retrieve/retrieve.js";
import type { RawGen } from "../src/generate/types.js";

/** Drain an async generator into an array. */
async function collect(gen: AsyncGenerator<AnswerEvent>): Promise<AnswerEvent[]> {
  const events: AnswerEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

const CANDIDATE: Candidate = {
  node_id: "doc1::0",
  doc_id: "doc1",
  type: "section",
  number: "1",
  heading: null,
  text: "Confidentiality lasts five years.",
  char_start: 0,
  char_end: 33,
  score: 0.95,
};

const RAW_GEN: RawGen = {
  answer: "Five years.",
  supporting: [0],
  refused: false,
  refusal_reason: null,
};

const RAW_REFUSED: RawGen = {
  answer: "",
  supporting: [],
  refused: true,
  refusal_reason: "insufficient context",
};

describe("streamAnswer — happy path", () => {
  it("yields status(retrieving), status(generating), card, done in order", async () => {
    const deps: AnswerDeps = {
      retrieve: async () => [CANDIDATE],
      generate: async () => RAW_GEN,
    };

    const events = await collect(streamAnswer("What is the confidentiality period?", "doc1", deps));

    // Correct sequence of types
    expect(events.map((e) => e.type)).toEqual(["status", "status", "card", "done"]);

    // Phase assertions
    const [s1, s2] = events as [
      { type: "status"; phase: string; message: string },
      { type: "status"; phase: string; message: string },
      ...AnswerEvent[]
    ];
    expect(s1.phase).toBe("retrieving");
    expect(s2.phase).toBe("generating");

    // Card deep-equals toClauseCard output
    const cardEvent = events[2] as { type: "card"; card: ReturnType<typeof toClauseCard> };
    const expected = toClauseCard("What is the confidentiality period?", RAW_GEN, [CANDIDATE]);
    expect(cardEvent.card).toEqual(expected);

    // No error event
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("uses k=8 by default (retrieve is called with k=8)", async () => {
    let capturedK: number | undefined;
    const deps: AnswerDeps = {
      retrieve: async (_obj, _doc, k) => {
        capturedK = k;
        return [CANDIDATE];
      },
      generate: async () => RAW_GEN,
    };
    await collect(streamAnswer("q", "doc1", deps));
    expect(capturedK).toBe(8);
  });

  it("respects a custom k", async () => {
    let capturedK: number | undefined;
    const deps: AnswerDeps = {
      retrieve: async (_obj, _doc, k) => {
        capturedK = k;
        return [CANDIDATE];
      },
      generate: async () => RAW_GEN,
    };
    await collect(streamAnswer("q", "doc1", deps, 3));
    expect(capturedK).toBe(3);
  });
});

describe("streamAnswer — refusal", () => {
  it("card.refused is true, sequence ends with done, no error event", async () => {
    const deps: AnswerDeps = {
      retrieve: async () => [CANDIDATE],
      generate: async () => RAW_REFUSED,
    };

    const events = await collect(streamAnswer("What is the penalty?", "doc1", deps));
    expect(events.map((e) => e.type)).toEqual(["status", "status", "card", "done"]);

    const cardEvent = events[2] as { type: "card"; card: ReturnType<typeof toClauseCard> };
    expect(cardEvent.card.refused).toBe(true);

    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});

describe("streamAnswer — error path", () => {
  it("retrieve throws → yields status, error, done and does NOT rethrow", async () => {
    const deps: AnswerDeps = {
      retrieve: async () => {
        throw new Error("db connection failed");
      },
      generate: async () => RAW_GEN,
    };

    const events = await collect(streamAnswer("q", "doc1", deps));

    // Must not throw — collect() completing is the proof.
    // Must contain an error event
    const errorEvents = events.filter((e) => e.type === "error") as Array<{ type: "error"; message: string }>;
    expect(errorEvents.length).toBeGreaterThan(0);
    expect(errorEvents[0].message).toBe("db connection failed");

    // Last event must be done
    expect(events[events.length - 1].type).toBe("done");

    // Sequence: status(retrieving), error, done
    expect(events[0]).toMatchObject({ type: "status", phase: "retrieving" });
  });

  it("generate throws → yields status, status, error, done and does NOT rethrow", async () => {
    const deps: AnswerDeps = {
      retrieve: async () => [CANDIDATE],
      generate: async () => {
        throw new Error("model timeout");
      },
    };

    const events = await collect(streamAnswer("q", "doc1", deps));

    const errorEvents = events.filter((e) => e.type === "error") as Array<{ type: "error"; message: string }>;
    expect(errorEvents.length).toBeGreaterThan(0);
    expect(errorEvents[0].message).toBe("model timeout");

    expect(events[events.length - 1].type).toBe("done");
  });

  it("non-Error thrown object is stringified into message", async () => {
    const deps: AnswerDeps = {
      retrieve: async () => {
        throw "string error";
      },
      generate: async () => RAW_GEN,
    };

    const events = await collect(streamAnswer("q", "doc1", deps));
    const errorEvents = events.filter((e) => e.type === "error") as Array<{ type: "error"; message: string }>;
    expect(errorEvents[0].message).toBe("string error");
  });
});

describe("sseEncode", () => {
  it("card event: starts with 'event: card\\n', has one data line, ends with '\\n\\n'", () => {
    const cardEvent: AnswerEvent = {
      type: "card",
      card: toClauseCard("q", RAW_GEN, [CANDIDATE]),
    };
    const encoded = sseEncode(cardEvent);

    expect(encoded.startsWith("event: card\n")).toBe(true);
    expect(encoded.endsWith("\n\n")).toBe(true);

    const lines = encoded.split("\n");
    const dataLines = lines.filter((l) => l.startsWith("data: "));
    expect(dataLines.length).toBe(1);

    // Round-trip: JSON.parse of the data value equals the event object
    const payload = JSON.parse(dataLines[0].slice("data: ".length));
    expect(payload).toEqual(cardEvent);
  });

  it("done event encodes correctly", () => {
    const event: AnswerEvent = { type: "done" };
    const encoded = sseEncode(event);
    expect(encoded).toBe(`event: done\ndata: ${JSON.stringify(event)}\n\n`);
  });

  it("status event encodes correctly", () => {
    const event: AnswerEvent = { type: "status", phase: "retrieving", message: "Retrieving clauses…" };
    const encoded = sseEncode(event);
    expect(encoded).toBe(`event: status\ndata: ${JSON.stringify(event)}\n\n`);
    // No trailing spaces
    expect(encoded).not.toMatch(/ \n/);
  });

  it("error event encodes correctly", () => {
    const event: AnswerEvent = { type: "error", message: "boom" };
    const encoded = sseEncode(event);
    expect(encoded).toBe(`event: error\ndata: ${JSON.stringify(event)}\n\n`);
  });
});
