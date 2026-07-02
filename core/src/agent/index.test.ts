import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReviewDeps, resolvePlaybookPath } from "./index.js";
import type { RetrieveClauseInput } from "./tools/retrieveClause.js";
import type { Candidate } from "../retrieve/retrieve.js";
import type { ClauseLabel } from "../db/clauseLabels.js";
import type { ReviewMemo } from "./tools/types.js";

// Fixture mirrors reviewStream.test.ts: the candidate's own `text` is what toClauseCard uses to
// build the citation's `quote`, so this is the string classify_clause's declared `text` input
// must match against the closure-captured citation for the "match" path to succeed.
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

function makeIo() {
  return {
    retrieve: async () => [cand],
    generate: async () => ({ answer: "perpetual term", supporting: [0], refused: false, refusal_reason: null }),
  };
}

const retrieveInput: RetrieveClauseInput = { objective: "Assess the term", doc_id: "d1" };

describe("buildReviewDeps — classify_clause contract enforcement (F1)", () => {
  it("classifies via the injected lookup when input.text matches the just-retrieved citation", async () => {
    const label: ClauseLabel = { label: "Term / Duration of Confidentiality", score: 0.88 };
    const lookupClauseLabel = vi.fn(async () => label);
    const deps = buildReviewDeps("d1", makeIo(), 8, lookupClauseLabel);

    const card = await deps.retrieveClause.run(retrieveInput);
    const quote = card.citations[0].quote;
    expect(quote).toBe(rawText.slice(0, 26)); // sanity: matches the grounded span

    const result = await deps.classifyClause.run({ text: quote });
    expect(result).toEqual({ clause_type: label.label, score: label.score });
    expect(lookupClauseLabel).toHaveBeenCalledWith("d1", 0, 26);
  });

  it("throws instead of silently classifying when input.text does not match the retrieved citation", async () => {
    const lookupClauseLabel = vi.fn(async (): Promise<ClauseLabel | null> => {
      throw new Error("lookupClauseLabel should never be called on a mismatch");
    });
    const deps = buildReviewDeps("d1", makeIo(), 8, lookupClauseLabel);

    await deps.retrieveClause.run(retrieveInput); // sets the closure's lastCitation to the d1 span

    await expect(deps.classifyClause.run({ text: "a completely different clause" })).rejects.toThrow(
      /does not match|ordering invariant/i,
    );
    expect(lookupClauseLabel).not.toHaveBeenCalled();
  });

  it("returns unclassified without calling the lookup when no clause has been retrieved yet", async () => {
    const lookupClauseLabel = vi.fn(async (): Promise<ClauseLabel | null> => {
      throw new Error("should not be called");
    });
    const deps = buildReviewDeps("d1", makeIo(), 8, lookupClauseLabel);

    const result = await deps.classifyClause.run({ text: "anything" });
    expect(result).toEqual({ clause_type: "unclassified", score: 0 });
    expect(lookupClauseLabel).not.toHaveBeenCalled();
  });
});

describe("resolvePlaybookPath — layered playbook resolution (F3)", () => {
  // A fake repo layout: <tmp>/evals/playbook/nda.yaml plus an <tmp>/app subdir, mirroring both
  // possible Vercel function cwds (function root vs. app/ within it) and local `next dev` (app/).
  const tmp = mkdtempSync(join(tmpdir(), "sift-playbook-"));
  const yamlPath = join(tmp, "evals", "playbook", "nda.yaml");
  mkdirSync(join(tmp, "evals", "playbook"), { recursive: true });
  mkdirSync(join(tmp, "app"), { recursive: true });
  writeFileSync(yamlPath, "[]\n");
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("PLAYBOOK_PATH env override always wins, even over an existing cwd candidate", () => {
    expect(resolvePlaybookPath({ PLAYBOOK_PATH: "/explicit/override.yaml" }, tmp)).toBe(
      "/explicit/override.yaml",
    );
  });

  it("resolves evals/playbook/nda.yaml relative to cwd (cwd = repo/function root)", () => {
    expect(resolvePlaybookPath({}, tmp)).toBe(yamlPath);
  });

  it("resolves ../evals/playbook/nda.yaml when cwd is one level down (cwd = app/)", () => {
    expect(resolvePlaybookPath({}, join(tmp, "app"))).toBe(yamlPath);
  });

  it("falls back to the import.meta.url-relative repo path when no probe matches", () => {
    // In this (non-bundled) test context the fallback resolves against the real repo layout.
    // This test file sits in the same directory as index.ts, so the same relative hop applies.
    const nowhere = join(tmp, "app", "deeper-dir-with-no-evals-above-it");
    mkdirSync(nowhere, { recursive: true });
    const result = resolvePlaybookPath({}, nowhere);
    expect(result).toBe(fileURLToPath(new URL("../../../evals/playbook/nda.yaml", import.meta.url)));
  });
});

describe("buildReviewDeps — export_memo HITL backstop (F4)", () => {
  const memo: ReviewMemo = {
    doc_id: "d1",
    objective: "Assess the term",
    fields: [],
    flags: [],
    redlines: [],
    generated_at: "2026-07-01T00:00:00Z",
  };

  it("throws when confirm:true is ever passed (defense-in-depth — the serve path never sets it)", async () => {
    const deps = buildReviewDeps("d1", makeIo());
    await expect(deps.exportMemo.run({ memo, confirm: true })).rejects.toThrow();
  });

  it("returns a preview (written: false) when confirm is false/unset", async () => {
    const deps = buildReviewDeps("d1", makeIo());
    const result = await deps.exportMemo.run({ memo, confirm: false });
    expect(result.written).toBe(false);
    expect(result.path).toBeNull();
    expect(result.markdown).toContain("Contract Review Memo");
  });
});
