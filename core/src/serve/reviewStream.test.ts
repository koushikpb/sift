import { describe, it, expect, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { streamReview } from "./reviewStream.js";
import type { ReviewEvent } from "./reviewStream.js";
import type { ReviewDeps } from "../agent/reviewAgent.js";
import { makeRetrieveClauseTool } from "../agent/tools/retrieveClause.js";
import { makeClassifyClauseTool } from "../agent/tools/classifyClause.js";
import { makeFlagRisksTool } from "../agent/tools/flagRisks.js";
import { makeDraftRedlineTool } from "../agent/tools/draftRedline.js";
import { makeExportMemoTool } from "../agent/tools/exportMemo.js";
import { loadPlaybook } from "../eval/playbook.js";
import type { Candidate } from "../retrieve/retrieve.js";

const entries = loadPlaybook(fileURLToPath(new URL("../../../evals/playbook/nda.yaml", import.meta.url)));

// The candidate's span must resolve exactly against `rawText` — this is what the citation
// invariant test checks (quote === rawText.slice(char_start, char_end)).
const rawText = "Obligations are perpetual. This is filler contract text that follows the clause.";
const cand: Candidate = {
  node_id: "n0",
  doc_id: "d1",
  type: "section",
  number: null,
  heading: null,
  text: rawText.slice(0, 26),
  char_start: 0,
  char_end: 26,
  score: 1,
};

type ClauseEvent = Extract<ReviewEvent, { type: "clause" }>;

function isClause(e: ReviewEvent): e is ClauseEvent {
  return e.type === "clause";
}

function makeDeps(opts: { refuse: boolean; deviation: boolean }): { writes: string[]; deps: ReviewDeps } {
  const writes: string[] = [];
  const deps: ReviewDeps = {
    playbook: entries,
    retrieveClause: makeRetrieveClauseTool({
      retrieve: async () => [cand],
      generate: async () =>
        opts.refuse
          ? { answer: "", supporting: [], refused: true, refusal_reason: "n/a" }
          : { answer: "perpetual term", supporting: [0], refused: false, refusal_reason: null },
    }),
    classifyClause: makeClassifyClauseTool({
      runPredict: async (texts) =>
        texts.map((t) => ({ text: t, label: "Term / Duration of Confidentiality", score: 0.9 })),
    }),
    flagRisks: makeFlagRisksTool(
      { judge: async () => ({ deviation: opts.deviation, rationale: "perpetual" }) },
      entries,
    ),
    draftRedline: makeDraftRedlineTool({ suggest: async () => "Three (3) year term." }),
    exportMemo: makeExportMemoTool({
      writeFile: async (p) => {
        writes.push(p);
      },
    }),
  };
  return { writes, deps };
}

async function collect(gen: AsyncGenerator<ReviewEvent>): Promise<ReviewEvent[]> {
  const events: ReviewEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

const objectiveConfidentialityTerm = "Assess the confidentiality term (playbook requires confidentiality_term)";
const objectiveOutOfScope = "Find the arbitration seat";
const generatedAt = "2026-07-01T00:00:00Z";

describe("streamReview", () => {
  it("yields >=1 clause event whose citation.quote is grounded in the raw text", async () => {
    const { deps } = makeDeps({ refuse: false, deviation: true });
    const events = await collect(streamReview(objectiveConfidentialityTerm, "d1", deps, { generatedAt }));

    const clauseEvents = events.filter(isClause);
    expect(clauseEvents.length).toBeGreaterThanOrEqual(1);

    const grounded = clauseEvents.find((e) => e.citation !== null);
    expect(grounded).toBeDefined();
    const citation = grounded!.citation!;
    expect(citation.quote).toBe(rawText.slice(citation.char_start, citation.char_end));

    // The clause card carries flag/severity, LoRA label, and a redline for the deviation.
    expect(grounded!.flag).not.toBeNull();
    expect(grounded!.flag!.severity).toBeDefined();
    expect(grounded!.classification).toEqual({ clause_type: "Term / Duration of Confidentiality", score: 0.9 });
    expect(grounded!.redline).not.toBeNull();

    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events[events.length - 1]).toEqual({ type: "done" });
  });

  it("yields a refusal-style clause event (not an error) when retrieval is ungrounded", async () => {
    const { deps } = makeDeps({ refuse: true, deviation: false });
    const events = await collect(streamReview(objectiveOutOfScope, "d1", deps, { generatedAt }));

    const clauseEvents = events.filter(isClause);
    expect(clauseEvents).toHaveLength(1);
    expect(clauseEvents[0].refused).toBe(true);
    expect(clauseEvents[0].citation).toBeNull();
    expect(clauseEvents[0].refusal_reason).toBeTruthy();

    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events[events.length - 1]).toEqual({ type: "done" });
  });

  it("never triggers a write: export_memo's writer is never invoked (HITL gate — confirm is never true)", async () => {
    const { writes, deps } = makeDeps({ refuse: false, deviation: true });
    const events = await collect(streamReview(objectiveConfidentialityTerm, "d1", deps, { generatedAt }));

    expect(writes).toHaveLength(0);
    expect(events.filter(isClause).length).toBeGreaterThan(0);
  });

  it("a system failure (tool throws) yields a generic error message to the stream, logs the real one server-side (F1)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sensitiveMessage = "connect ECONNREFUSED postgres://sift:s3cr3t@db.internal:5432/sift";

    const { deps: baseDeps } = makeDeps({ refuse: false, deviation: true });
    const deps: ReviewDeps = {
      ...baseDeps,
      // Stand in for a system failure deep in the trajectory (DB error, SDK error echoing the LLM
      // base URL/model, an invariant throw) — none of it should reach the client verbatim.
      retrieveClause: makeRetrieveClauseTool({
        retrieve: async () => {
          throw new Error(sensitiveMessage);
        },
        generate: async () => ({ answer: "", supporting: [], refused: false, refusal_reason: null }),
      }),
    };

    const events = await collect(streamReview(objectiveConfidentialityTerm, "d1", deps, { generatedAt }));

    const errorEvents = events.filter((e): e is Extract<ReviewEvent, { type: "error" }> => e.type === "error");
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].message).toBe("review failed — try again");
    expect(errorEvents[0].message).not.toContain("postgres://");
    expect(errorEvents[0].message).not.toContain("s3cr3t");

    // The full stream still terminates with `done`, same as every other path.
    expect(events[events.length - 1]).toEqual({ type: "done" });

    // The real error is still observable server-side, just not sent to the client.
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("streamReview"),
      expect.objectContaining({ message: sensitiveMessage }),
    );

    consoleErrorSpy.mockRestore();
  });
});
