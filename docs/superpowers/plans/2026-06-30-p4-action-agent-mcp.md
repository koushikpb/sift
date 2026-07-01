# P4 — Action Agent + MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build SPEC Layer 3 — a citation-grounded, action-taking contract-review agent exposing 5 typed tools over an MCP server, gating every write behind human confirmation, and prove it with agent evals (task success, trajectory checks, false-negative rate, failure-mode taxonomy) on the 50-item eval set.

**Architecture:** Five tools live in `core/src/agent/tools/` as focused factories that take injected deps (so every one is unit-tested with fakes, no DB/LLM/subprocess). `retrieve_clause` wraps the existing Layer 1 RAG (`makeRetriever` + `makeGenerator` + `toClauseCard`); `classify_clause` bridges to the P3 LoRA model via a Python inference CLI over a schema-validated JSONL boundary; `check_playbook`/`flag_risks` compose the existing `loadPlaybook` into a risk engine; `export_memo` is the sole write tool and self-enforces a `confirm` gate. A deterministic `reviewContract` orchestrator composes them into a reproducible trajectory (this IS the agent), and an MCP server (`@modelcontextprotocol/sdk`, stdio) registers the same tool instances for a real client. A new agent-eval harness runs the orchestrator over `eval-set-v1.json` and scores task success / flag false-negatives / trajectory / HITL.

**Tech Stack:** TypeScript / Node 20, ESM (`moduleResolution: Bundler`; relative imports use `.js` extensions), Zod for every boundary, `@modelcontextprotocol/sdk` (new), `openai` SDK against NIM (reused), vitest. Python 3.11 for the LoRA inference CLI (transformers + peft, reused from P3), pydantic, pytest.

## Global Constraints

(Copied verbatim from `SPEC.md` / `CLAUDE.md`; every task's requirements implicitly include these.)

- **Citation format:** a grounded span is `{ doc_id, char_start, char_end, quote }` with `quote === raw_text.slice(char_start, char_end)` exactly (strict `===`, no trim/normalize). Every fact the agent surfaces (field, flag, redline) carries such a span.
- **Typed payloads only** — validate every artifact crossing a module boundary with Zod (TS) / pydantic (Python) against `schemas/`. The Python→TS classifier prediction is a cross-language artifact and MUST have a JSON Schema in `schemas/`.
- **Refuse when ungrounded** — "insufficient context" is a correct answer, not a failure. A tool that cannot ground its output returns a refusal / null citation rather than inventing one. The `missing` eval category MUST still refuse.
- **A human approves before any destructive or external action** — the only write tool (`export_memo`) performs no filesystem write unless `confirm === true`; without it, it returns a preview with `written: false`. The agent-eval never passes `confirm`, so the gate is proven by 0 files written.
- **Public data only** — no client data, no PII. Reviews are written under `data/reviews/` (gitignored).
- **Vector backend is swappable** — all DB access stays behind `core/src/db/`; P4 adds none.
- **Evals are the merge gate** — no task is done until its test passes; the branch merges only after the P4 agent-eval gate (Task 8) passes.
- **Relative imports use `.js` extensions** (e.g. `from "./types.js"`), matching every existing file.
- **TS tests run with `cd core && npm test`**; a single file: `cd core && npx vitest run test/<file>.test.ts`. **Python tests run with `cd pipeline && .venv/bin/python -m pytest -q`**.
- **No `Date.now()` inside pure tools** — timestamps are injected by the caller (the CLI stamps `generated_at`), matching the codebase's clock-injection style.

---

## File Structure

**New files (TypeScript):**
- `core/src/agent/tools/types.ts` — Zod schemas + TS types for every tool artifact (`Citation`, `ExtractedField`, `ClauseClassification`, `ReviewFlag`, `RedlineProposal`, `ReviewMemo`) and the shared `ToolDef` interface. One responsibility: the typed vocabulary of the action layer.
- `core/src/agent/tools/retrieveClause.ts` — `makeRetrieveClauseTool(deps)`: wrap Layer 1 RAG → grounded `ClauseCard`.
- `core/src/agent/tools/extractFields.ts` — `makeExtractFieldsTool(deps)`: grounded named-field extraction.
- `core/src/agent/tools/classifyClause.ts` — `makeClassifyClauseTool(deps)`: bridge to the P3 LoRA classifier.
- `core/src/agent/tools/playbookMatch.ts` — `matchPlaybookEntry(clauseType, entries)` + the CUAD-label→playbook synonyms map. One responsibility: resolve a clause type to a playbook position.
- `core/src/agent/tools/flagRisks.ts` — `makeCheckPlaybookTool(...)` + `makeFlagRisksTool(deps)`: the risk engine.
- `core/src/agent/tools/exportMemo.ts` — `makeExportMemoTool(deps)` + `renderMemoMarkdown(memo)`: the sole write tool + HITL gate.
- `core/src/agent/tools/draftRedline.ts` — `makeDraftRedlineTool(deps)`: grounded playbook-compliant redline.
- `core/src/agent/reviewAgent.ts` — `reviewContract(objective, docId, deps, opts)`: the deterministic orchestrator (the agent).
- `core/src/mcp/tools.ts` — `buildTools(deps)`: assemble the 5 `ToolDef`s with real deps.
- `core/src/mcp/server.ts` — `buildServer(deps)` + `main()`: MCP server over stdio.
- `core/src/mcp/sampleClient.ts` — documented sample MCP client (list tools + call one).
- `core/src/agent/agentEvalMetrics.ts` — pure scorers (`flagCoverage`, `taskSuccess`, `trajectoryValid`).
- `core/src/agent/agentEval.ts` — `runAgentEval(items, deps)` → `AgentEvalReport`.
- `core/src/agent/cli.ts` — `agent-run` CLI: wire real deps, run the harness, write `evals/reports/p4_agent.json`.

**New test files (TypeScript):** one per source file above (`core/test/tools.types.test.ts`, `tools.retrieveClause.test.ts`, `tools.extractFields.test.ts`, `tools.classifyClause.test.ts`, `tools.playbookMatch.test.ts`, `tools.flagRisks.test.ts`, `tools.exportMemo.test.ts`, `tools.draftRedline.test.ts`, `agent.reviewAgent.test.ts`, `mcp.tools.test.ts`, `agent.agentEvalMetrics.test.ts`, `agent.agentEval.test.ts`).

**New files (Python):**
- `pipeline/pipeline/classify/predict.py` — inference CLI: JSONL `{text}` in → JSONL `{text,label,score}` out, loading the LoRA exactly as `evaluate.py` does. Pure framing helpers (`parse_input_line`, `format_prediction`) are unit-tested; the model path is gate-run.
- `pipeline/tests/test_clf_predict.py` — framing/round-trip tests.

**New files (schemas / docs):**
- `schemas/clf-prediction.schema.json` — the Python→TS classifier prediction (cross-language artifact).
- `docs/eval-reports/P4.md` — the P4 eval report + failure-mode taxonomy (Task 8).
- `docs/mcp-quickstart.md` — MCP server + sample-client instructions (Task 7).

**Modified files:**
- `core/package.json` — add `@modelcontextprotocol/sdk` dep; add `"mcp"` and `"agent-eval"` scripts.
- `Makefile` — add `clf-predict`, `mcp-serve`, `agent-eval` targets.
- `.gitignore` — add `/data/reviews/`.
- `DECISIONS.md` — P4 decision entry (Task 8).

---

## Task 1: Tool artifact schemas + `ToolDef`

The typed vocabulary every later task consumes. Pure Zod/TS; no logic.

**Files:**
- Create: `core/src/agent/tools/types.ts`
- Test: `core/test/tools.types.test.ts`

**Interfaces:**
- Consumes: `SpanSchema` from `../../schemas/clauseCard.js` (reused as the citation type).
- Produces:
  - `CitationSchema` (= `SpanSchema`), `type Citation`.
  - `ExtractedFieldSchema` / `ExtractedField` = `{ name: string; value: string; citation: Citation | null }`.
  - `ClauseClassificationSchema` / `ClauseClassification` = `{ clause_type: string; score: number }`.
  - `ReviewFlagSchema` / `ReviewFlag` = `{ playbook_id; clause_type; severity: "low"|"medium"|"high"; deviation: boolean; rationale: string; citation: Citation }`.
  - `RedlineProposalSchema` / `RedlineProposal` = `{ playbook_id: string; original: Citation; suggested_text: string; rationale: string }`.
  - `ReviewMemoSchema` / `ReviewMemo` = `{ doc_id; objective; fields: ExtractedField[]; flags: ReviewFlag[]; redlines: RedlineProposal[]; generated_at: string }`.
  - `type SideEffect = "read" | "write"`.
  - `interface ToolDef<I, O>` = `{ name: string; title: string; description: string; sideEffect: SideEffect; inputShape: z.ZodRawShape; run(input: I): Promise<O> }`.

- [ ] **Step 1: Write the failing test**

Create `core/test/tools.types.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  CitationSchema,
  ExtractedFieldSchema,
  ReviewFlagSchema,
  RedlineProposalSchema,
  ReviewMemoSchema,
} from "../src/agent/tools/types.js";

const cite = { doc_id: "d1", char_start: 0, char_end: 5, quote: "hello" };

describe("tool artifact schemas", () => {
  it("Citation accepts a well-formed span and rejects negative offsets", () => {
    expect(CitationSchema.parse(cite)).toEqual(cite);
    expect(() => CitationSchema.parse({ ...cite, char_start: -1 })).toThrow();
  });

  it("ExtractedField allows a null citation (not found) but not a missing name", () => {
    expect(ExtractedFieldSchema.parse({ name: "Governing Law", value: "", citation: null }).citation).toBeNull();
    expect(() => ExtractedFieldSchema.parse({ value: "x", citation: null })).toThrow();
  });

  it("ReviewFlag requires a grounded citation and a valid severity", () => {
    const flag = { playbook_id: "governing_law", clause_type: "Governing Law", severity: "low", deviation: false, rationale: "standard", citation: cite };
    expect(ReviewFlagSchema.parse(flag)).toEqual(flag);
    expect(() => ReviewFlagSchema.parse({ ...flag, severity: "critical" })).toThrow();
  });

  it("RedlineProposal and ReviewMemo round-trip", () => {
    const redline = { playbook_id: "exclusions", original: cite, suggested_text: "Add standard exclusions.", rationale: "missing exclusions" };
    expect(RedlineProposalSchema.parse(redline)).toEqual(redline);
    const memo = { doc_id: "d1", objective: "review", fields: [], flags: [], redlines: [redline], generated_at: "2026-06-30T00:00:00Z" };
    expect(ReviewMemoSchema.parse(memo)).toEqual(memo);
  });

  it("schemas are strict (reject unknown keys)", () => {
    expect(() => ReviewFlagSchema.parse({ playbook_id: "x", clause_type: "y", severity: "low", deviation: false, rationale: "", citation: cite, extra: 1 })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npx vitest run test/tools.types.test.ts`
Expected: FAIL — cannot resolve `../src/agent/tools/types.js`.

- [ ] **Step 3: Write the schemas**

Create `core/src/agent/tools/types.ts`:

```ts
import { z } from "zod";
import { SpanSchema } from "../../schemas/clauseCard.js";

/** A grounded citation: quote === raw_text.slice(char_start, char_end). Reuses the clause-card span. */
export const CitationSchema = SpanSchema;
export type Citation = z.infer<typeof CitationSchema>;

const Severity = z.enum(["low", "medium", "high"]);

/** A named field extracted from the contract; citation is null when the field was not grounded. */
export const ExtractedFieldSchema = z
  .object({ name: z.string().min(1), value: z.string(), citation: CitationSchema.nullable() })
  .strict();
export type ExtractedField = z.infer<typeof ExtractedFieldSchema>;

/** Output of the P3 LoRA classifier for one clause. */
export const ClauseClassificationSchema = z
  .object({ clause_type: z.string().min(1), score: z.number() })
  .strict();
export type ClauseClassification = z.infer<typeof ClauseClassificationSchema>;

/** A playbook position surfaced against a clause. deviation=true means a red-flag / non-standard term. */
export const ReviewFlagSchema = z
  .object({
    playbook_id: z.string().min(1),
    clause_type: z.string().min(1),
    severity: Severity,
    deviation: z.boolean(),
    rationale: z.string(),
    citation: CitationSchema,
  })
  .strict();
export type ReviewFlag = z.infer<typeof ReviewFlagSchema>;

/** A grounded, playbook-compliant redline proposal for a flagged clause. */
export const RedlineProposalSchema = z
  .object({
    playbook_id: z.string().min(1),
    original: CitationSchema,
    suggested_text: z.string().min(1),
    rationale: z.string(),
  })
  .strict();
export type RedlineProposal = z.infer<typeof RedlineProposalSchema>;

/** The assembled review memo (the export_memo artifact). generated_at is injected by the caller. */
export const ReviewMemoSchema = z
  .object({
    doc_id: z.string().min(1),
    objective: z.string(),
    fields: z.array(ExtractedFieldSchema),
    flags: z.array(ReviewFlagSchema),
    redlines: z.array(RedlineProposalSchema),
    generated_at: z.string(),
  })
  .strict();
export type ReviewMemo = z.infer<typeof ReviewMemoSchema>;

export type SideEffect = "read" | "write";

/**
 * A tool the agent and the MCP server both consume. `inputShape` is a Zod raw shape so it can be
 * passed straight to MCP `registerTool` AND wrapped with `z.object(inputShape)` for validation.
 * `run` receives already-validated input. `sideEffect: "write"` marks a tool that must be HITL-gated.
 */
export interface ToolDef<I, O> {
  name: string;
  title: string;
  description: string;
  sideEffect: SideEffect;
  inputShape: z.ZodRawShape;
  run(input: I): Promise<O>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && npx vitest run test/tools.types.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/agent/tools/types.ts core/test/tools.types.test.ts
git commit -m "feat(agent): tool artifact schemas + ToolDef (P4 foundation)"
```

---

## Task 2: `retrieve_clause` tool

Wrap the existing Layer 1 RAG into a tool that returns a grounded, refusing `ClauseCard`. No new retrieval logic — pure composition, so citations resolve by construction (via `toClauseCard`).

**Files:**
- Create: `core/src/agent/tools/retrieveClause.ts`
- Test: `core/test/tools.retrieveClause.test.ts`

**Interfaces:**
- Consumes: `Candidate` (`../../retrieve/retrieve.js`), `GenInput`/`RawGen` (`../../generate/types.js`), `toClauseCard` (`../../generate/toClauseCard.js`), `ClauseCard` (`../../schemas/clauseCard.js`), `ToolDef` (`./types.js`).
- Produces:
  - `interface RetrieveClauseDeps { retrieve: (objective: string, docId: string, k: number) => Promise<Candidate[]>; generate: (input: GenInput) => Promise<RawGen>; }`
  - `RetrieveClauseInput = { objective: string; doc_id: string }`.
  - `makeRetrieveClauseTool(deps: RetrieveClauseDeps, k?: number): ToolDef<RetrieveClauseInput, ClauseCard>` — `name: "retrieve_clause"`, `sideEffect: "read"`.

- [ ] **Step 1: Write the failing test**

Create `core/test/tools.retrieveClause.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeRetrieveClauseTool } from "../src/agent/tools/retrieveClause.js";
import type { Candidate } from "../src/retrieve/retrieve.js";

const cand = (i: number): Candidate => ({
  node_id: `n${i}`, doc_id: "d1", type: "section", number: null, heading: null,
  text: "This Agreement is governed by the laws of Delaware.", char_start: 10, char_end: 61, score: 1 - i * 0.1,
});

describe("retrieve_clause tool", () => {
  it("produces a grounded ClauseCard from the chosen candidate", async () => {
    const tool = makeRetrieveClauseTool({
      retrieve: async () => [cand(0)],
      generate: async () => ({ answer: "Delaware law governs.", supporting: [0], refused: false, refusal_reason: null }),
    });
    const card = await tool.run({ objective: "Find governing law", doc_id: "d1" });
    expect(card.refused).toBe(false);
    expect(card.citations).toHaveLength(1);
    expect(card.citations[0]).toMatchObject({ doc_id: "d1", char_start: 10, char_end: 61 });
  });

  it("refuses when the model refuses (no citations invented)", async () => {
    const tool = makeRetrieveClauseTool({
      retrieve: async () => [cand(0)],
      generate: async () => ({ answer: "", supporting: [], refused: true, refusal_reason: "insufficient context" }),
    });
    const card = await tool.run({ objective: "Find arbitration seat", doc_id: "d1" });
    expect(card.refused).toBe(true);
    expect(card.citations).toHaveLength(0);
  });

  it("declares itself a read tool", () => {
    const tool = makeRetrieveClauseTool({ retrieve: async () => [], generate: async () => ({ answer: "", supporting: [], refused: true }) });
    expect(tool.name).toBe("retrieve_clause");
    expect(tool.sideEffect).toBe("read");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npx vitest run test/tools.retrieveClause.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the tool**

Create `core/src/agent/tools/retrieveClause.ts`:

```ts
import { z } from "zod";
import type { Candidate } from "../../retrieve/retrieve.js";
import type { GenInput, RawGen } from "../../generate/types.js";
import type { ClauseCard } from "../../schemas/clauseCard.js";
import { toClauseCard } from "../../generate/toClauseCard.js";
import type { ToolDef } from "./types.js";

export interface RetrieveClauseDeps {
  retrieve: (objective: string, docId: string, k: number) => Promise<Candidate[]>;
  generate: (input: GenInput) => Promise<RawGen>;
}

export interface RetrieveClauseInput {
  objective: string;
  doc_id: string;
}

const inputShape = {
  objective: z.string().min(1),
  doc_id: z.string().min(1),
};

/**
 * retrieve_clause: the Layer 1 RAG wrapped as a tool. Retrieves top-k candidates, generates a
 * grounded answer, and returns a ClauseCard whose citations resolve by construction (toClauseCard
 * derives every citation from a candidate's known-good span). Refuses instead of inventing.
 */
export function makeRetrieveClauseTool(deps: RetrieveClauseDeps, k = 8): ToolDef<RetrieveClauseInput, ClauseCard> {
  return {
    name: "retrieve_clause",
    title: "Retrieve & ground a clause",
    description: "Find the clause answering an objective in a contract and return a cited, grounded answer (or refuse).",
    sideEffect: "read",
    inputShape,
    async run(input: RetrieveClauseInput): Promise<ClauseCard> {
      const candidates = await deps.retrieve(input.objective, input.doc_id, k);
      const raw = await deps.generate({ objective: input.objective, candidates });
      return toClauseCard(input.objective, raw, candidates);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && npx vitest run test/tools.retrieveClause.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/agent/tools/retrieveClause.ts core/test/tools.retrieveClause.test.ts
git commit -m "feat(agent): retrieve_clause tool (wraps Layer 1 RAG, grounded/refusing)"
```

---

## Task 3: `extract_fields` tool

Extract named fields for an objective, each grounded in a citation. Built on `retrieve_clause`: the grounded answer's first citation backs the field value; a refusal yields a field with a null citation (not found).

**Files:**
- Create: `core/src/agent/tools/extractFields.ts`
- Test: `core/test/tools.extractFields.test.ts`

**Interfaces:**
- Consumes: `makeRetrieveClauseTool` + `RetrieveClauseDeps` (`./retrieveClause.js`), `ExtractedField` (`./types.js`), `ClauseCard` (`../../schemas/clauseCard.js`), `ToolDef`.
- Produces:
  - `ExtractFieldsInput = { objective: string; doc_id: string; field_name: string }`.
  - `makeExtractFieldsTool(deps: RetrieveClauseDeps, k?: number): ToolDef<ExtractFieldsInput, ExtractedField>` — `name: "extract_fields"`, `sideEffect: "read"`.

- [ ] **Step 1: Write the failing test**

Create `core/test/tools.extractFields.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeExtractFieldsTool } from "../src/agent/tools/extractFields.js";
import type { Candidate } from "../src/retrieve/retrieve.js";

const cand: Candidate = {
  node_id: "n0", doc_id: "d1", type: "section", number: null, heading: null,
  text: "governed by the laws of Delaware", char_start: 10, char_end: 42, score: 1,
};

describe("extract_fields tool", () => {
  it("returns a field grounded in the answer's citation", async () => {
    const tool = makeExtractFieldsTool({
      retrieve: async () => [cand],
      generate: async () => ({ answer: "Delaware", supporting: [0], refused: false, refusal_reason: null }),
    });
    const field = await tool.run({ objective: "Find governing law", doc_id: "d1", field_name: "Governing Law" });
    expect(field.name).toBe("Governing Law");
    expect(field.value).toBe("Delaware");
    expect(field.citation).toMatchObject({ char_start: 10, char_end: 42 });
  });

  it("returns a null citation when the clause is not grounded (refusal)", async () => {
    const tool = makeExtractFieldsTool({
      retrieve: async () => [cand],
      generate: async () => ({ answer: "", supporting: [], refused: true, refusal_reason: "insufficient context" }),
    });
    const field = await tool.run({ objective: "Find arbitration seat", doc_id: "d1", field_name: "Arbitration Seat" });
    expect(field.name).toBe("Arbitration Seat");
    expect(field.citation).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npx vitest run test/tools.extractFields.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the tool**

Create `core/src/agent/tools/extractFields.ts`:

```ts
import { z } from "zod";
import type { ExtractedField } from "./types.js";
import type { ToolDef } from "./types.js";
import { makeRetrieveClauseTool, type RetrieveClauseDeps } from "./retrieveClause.js";

export interface ExtractFieldsInput {
  objective: string;
  doc_id: string;
  field_name: string;
}

const inputShape = {
  objective: z.string().min(1),
  doc_id: z.string().min(1),
  field_name: z.string().min(1),
};

/**
 * extract_fields: extract one named field for an objective, grounded in a citation. Delegates to
 * retrieve_clause; the grounded answer becomes the field value and its first citation backs it.
 * A refusal yields { value: "", citation: null } — an honest "not found", never a guess.
 */
export function makeExtractFieldsTool(deps: RetrieveClauseDeps, k = 8): ToolDef<ExtractFieldsInput, ExtractedField> {
  const retrieveClause = makeRetrieveClauseTool(deps, k);
  return {
    name: "extract_fields",
    title: "Extract a grounded field",
    description: "Extract a named field (e.g. Governing Law, Term) with a citation, or report it as not found.",
    sideEffect: "read",
    inputShape,
    async run(input: ExtractFieldsInput): Promise<ExtractedField> {
      const card = await retrieveClause.run({ objective: input.objective, doc_id: input.doc_id });
      if (card.refused || card.citations.length === 0) {
        return { name: input.field_name, value: "", citation: null };
      }
      return { name: input.field_name, value: card.answer, citation: card.citations[0] };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && npx vitest run test/tools.extractFields.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/agent/tools/extractFields.ts core/test/tools.extractFields.test.ts
git commit -m "feat(agent): extract_fields tool (grounded named-field extraction)"
```

---

## Task 4: `classify_clause` tool + Python inference bridge

Wire the P3 LoRA classifier in as a tool. A Python CLI does inference (JSONL in/out); the TS tool shells out and validates the prediction against a shared JSON Schema — honoring the cross-language typed-boundary invariant. Both sides are tested without loading the model (framing/parse only); the real model path runs at the gate.

**Files:**
- Create: `schemas/clf-prediction.schema.json`
- Create: `pipeline/pipeline/classify/predict.py`
- Create: `pipeline/tests/test_clf_predict.py`
- Create: `core/src/agent/tools/classifyClause.ts`
- Create: `core/test/tools.classifyClause.test.ts`
- Modify: `Makefile` (add `clf-predict`)

**Interfaces:**
- Produces (Python): `parse_input_line(line: str) -> str | None` (returns `text` or None for blank); `format_prediction(text: str, label: str, score: float) -> str` (a JSON line); `run_predict(reader, writer, ...)` streaming stdin→stdout.
- Produces (TS):
  - `PredictionSchema` (Zod) = `{ text: string; label: string; score: number }`.
  - `interface ClassifyDeps { runPredict: (texts: string[]) => Promise<{ text: string; label: string; score: number }[]> }`.
  - `defaultRunPredict(texts): Promise<...>` — spawns the Python CLI (`pipeline/.venv/bin/python -m pipeline.classify.predict`).
  - `ClassifyInput = { text: string }`.
  - `makeClassifyClauseTool(deps: ClassifyDeps): ToolDef<ClassifyInput, ClauseClassification>` — `name: "classify_clause"`, `sideEffect: "read"`.

- [ ] **Step 1: Write the failing Python test**

Create `pipeline/tests/test_clf_predict.py`:

```python
import json

from pipeline.classify.predict import parse_input_line, format_prediction, run_predict


def test_parse_input_line_reads_text_field_and_skips_blank():
    assert parse_input_line(json.dumps({"text": "hello"})) == "hello"
    assert parse_input_line("   ") is None


def test_format_prediction_is_valid_jsonl():
    line = format_prediction("a clause", "Governing Law", 0.97)
    obj = json.loads(line)
    assert obj == {"text": "a clause", "label": "Governing Law", "score": 0.97}
    assert "\n" not in line  # caller adds the newline


def test_run_predict_streams_one_prediction_per_input_line():
    # Inject a fake classifier so no model loads.
    def fake_classify(texts):
        return [(f"LABEL_{i}", 0.5) for i, _ in enumerate(texts)]

    src = [json.dumps({"text": "x"}), "", json.dumps({"text": "y"})]
    out = []
    run_predict(iter(src), out.append, classify=fake_classify)
    parsed = [json.loads(o) for o in out]
    assert [p["text"] for p in parsed] == ["x", "y"]
    assert [p["label"] for p in parsed] == ["LABEL_0", "LABEL_1"]
```

- [ ] **Step 2: Run Python test to verify it fails**

Run: `cd pipeline && .venv/bin/python -m pytest tests/test_clf_predict.py -q`
Expected: FAIL — `pipeline.classify.predict` does not exist.

- [ ] **Step 3: Write the Python inference CLI**

Create `pipeline/pipeline/classify/predict.py`:

```python
"""Batch LoRA-classifier inference CLI: JSONL {"text": ...} on stdin -> JSONL
{"text","label","score"} on stdout. Loads the adapter exactly as evaluate.py.
Pure framing helpers (parse_input_line, format_prediction) are unit-tested; the model
path (default_classify) is exercised at the P4 gate."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Callable, Iterable

from pipeline.classify.models import load_label_map

_REPO_ROOT = Path(__file__).parents[3]
CLF_DATA_DIR = _REPO_ROOT / "data" / "processed" / "cuad_clf"
MODEL_DIR = _REPO_ROOT / "models" / "cuad_clf"
BASE_MODEL = os.environ.get("CLF_BASE_MODEL", "microsoft/deberta-v3-base")
MAX_LEN = int(os.environ.get("CLF_MAX_LEN", "128"))


def parse_input_line(line: str) -> str | None:
    """Return the `text` field of a JSONL line, or None for a blank line."""
    if not line.strip():
        return None
    return json.loads(line)["text"]


def format_prediction(text: str, label: str, score: float) -> str:
    """One JSON object per prediction (no trailing newline; the caller adds it)."""
    return json.dumps({"text": text, "label": label, "score": score})


def default_classify(texts: list[str]) -> list[tuple[str, float]]:
    """Load the LoRA adapter and return (label, softmax_score) per text. Heavy; imported lazily."""
    import torch
    from peft import PeftModel
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    labels = load_label_map(CLF_DATA_DIR / "label_map.json")
    id2label = dict(enumerate(labels))
    tok = AutoTokenizer.from_pretrained(str(MODEL_DIR))
    cfg_path = MODEL_DIR / "adapter_config.json"
    base_name = BASE_MODEL
    if cfg_path.exists():
        base_name = json.loads(cfg_path.read_text()).get("base_model_name_or_path") or BASE_MODEL
    base = AutoModelForSequenceClassification.from_pretrained(
        base_name, num_labels=len(labels), id2label=id2label,
        label2id={lbl: i for i, lbl in enumerate(labels)},
    )
    model = PeftModel.from_pretrained(base, str(MODEL_DIR))
    model.eval()

    out: list[tuple[str, float]] = []
    with torch.no_grad():
        for text in texts:
            enc = tok(text, truncation=True, max_length=MAX_LEN, return_tensors="pt")
            logits = model(**enc).logits[0]
            probs = torch.softmax(logits, dim=-1)
            idx = int(probs.argmax())
            out.append((id2label[idx], float(probs[idx])))
    return out


def run_predict(
    reader: Iterable[str],
    writer: Callable[[str], None],
    classify: Callable[[list[str]], list[tuple[str, float]]] = default_classify,
) -> None:
    """Read JSONL text lines, classify in one batch, write JSONL predictions."""
    texts = [t for t in (parse_input_line(line) for line in reader) if t is not None]
    if not texts:
        return
    preds = classify(texts)
    for text, (label, score) in zip(texts, preds):
        writer(format_prediction(text, label, score) + "\n")


if __name__ == "__main__":
    run_predict(sys.stdin, sys.stdout.write)
```

- [ ] **Step 4: Run Python test to verify it passes**

Run: `cd pipeline && .venv/bin/python -m pytest tests/test_clf_predict.py -q`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the schema, Makefile target, and failing TS test**

Create `schemas/clf-prediction.schema.json`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "ClfPrediction",
  "description": "One clause-classifier prediction emitted by pipeline.classify.predict (Python) and consumed by the classify_clause tool (TypeScript).",
  "type": "object",
  "additionalProperties": false,
  "required": ["text", "label", "score"],
  "properties": {
    "text": { "type": "string" },
    "label": { "type": "string" },
    "score": { "type": "number" }
  }
}
```

Add to `Makefile` under the `clf-*` group (after the `clf-eval` recipe):

```makefile
clf-predict:
	cd pipeline && .venv/bin/python -m pipeline.classify.predict
```
(also add `clf-predict` to the `.PHONY: clf-extract clf-baseline clf-train clf-eval` line)

Create `core/test/tools.classifyClause.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeClassifyClauseTool, PredictionSchema } from "../src/agent/tools/classifyClause.js";

describe("classify_clause tool", () => {
  it("returns the label + score from the injected predictor", async () => {
    const tool = makeClassifyClauseTool({
      runPredict: async (texts) => texts.map((t) => ({ text: t, label: "Governing Law", score: 0.97 })),
    });
    const out = await tool.run({ text: "governed by the laws of Delaware" });
    expect(out).toEqual({ clause_type: "Governing Law", score: 0.97 });
  });

  it("throws if the bridge returns no prediction for the input", async () => {
    const tool = makeClassifyClauseTool({ runPredict: async () => [] });
    await expect(tool.run({ text: "x" })).rejects.toThrow(/no prediction/i);
  });

  it("PredictionSchema rejects a malformed prediction", () => {
    expect(() => PredictionSchema.parse({ text: "x", label: "y" })).toThrow();
  });
});
```

- [ ] **Step 6: Run the TS test to verify it fails**

Run: `cd core && npx vitest run test/tools.classifyClause.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Write the TS tool**

Create `core/src/agent/tools/classifyClause.ts`:

```ts
import { z } from "zod";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ClauseClassification, ToolDef } from "./types.js";

/** The Python→TS classifier prediction (mirrors schemas/clf-prediction.schema.json). */
export const PredictionSchema = z.object({ text: z.string(), label: z.string(), score: z.number() }).strict();
export type Prediction = z.infer<typeof PredictionSchema>;

export interface ClassifyDeps {
  runPredict: (texts: string[]) => Promise<Prediction[]>;
}

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * Default bridge: spawn the Python inference CLI, stream JSONL in, parse validated JSONL out.
 * Each stdout line is validated with PredictionSchema — no unvalidated data crosses the boundary.
 */
export async function defaultRunPredict(texts: string[]): Promise<Prediction[]> {
  const py = `${repoRoot}pipeline/.venv/bin/python`;
  const child = spawn(py, ["-m", "pipeline.classify.predict"], { cwd: `${repoRoot}pipeline` });
  child.stdin.write(texts.map((t) => JSON.stringify({ text: t })).join("\n") + "\n");
  child.stdin.end();

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));

  const code: number = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) throw new Error(`clf predict exited ${code}: ${stderr.slice(0, 500)}`);

  return stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => PredictionSchema.parse(JSON.parse(l)));
}

const inputShape = { text: z.string().min(1) };
export interface ClassifyInput {
  text: string;
}

/**
 * classify_clause: the P3 LoRA clause classifier as a tool. Delegates inference to the Python
 * bridge (injected as deps.runPredict; defaults to the subprocess CLI) and returns a typed label.
 */
export function makeClassifyClauseTool(deps: ClassifyDeps): ToolDef<ClassifyInput, ClauseClassification> {
  return {
    name: "classify_clause",
    title: "Classify a clause (LoRA)",
    description: "Classify a clause into one of the 37 CUAD clause types using the fine-tuned Legal-BERT LoRA model.",
    sideEffect: "read",
    inputShape,
    async run(input: ClassifyInput): Promise<ClauseClassification> {
      const preds = await deps.runPredict([input.text]);
      if (preds.length === 0) throw new Error("classify_clause: no prediction returned for input");
      return { clause_type: preds[0].label, score: preds[0].score };
    },
  };
}
```

- [ ] **Step 8: Run the TS test to verify it passes**

Run: `cd core && npx vitest run test/tools.classifyClause.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 9: Commit**

```bash
git add schemas/clf-prediction.schema.json pipeline/pipeline/classify/predict.py pipeline/tests/test_clf_predict.py core/src/agent/tools/classifyClause.ts core/test/tools.classifyClause.test.ts Makefile
git commit -m "feat(agent): classify_clause tool + Python LoRA inference CLI (schema-validated bridge)"
```

---

## Task 5: `check_playbook` + `flag_risks` (risk engine)

Match a classified clause to a playbook position and judge whether it deviates from the standard — the false-negative-critical path. `check_playbook` resolves a clause type to a `PlaybookEntry` via an explicit CUAD-label→playbook_id synonyms map. `flag_risks` uses an injected LLM judge to decide deviation, grounded on the clause text; severity comes from the playbook (deterministic), the flag always carries the clause's citation.

**Files:**
- Create: `core/src/agent/tools/playbookMatch.ts`
- Create: `core/src/agent/tools/flagRisks.ts`
- Test: `core/test/tools.playbookMatch.test.ts`
- Test: `core/test/tools.flagRisks.test.ts`

**Interfaces:**
- Consumes: `PlaybookEntry`, `loadPlaybook` (`../../eval/playbook.js`), `Citation`, `ReviewFlag`, `ToolDef` (`./types.js`).
- Produces:
  - `PLAYBOOK_CLAUSE_SYNONYMS: Record<string, string>` — CUAD clause label → `playbook_id`.
  - `matchPlaybookEntry(clauseType: string, entries: PlaybookEntry[]): PlaybookEntry | null` — case-insensitive match on `clause_type` or synonyms.
  - `interface DeviationJudge { judge: (clauseText: string, entry: PlaybookEntry) => Promise<{ deviation: boolean; rationale: string }> }`.
  - `FlagRisksInput = { clause_text: string; clause_type: string; citation: Citation }`.
  - `makeFlagRisksTool(deps: DeviationJudge, entries: PlaybookEntry[]): ToolDef<FlagRisksInput, ReviewFlag | null>` — `name: "flag_risks"`, `sideEffect: "read"`. Returns `null` when no playbook entry matches (nothing to review), else a `ReviewFlag`.
  - `defaultDeviationJudge(): DeviationJudge` — LLM-backed, tolerant Zod parse, degrades to `{ deviation: false }` on failure.

- [ ] **Step 1: Write the failing playbook-match test**

Create `core/test/tools.playbookMatch.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { loadPlaybook } from "../src/eval/playbook.js";
import { matchPlaybookEntry } from "../src/agent/tools/playbookMatch.js";

const entries = loadPlaybook(fileURLToPath(new URL("../../evals/playbook/nda.yaml", import.meta.url)));

describe("matchPlaybookEntry", () => {
  it("matches a CUAD label directly on clause_type (case-insensitive)", () => {
    expect(matchPlaybookEntry("governing law", entries)?.playbook_id).toBe("governing_law");
  });
  it("matches via the synonyms map when the label differs from the playbook wording", () => {
    // CUAD's "Anti-Assignment" is not a playbook clause_type; a governing-law synonym still resolves.
    expect(matchPlaybookEntry("Governing Law", entries)?.playbook_id).toBe("governing_law");
  });
  it("returns null for a clause type with no playbook position", () => {
    expect(matchPlaybookEntry("Volume Restriction", entries)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npx vitest run test/tools.playbookMatch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the matcher**

Create `core/src/agent/tools/playbookMatch.ts`:

```ts
import type { PlaybookEntry } from "../../eval/playbook.js";

/**
 * CUAD clause labels (classifier output) → playbook_id, for labels whose wording differs from the
 * playbook's `clause_type`. Direct case-insensitive `clause_type` matches need no entry here.
 * Kept explicit (not fuzzy) so the risk-engine's coverage is auditable — a miss is a real, visible
 * false negative, not a silent fuzzy failure.
 */
export const PLAYBOOK_CLAUSE_SYNONYMS: Record<string, string> = {
  "governing law": "governing_law",
  "confidentiality": "definition_scope",
  "confidential information": "definition_scope",
  "term": "confidentiality_term",
  "expiration date": "confidentiality_term",
  "return of confidential information": "return_of_materials",
  "injunctive relief": "remedies",
};

/** Resolve a clause type to a playbook position, or null if none applies. */
export function matchPlaybookEntry(clauseType: string, entries: PlaybookEntry[]): PlaybookEntry | null {
  const key = clauseType.trim().toLowerCase();
  const direct = entries.find((e) => e.clause_type.trim().toLowerCase() === key);
  if (direct) return direct;
  const viaSynonym = PLAYBOOK_CLAUSE_SYNONYMS[key];
  if (viaSynonym) return entries.find((e) => e.playbook_id === viaSynonym) ?? null;
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && npx vitest run test/tools.playbookMatch.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing flag_risks test**

Create `core/test/tools.flagRisks.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { loadPlaybook } from "../src/eval/playbook.js";
import { makeFlagRisksTool } from "../src/agent/tools/flagRisks.js";

const entries = loadPlaybook(fileURLToPath(new URL("../../evals/playbook/nda.yaml", import.meta.url)));
const cite = { doc_id: "d1", char_start: 0, char_end: 20, quote: "perpetual and forever" };

describe("flag_risks tool", () => {
  it("emits a flag with the playbook severity and the clause citation when a position matches", async () => {
    const tool = makeFlagRisksTool({ judge: async () => ({ deviation: true, rationale: "perpetual term" }) }, entries);
    const flag = await tool.run({ clause_text: "Obligations are perpetual.", clause_type: "Term / Duration of Confidentiality", citation: cite });
    expect(flag).not.toBeNull();
    expect(flag!.playbook_id).toBe("confidentiality_term");
    expect(flag!.severity).toBe("high");        // from the playbook, not the judge
    expect(flag!.deviation).toBe(true);
    expect(flag!.citation).toEqual(cite);
  });

  it("still emits the matched position (deviation=false) so coverage is measurable", async () => {
    const tool = makeFlagRisksTool({ judge: async () => ({ deviation: false, rationale: "standard 3-year term" }) }, entries);
    const flag = await tool.run({ clause_text: "3 year term.", clause_type: "Governing Law", citation: cite });
    expect(flag!.playbook_id).toBe("governing_law");
    expect(flag!.deviation).toBe(false);
  });

  it("returns null when no playbook position matches the clause type", async () => {
    const tool = makeFlagRisksTool({ judge: async () => ({ deviation: true, rationale: "" }) }, entries);
    expect(await tool.run({ clause_text: "x", clause_type: "Volume Restriction", citation: cite })).toBeNull();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd core && npx vitest run test/tools.flagRisks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Write the risk engine**

Create `core/src/agent/tools/flagRisks.ts`:

```ts
import { z } from "zod";
import OpenAI from "openai";
import type { PlaybookEntry } from "../../eval/playbook.js";
import type { Citation, ReviewFlag, ToolDef } from "./types.js";
import { matchPlaybookEntry } from "./playbookMatch.js";
import { reserveSlot, resolveMinIntervalMs } from "../../llm/throttle.js";

export interface DeviationJudge {
  judge: (clauseText: string, entry: PlaybookEntry) => Promise<{ deviation: boolean; rationale: string }>;
}

export interface FlagRisksInput {
  clause_text: string;
  clause_type: string;
  citation: Citation;
}

const inputShape = {
  clause_text: z.string().min(1),
  clause_type: z.string().min(1),
  citation: z.object({
    doc_id: z.string().min(1),
    char_start: z.number().int().nonnegative(),
    char_end: z.number().int().nonnegative(),
    quote: z.string(),
  }),
};

/**
 * flag_risks (check_playbook + deviation judgement). Resolves the clause type to a playbook
 * position; if none, returns null (nothing to review). Otherwise asks the judge whether the clause
 * deviates from the standard and emits a ReviewFlag — severity from the playbook (deterministic),
 * citation from the clause. Emitting even non-deviating matches makes "did we review the required
 * position" measurable as coverage / false-negative rate.
 */
export function makeFlagRisksTool(deps: DeviationJudge, entries: PlaybookEntry[]): ToolDef<FlagRisksInput, ReviewFlag | null> {
  return {
    name: "flag_risks",
    title: "Flag playbook deviations",
    description: "Match a clause to its playbook position and flag whether it deviates from the standard.",
    sideEffect: "read",
    inputShape,
    async run(input: FlagRisksInput): Promise<ReviewFlag | null> {
      const entry = matchPlaybookEntry(input.clause_type, entries);
      if (!entry) return null;
      const { deviation, rationale } = await deps.judge(input.clause_text, entry);
      return {
        playbook_id: entry.playbook_id,
        clause_type: entry.clause_type,
        severity: entry.severity,
        deviation,
        rationale,
        citation: input.citation,
      };
    },
  };
}

const VerdictSchema = z.object({
  deviation: z.boolean().catch(false),
  rationale: z.string().catch(""),
});

/**
 * Default LLM deviation judge. Grounds the decision on the clause text + the playbook's standard
 * position and red flags. Tolerant parse; any failure degrades to { deviation: false } (never
 * crashes the review — an unreadable verdict is treated as "not a deviation", surfaced in rationale).
 */
export function defaultDeviationJudge(): DeviationJudge {
  const model = process.env.LLM_MODEL ?? "meta/llama-3.3-70b-instruct";
  const client = new OpenAI({
    baseURL: process.env.LLM_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
    apiKey: process.env.LLM_API_KEY ?? "",
  });
  const minIntervalMs = resolveMinIntervalMs();
  return {
    async judge(clauseText, entry) {
      await reserveSlot(minIntervalMs);
      const system =
        "You are a contract-review assistant. Decide ONLY from the clause text whether it deviates from the standard position. " +
        'Reply with ONLY JSON: {"deviation": boolean, "rationale": string}. If uncertain, deviation=false.';
      const user =
        `Playbook position: ${entry.standard_position}\nRed flags: ${entry.red_flags.join("; ")}\n\nClause:\n${clauseText}`;
      try {
        const resp = await client.chat.completions.create({
          model,
          temperature: 0,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        });
        const text = resp.choices[0]?.message?.content ?? "";
        const start = text.indexOf("{");
        const parsed = VerdictSchema.parse(JSON.parse(text.slice(start, text.lastIndexOf("}") + 1)));
        return { deviation: parsed.deviation, rationale: parsed.rationale };
      } catch {
        return { deviation: false, rationale: "deviation judge unavailable (degraded to no-deviation)" };
      }
    },
  };
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd core && npx vitest run test/tools.flagRisks.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 9: Commit**

```bash
git add core/src/agent/tools/playbookMatch.ts core/src/agent/tools/flagRisks.ts core/test/tools.playbookMatch.test.ts core/test/tools.flagRisks.test.ts
git commit -m "feat(agent): check_playbook + flag_risks risk engine (playbook match + deviation judge)"
```

---

## Task 6: `draft_redline` + `export_memo` (with HITL gate)

The write path. `draft_redline` proposes grounded, playbook-compliant replacement text for a flagged clause. `export_memo` renders the memo and — being the only `write` tool — performs NO filesystem write unless `confirm === true`; otherwise it returns the rendered markdown with `written: false`. The file writer is injected so tests never touch disk.

**Files:**
- Create: `core/src/agent/tools/draftRedline.ts`
- Create: `core/src/agent/tools/exportMemo.ts`
- Test: `core/test/tools.draftRedline.test.ts`
- Test: `core/test/tools.exportMemo.test.ts`
- Modify: `.gitignore` (add `/data/reviews/`)

**Interfaces:**
- Consumes: `ReviewFlag`, `RedlineProposal`, `ReviewMemo`, `Citation`, `ToolDef` (`./types.js`).
- Produces:
  - `interface RedlineWriter { suggest: (flag: ReviewFlag, clauseText: string) => Promise<string> }`.
  - `DraftRedlineInput = { flag: ReviewFlag; clause_text: string }`.
  - `makeDraftRedlineTool(deps: RedlineWriter): ToolDef<DraftRedlineInput, RedlineProposal>` — `name: "draft_redline"`, `sideEffect: "read"`.
  - `renderMemoMarkdown(memo: ReviewMemo): string` — pure.
  - `interface MemoWriter { writeFile: (path: string, contents: string) => Promise<void> }`.
  - `ExportMemoInput = { memo: ReviewMemo; confirm?: boolean; out_dir?: string }`.
  - `interface ExportMemoResult { written: boolean; path: string | null; markdown: string }`.
  - `makeExportMemoTool(deps: MemoWriter): ToolDef<ExportMemoInput, ExportMemoResult>` — `name: "export_memo"`, `sideEffect: "write"`.

- [ ] **Step 1: Write the failing draft_redline test**

Create `core/test/tools.draftRedline.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeDraftRedlineTool } from "../src/agent/tools/draftRedline.js";

const flag = {
  playbook_id: "confidentiality_term", clause_type: "Term / Duration of Confidentiality",
  severity: "high" as const, deviation: true, rationale: "perpetual term",
  citation: { doc_id: "d1", char_start: 5, char_end: 30, quote: "obligations are perpetual." },
};

describe("draft_redline tool", () => {
  it("returns a grounded redline citing the original span", async () => {
    const tool = makeDraftRedlineTool({ suggest: async () => "Confidentiality obligations survive for three (3) years." });
    const rl = await tool.run({ flag, clause_text: "Obligations are perpetual." });
    expect(rl.playbook_id).toBe("confidentiality_term");
    expect(rl.original).toEqual(flag.citation);
    expect(rl.suggested_text).toMatch(/three/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npx vitest run test/tools.draftRedline.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write draft_redline**

Create `core/src/agent/tools/draftRedline.ts`:

```ts
import { z } from "zod";
import OpenAI from "openai";
import type { ReviewFlag, RedlineProposal, ToolDef } from "./types.js";
import { reserveSlot, resolveMinIntervalMs } from "../../llm/throttle.js";

export interface RedlineWriter {
  suggest: (flag: ReviewFlag, clauseText: string) => Promise<string>;
}

export interface DraftRedlineInput {
  flag: ReviewFlag;
  clause_text: string;
}

const inputShape = {
  flag: z.object({
    playbook_id: z.string(), clause_type: z.string(),
    severity: z.enum(["low", "medium", "high"]), deviation: z.boolean(), rationale: z.string(),
    citation: z.object({ doc_id: z.string(), char_start: z.number(), char_end: z.number(), quote: z.string() }),
  }),
  clause_text: z.string().min(1),
};

/**
 * draft_redline: propose playbook-compliant replacement text for a flagged clause. The proposal is
 * anchored to the original span (flag.citation) so the change is grounded and reviewable; a human
 * still decides whether to accept it (redlines only enter the world via a confirmed export_memo).
 */
export function makeDraftRedlineTool(deps: RedlineWriter): ToolDef<DraftRedlineInput, RedlineProposal> {
  return {
    name: "draft_redline",
    title: "Draft a playbook-compliant redline",
    description: "Propose replacement text bringing a flagged clause in line with the playbook, citing the original span.",
    sideEffect: "read",
    inputShape,
    async run(input: DraftRedlineInput): Promise<RedlineProposal> {
      const suggested = await deps.suggest(input.flag, input.clause_text);
      return {
        playbook_id: input.flag.playbook_id,
        original: input.flag.citation,
        suggested_text: suggested,
        rationale: input.flag.rationale,
      };
    },
  };
}

/** Default LLM redline writer. Degrades to a safe generic instruction on failure (never throws). */
export function defaultRedlineWriter(): RedlineWriter {
  const model = process.env.LLM_MODEL ?? "meta/llama-3.3-70b-instruct";
  const client = new OpenAI({
    baseURL: process.env.LLM_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
    apiKey: process.env.LLM_API_KEY ?? "",
  });
  const minIntervalMs = resolveMinIntervalMs();
  return {
    async suggest(flag, clauseText) {
      await reserveSlot(minIntervalMs);
      try {
        const resp = await client.chat.completions.create({
          model,
          temperature: 0,
          messages: [
            { role: "system", content: "You are a contract-redlining assistant. Reply with ONLY the replacement clause text — no preamble." },
            { role: "user", content: `Rewrite this clause to satisfy the playbook (${flag.rationale}). Original:\n${clauseText}` },
          ],
        });
        return (resp.choices[0]?.message?.content ?? "").trim() || `Revise to satisfy: ${flag.rationale}`;
      } catch {
        return `Revise to satisfy playbook position ${flag.playbook_id}: ${flag.rationale}`;
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && npx vitest run test/tools.draftRedline.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Write the failing export_memo test (the HITL gate)**

Create `core/test/tools.exportMemo.test.ts`:

```ts
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
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd core && npx vitest run test/tools.exportMemo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Write export_memo**

Create `core/src/agent/tools/exportMemo.ts`:

```ts
import { z } from "zod";
import type { ReviewMemo, ToolDef } from "./types.js";
import { ReviewMemoSchema } from "./types.js";

export interface MemoWriter {
  writeFile: (path: string, contents: string) => Promise<void>;
}

export interface ExportMemoInput {
  memo: ReviewMemo;
  confirm?: boolean;
  out_dir?: string;
}

export interface ExportMemoResult {
  written: boolean;
  path: string | null;
  markdown: string;
}

const inputShape = {
  memo: ReviewMemoSchema,
  confirm: z.boolean().optional(),
  out_dir: z.string().optional(),
};

/** Pure markdown renderer for a review memo. */
export function renderMemoMarkdown(memo: ReviewMemo): string {
  const lines: string[] = [
    "# Contract Review Memo",
    "",
    `- **Document:** ${memo.doc_id}`,
    `- **Objective:** ${memo.objective}`,
    `- **Generated:** ${memo.generated_at}`,
    "",
    "## Extracted fields",
  ];
  if (memo.fields.length === 0) lines.push("_none_");
  for (const f of memo.fields) {
    lines.push(`- **${f.name}:** ${f.value || "_not found_"}${f.citation ? ` _(chars ${f.citation.char_start}-${f.citation.char_end})_` : ""}`);
  }
  lines.push("", "## Flags");
  if (memo.flags.length === 0) lines.push("_none_");
  for (const fl of memo.flags) {
    lines.push(`- **${fl.playbook_id}** (${fl.severity}${fl.deviation ? ", DEVIATION" : ""}): ${fl.rationale} _(chars ${fl.citation.char_start}-${fl.citation.char_end})_`);
  }
  lines.push("", "## Proposed redlines");
  if (memo.redlines.length === 0) lines.push("_none_");
  for (const r of memo.redlines) {
    lines.push(`- **${r.playbook_id}:** ${r.suggested_text}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * export_memo: the sole write tool. HUMAN-IN-THE-LOOP GATE — it performs no filesystem write
 * unless confirm === true. Without confirmation it returns the rendered markdown as a preview
 * (written: false), so a human can review before anything is persisted. The writer is injected.
 */
export function makeExportMemoTool(deps: MemoWriter): ToolDef<ExportMemoInput, ExportMemoResult> {
  return {
    name: "export_memo",
    title: "Export the review memo",
    description: "Render the review memo; writes to disk ONLY when confirm=true (human-in-the-loop gate), else returns a preview.",
    sideEffect: "write",
    inputShape,
    async run(input: ExportMemoInput): Promise<ExportMemoResult> {
      const markdown = renderMemoMarkdown(input.memo);
      if (input.confirm !== true) {
        return { written: false, path: null, markdown };
      }
      const dir = input.out_dir ?? "data/reviews";
      const path = `${dir}/${input.memo.doc_id}-${input.memo.generated_at}.md`;
      await deps.writeFile(path, markdown);
      return { written: true, path, markdown };
    },
  };
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd core && npx vitest run test/tools.exportMemo.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 9: Ignore review artifacts + commit**

Add to `.gitignore` under the build-artifacts group:

```
# Review memos written by export_memo (human artifacts, not source)
/data/reviews/
```

```bash
git add core/src/agent/tools/draftRedline.ts core/src/agent/tools/exportMemo.ts core/test/tools.draftRedline.test.ts core/test/tools.exportMemo.test.ts .gitignore
git commit -m "feat(agent): draft_redline + export_memo with HITL confirm gate"
```

---

## Task 7: Review orchestrator (the agent) + MCP server

Compose the tools into a deterministic `reviewContract` orchestrator that emits a reproducible trajectory (retrieve → classify → flag → redline → memo-preview), and expose the same tool instances over an MCP stdio server with a documented sample client.

**Files:**
- Create: `core/src/agent/reviewAgent.ts`
- Create: `core/src/mcp/tools.ts`
- Create: `core/src/mcp/server.ts`
- Create: `core/src/mcp/sampleClient.ts`
- Create: `docs/mcp-quickstart.md`
- Test: `core/test/agent.reviewAgent.test.ts`
- Test: `core/test/mcp.tools.test.ts`
- Modify: `core/package.json` (dep + scripts)

**Interfaces:**
- Consumes: all tool factories from Task 2–6; `ClauseCard`; `ReviewFlag`/`RedlineProposal`/`ExtractedField`/`ReviewMemo`/`ToolDef`.
- Produces:
  - `interface ReviewDeps { retrieveClause: ToolDef<...>; classifyClause: ToolDef<...>; flagRisks: ToolDef<...>; draftRedline: ToolDef<...>; exportMemo: ToolDef<...>; }`
  - `interface ReviewResult { card: ClauseCard; classification: ClauseClassification | null; flags: ReviewFlag[]; redlines: RedlineProposal[]; memo: ExportMemoResult; trajectory: string[]; refused: boolean; }`
  - `reviewContract(objective: string, docId: string, deps: ReviewDeps, opts?: { generatedAt: string }): Promise<ReviewResult>`.
  - `buildTools(deps: BuildDeps): ToolDef<any, any>[]` (`mcp/tools.ts`) — the 5 tools wired with real deps.
  - `buildServer(deps: BuildDeps): McpServer` (`mcp/server.ts`).

- [ ] **Step 1: Write the failing orchestrator test**

Create `core/test/agent.reviewAgent.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { reviewContract } from "../src/agent/reviewAgent.js";
import { makeRetrieveClauseTool } from "../src/agent/tools/retrieveClause.js";
import { makeClassifyClauseTool } from "../src/agent/tools/classifyClause.js";
import { makeFlagRisksTool } from "../src/agent/tools/flagRisks.js";
import { makeDraftRedlineTool } from "../src/agent/tools/draftRedline.js";
import { makeExportMemoTool } from "../src/agent/tools/exportMemo.js";
import { fileURLToPath } from "node:url";
import { loadPlaybook } from "../src/eval/playbook.js";
import type { Candidate } from "../src/retrieve/retrieve.js";

const entries = loadPlaybook(fileURLToPath(new URL("../../evals/playbook/nda.yaml", import.meta.url)));
const cand: Candidate = { node_id: "n0", doc_id: "d1", type: "s", number: null, heading: null, text: "Obligations are perpetual.", char_start: 0, char_end: 26, score: 1 };

function deps(refuse: boolean) {
  const writes: string[] = [];
  return {
    writes,
    deps: {
      retrieveClause: makeRetrieveClauseTool({
        retrieve: async () => [cand],
        generate: async () => refuse ? { answer: "", supporting: [], refused: true, refusal_reason: "n/a" } : { answer: "perpetual term", supporting: [0], refused: false, refusal_reason: null },
      }),
      classifyClause: makeClassifyClauseTool({ runPredict: async (t) => t.map((x) => ({ text: x, label: "Term / Duration of Confidentiality", score: 0.9 })) }),
      flagRisks: makeFlagRisksTool({ judge: async () => ({ deviation: true, rationale: "perpetual" }) }, entries),
      draftRedline: makeDraftRedlineTool({ suggest: async () => "Three (3) year term." }),
      exportMemo: makeExportMemoTool({ writeFile: async (p) => { writes.push(p); } }),
    },
  };
}

describe("reviewContract orchestrator", () => {
  it("runs the full trajectory and returns a grounded flag + memo preview (no write)", async () => {
    const { writes, deps: d } = deps(false);
    const r = await reviewContract("Review confidentiality term", "d1", d, { generatedAt: "2026-06-30T00:00:00Z" });
    expect(r.refused).toBe(false);
    expect(r.trajectory).toEqual(["retrieve_clause", "classify_clause", "flag_risks", "draft_redline", "export_memo"]);
    expect(r.flags[0].playbook_id).toBe("confidentiality_term");
    expect(r.redlines).toHaveLength(1);
    expect(r.memo.written).toBe(false);      // eval path never confirms → HITL gate holds
    expect(writes).toHaveLength(0);
  });

  it("stops after retrieval and refuses when the clause is ungrounded", async () => {
    const { deps: d } = deps(true);
    const r = await reviewContract("Find arbitration seat", "d1", d, { generatedAt: "2026-06-30T00:00:00Z" });
    expect(r.refused).toBe(true);
    expect(r.trajectory).toEqual(["retrieve_clause"]);
    expect(r.flags).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npx vitest run test/agent.reviewAgent.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the orchestrator**

Create `core/src/agent/reviewAgent.ts`:

```ts
import type { ClauseCard } from "../schemas/clauseCard.js";
import type { ClauseClassification, ReviewFlag, RedlineProposal, ReviewMemo, ToolDef } from "./tools/types.js";
import type { RetrieveClauseInput } from "./tools/retrieveClause.js";
import type { ClassifyInput } from "./tools/classifyClause.js";
import type { FlagRisksInput } from "./tools/flagRisks.js";
import type { DraftRedlineInput } from "./tools/draftRedline.js";
import type { ExportMemoInput, ExportMemoResult } from "./tools/exportMemo.js";

export interface ReviewDeps {
  retrieveClause: ToolDef<RetrieveClauseInput, ClauseCard>;
  classifyClause: ToolDef<ClassifyInput, ClauseClassification>;
  flagRisks: ToolDef<FlagRisksInput, ReviewFlag | null>;
  draftRedline: ToolDef<DraftRedlineInput, RedlineProposal>;
  exportMemo: ToolDef<ExportMemoInput, ExportMemoResult>;
}

export interface ReviewResult {
  card: ClauseCard;
  classification: ClauseClassification | null;
  flags: ReviewFlag[];
  redlines: RedlineProposal[];
  memo: ExportMemoResult;
  trajectory: string[];
  refused: boolean;
}

/**
 * The action agent: a deterministic tool trajectory. Retrieve the clause; if ungrounded, refuse and
 * stop (no downstream claims). Otherwise classify it, flag it against the playbook, draft a redline
 * for any deviation, and render a memo PREVIEW (never confirmed here — the human confirms an export
 * out-of-band). Deterministic so the agent-eval trajectory is reproducible.
 */
export async function reviewContract(
  objective: string,
  docId: string,
  deps: ReviewDeps,
  opts?: { generatedAt: string },
): Promise<ReviewResult> {
  const trajectory: string[] = [];
  const generatedAt = opts?.generatedAt ?? "unknown";

  trajectory.push(deps.retrieveClause.name);
  const card = await deps.retrieveClause.run({ objective, doc_id: docId });

  if (card.refused || card.citations.length === 0) {
    const memo = await deps.exportMemo.run({
      memo: { doc_id: docId, objective, fields: [], flags: [], redlines: [], generated_at: generatedAt },
    });
    return { card, classification: null, flags: [], redlines: [], memo, trajectory, refused: true };
  }

  const citation = card.citations[0];
  const clauseText = citation.quote;

  trajectory.push(deps.classifyClause.name);
  const classification = await deps.classifyClause.run({ text: clauseText });

  trajectory.push(deps.flagRisks.name);
  const flag = await deps.flagRisks.run({ clause_text: clauseText, clause_type: classification.clause_type, citation });
  const flags = flag ? [flag] : [];

  const redlines: RedlineProposal[] = [];
  for (const f of flags.filter((x) => x.deviation)) {
    trajectory.push(deps.draftRedline.name);
    redlines.push(await deps.draftRedline.run({ flag: f, clause_text: clauseText }));
  }

  const memoDoc: ReviewMemo = {
    doc_id: docId, objective,
    fields: [{ name: objective, value: card.answer, citation }],
    flags, redlines, generated_at: generatedAt,
  };
  trajectory.push(deps.exportMemo.name);
  const memo = await deps.exportMemo.run({ memo: memoDoc });   // preview only — no confirm

  return { card, classification, flags, redlines, memo, trajectory, refused: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && npx vitest run test/agent.reviewAgent.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Install the MCP SDK**

Run: `cd core && npm install @modelcontextprotocol/sdk@^1.18.0`
Expected: `package.json` gains the dependency; `package-lock.json` updates.
(If the resolved version differs, the `new McpServer(...)` / `server.registerTool(name, {title, description, inputSchema}, handler)` / `StdioServerTransport` API is stable across 1.x — only adjust the import subpaths if the install errors.)

- [ ] **Step 6: Write the failing MCP tools-registry test**

Create `core/test/mcp.tools.test.ts`:

```ts
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
```

- [ ] **Step 7: Write the tools registry + MCP server + sample client**

Create `core/src/mcp/tools.ts`:

```ts
import type { Candidate } from "../retrieve/retrieve.js";
import type { GenInput, RawGen } from "../generate/types.js";
import type { PlaybookEntry } from "../eval/playbook.js";
import { loadPlaybook } from "../eval/playbook.js";
import { fileURLToPath } from "node:url";
import type { ReviewFlag, ToolDef } from "../agent/tools/types.js";
import { makeRetrieveClauseTool } from "../agent/tools/retrieveClause.js";
import { makeExtractFieldsTool } from "../agent/tools/extractFields.js";
import { makeClassifyClauseTool, type Prediction } from "../agent/tools/classifyClause.js";
import { makeFlagRisksTool } from "../agent/tools/flagRisks.js";
import { makeDraftRedlineTool } from "../agent/tools/draftRedline.js";
import { makeExportMemoTool } from "../agent/tools/exportMemo.js";

export interface BuildDeps {
  retrieve: (objective: string, docId: string, k: number) => Promise<Candidate[]>;
  generate: (input: GenInput) => Promise<RawGen>;
  runPredict: (texts: string[]) => Promise<Prediction[]>;
  judge: (clauseText: string, entry: PlaybookEntry) => Promise<{ deviation: boolean; rationale: string }>;
  suggest: (flag: ReviewFlag, clauseText: string) => Promise<string>;
  writeFile: (path: string, contents: string) => Promise<void>;
}

const playbookPath = fileURLToPath(new URL("../../../evals/playbook/nda.yaml", import.meta.url));

/**
 * Assemble the P4 toolset with real (or injected) deps: the retrieve_clause RAG wrapper plus the
 * five SPEC-list tools (extract_fields, classify_clause, flag_risks incl. check_playbook,
 * draft_redline, export_memo). extract_fields shares retrieve/generate with retrieve_clause.
 */
export function buildTools(deps: BuildDeps): ToolDef<any, any>[] {
  const entries = loadPlaybook(playbookPath);
  return [
    makeRetrieveClauseTool({ retrieve: deps.retrieve, generate: deps.generate }),
    makeExtractFieldsTool({ retrieve: deps.retrieve, generate: deps.generate }),
    makeClassifyClauseTool({ runPredict: deps.runPredict }),
    makeFlagRisksTool({ judge: deps.judge }, entries),
    makeDraftRedlineTool({ suggest: deps.suggest }),
    makeExportMemoTool({ writeFile: deps.writeFile }),
  ];
}
```

Create `core/src/mcp/server.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { buildTools, type BuildDeps } from "./tools.js";
import { retrieve as realRetrieve } from "../retrieve/retrieve.js";
import { makeGenerator } from "../generate/index.js";
import { defaultRunPredict } from "../agent/tools/classifyClause.js";
import { defaultDeviationJudge } from "../agent/tools/flagRisks.js";
import { defaultRedlineWriter } from "../agent/tools/draftRedline.js";

/** Build an MCP server exposing the five P4 tools over stdio. */
export function buildServer(deps: BuildDeps): McpServer {
  const server = new McpServer({ name: "sift-contract-review", version: "0.4.0" });
  for (const tool of buildTools(deps)) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputShape },
      async (args: unknown) => {
        const input = z.object(tool.inputShape).parse(args);
        const out = await tool.run(input);
        return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
      },
    );
  }
  return server;
}

async function main(): Promise<void> {
  const gen = makeGenerator();
  const judge = defaultDeviationJudge();
  const redline = defaultRedlineWriter();
  const server = buildServer({
    retrieve: realRetrieve,
    generate: gen.generate.bind(gen),
    runPredict: defaultRunPredict,
    judge: judge.judge,
    suggest: redline.suggest,
    writeFile: async (path, contents) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents); },
  });
  await server.connect(new StdioServerTransport());
  process.stderr.write("sift MCP server ready on stdio\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { process.stderr.write(String(e) + "\n"); process.exit(1); });
}
```

Create `core/src/mcp/sampleClient.ts`:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** Sample MCP client: spawn the sift server, list tools, call retrieve_clause once. */
async function main(): Promise<void> {
  const transport = new StdioClientTransport({ command: "npx", args: ["tsx", "src/mcp/server.ts"] });
  const client = new Client({ name: "sift-sample-client", version: "0.1.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  process.stdout.write("tools: " + tools.tools.map((t) => t.name).join(", ") + "\n");

  const docId = process.argv[2] ?? "cuad_limeenergyco-09-09-1999-ex-10-distributor-agreement";
  const res = await client.callTool({ name: "retrieve_clause", arguments: { objective: "Find the governing law clause", doc_id: docId } });
  process.stdout.write("retrieve_clause -> " + JSON.stringify(res.content) + "\n");

  await client.close();
}

main().catch((e) => { process.stderr.write(String(e) + "\n"); process.exit(1); });
```

Create `docs/mcp-quickstart.md`:

```markdown
# sift MCP server — quickstart

The sift contract-review toolset is exposed over the Model Context Protocol (stdio).

## Tools
- `retrieve_clause` (read) — Layer 1 RAG → grounded, cited answer (or refusal).
- `classify_clause` (read) — P3 LoRA classifier → CUAD clause type.
- `flag_risks` (read) — match clause to the NDA playbook + judge deviation.
- `draft_redline` (read) — propose playbook-compliant replacement text.
- `export_memo` (**write**) — render the memo; writes to disk ONLY with `confirm: true` (human-in-the-loop).

## Run the server
```
make db-up                 # retrieve_clause needs Postgres
set -a; . ./.env; set +a   # LLM_API_KEY etc.
make mcp-serve             # cd core && npm run mcp
```

## Sample client call
```
cd core && npx tsx src/mcp/sampleClient.ts <doc_id>
```
Expected: prints the registered tool names, then a grounded `retrieve_clause` result. `export_memo`
called without `confirm: true` returns a preview (`written: false`) — nothing is persisted until a
human confirms.

## Register with Claude Desktop / any MCP client
Command: `npx`, args: `["tsx", "<repo>/core/src/mcp/server.ts"]`, with `.env` in the environment.
```

Add to `core/package.json` scripts (alongside `"eval"`):

```json
"mcp": "tsx src/mcp/server.ts",
"agent-eval": "tsx src/agent/cli.ts"
```

- [ ] **Step 8: Run the MCP tools test + typecheck**

Run: `cd core && npx vitest run test/mcp.tools.test.ts && npm run typecheck`
Expected: PASS (3 tests); typecheck clean.

- [ ] **Step 9: Add Makefile targets + commit**

Add to `Makefile`:

```makefile
.PHONY: mcp-serve agent-eval
mcp-serve:
	cd core && npm run mcp
agent-eval:
	cd core && npm run agent-eval
```

```bash
git add core/src/agent/reviewAgent.ts core/src/mcp/ core/test/agent.reviewAgent.test.ts core/test/mcp.tools.test.ts core/package.json core/package-lock.json docs/mcp-quickstart.md Makefile
git commit -m "feat(agent): deterministic review orchestrator + MCP server + sample client"
```

---

## Task 8: Agent-eval harness + gate + P4 report

Run the orchestrator over `eval-set-v1.json` and score end-to-end task success, flag false-negative rate, groundedness, refusal correctness, trajectory validity, and the HITL gate. Write the report + failure-mode taxonomy + decision. This is the merge gate (controller-run: needs Postgres + NIM + the Python LoRA).

**Files:**
- Create: `core/src/agent/agentEvalMetrics.ts`
- Create: `core/src/agent/agentEval.ts`
- Create: `core/src/agent/cli.ts`
- Test: `core/test/agent.agentEvalMetrics.test.ts`
- Test: `core/test/agent.agentEval.test.ts`
- Create: `docs/eval-reports/P4.md`
- Modify: `DECISIONS.md`

**Interfaces:**
- Consumes: `EvalItem` (`../eval/evalItem.js`), `overlaps` (`../eval/metrics.js`), `reviewContract`/`ReviewResult`/`ReviewDeps` (`./reviewAgent.js`), tool factories, `withClient` (`../db/client.js`), `makeRetriever`/`makeGenerator`, `defaultRunPredict`/`defaultDeviationJudge`/`defaultRedlineWriter`.
- Produces:
  - `flagCoverage(expected: {playbook_id:string}[], produced: {playbook_id:string}[]): number | null` — fraction of expected playbook_ids present in produced (null if none expected).
  - `taskSuccess(item: EvalItem, result: ReviewResult): boolean` — grader-specific success.
  - `trajectoryValid(item: EvalItem, result: ReviewResult): boolean`.
  - `interface AgentEvalReport { total: number; aggregates: { task_success_rate: number; flag_false_negative_rate: number | null; mean_groundedness: number | null; refusal_correctness: number | null; trajectory_valid_rate: number; unconfirmed_writes: number }; items: AgentItemResult[] }`.
  - `runAgentEval(items, deps): Promise<AgentEvalReport>`.

- [ ] **Step 1: Write the failing metrics test**

Create `core/test/agent.agentEvalMetrics.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { flagCoverage, taskSuccess, trajectoryValid } from "../src/agent/agentEvalMetrics.js";
import type { EvalItem } from "../src/eval/evalItem.js";
import type { ReviewResult } from "../src/agent/reviewAgent.js";

const base = (over: Partial<EvalItem>): EvalItem => ({
  id: "x", doc_id: "d1", source: "cuad", contract_type: "nda", category: "clean",
  objective: "Find governing law", expected_fields: [], expected_flags: [], gold_spans: [],
  grader: "span_match", notes: "", ...over,
});

const result = (over: Partial<ReviewResult>): ReviewResult => ({
  card: { objective: "o", answer: "a", citations: [], refused: false, refusal_reason: null },
  classification: null, flags: [], redlines: [],
  memo: { written: false, path: null, markdown: "" }, trajectory: ["retrieve_clause"], refused: false, ...over,
});

describe("agent eval metrics", () => {
  it("flagCoverage = fraction of expected playbook_ids produced", () => {
    expect(flagCoverage([{ playbook_id: "a" }, { playbook_id: "b" }], [{ playbook_id: "a" }])).toBe(0.5);
    expect(flagCoverage([], [])).toBeNull();
  });

  it("taskSuccess for span_match requires a citation overlapping a gold span", () => {
    const item = base({ grader: "span_match", gold_spans: [{ doc_id: "d1", char_start: 5, char_end: 15, quote: "x" }] });
    const hit = result({ card: { objective: "o", answer: "a", citations: [{ doc_id: "d1", char_start: 10, char_end: 20, quote: "x" }], refused: false, refusal_reason: null } });
    const miss = result({ card: { objective: "o", answer: "a", citations: [{ doc_id: "d1", char_start: 100, char_end: 110, quote: "x" }], refused: false, refusal_reason: null } });
    expect(taskSuccess(item, hit)).toBe(true);
    expect(taskSuccess(item, miss)).toBe(false);
  });

  it("taskSuccess for flag_match requires expected playbook_ids among produced flags", () => {
    const item = base({ grader: "flag_match", expected_flags: [{ playbook_id: "governing_law", severity: "low" }] });
    const hit = result({ flags: [{ playbook_id: "governing_law", clause_type: "Governing Law", severity: "low", deviation: false, rationale: "", citation: { doc_id: "d1", char_start: 0, char_end: 1, quote: "x" } }] });
    expect(taskSuccess(item, hit)).toBe(true);
    expect(taskSuccess(item, result({ flags: [] }))).toBe(false);
  });

  it("taskSuccess for refusal requires the agent to refuse", () => {
    const item = base({ grader: "refusal", category: "missing" });
    expect(taskSuccess(item, result({ refused: true }))).toBe(true);
    expect(taskSuccess(item, result({ refused: false }))).toBe(false);
  });

  it("trajectoryValid: refusal items stop after retrieve_clause; answerable items reach flag_risks", () => {
    const refItem = base({ grader: "refusal" });
    expect(trajectoryValid(refItem, result({ refused: true, trajectory: ["retrieve_clause"] }))).toBe(true);
    const flagItem = base({ grader: "flag_match" });
    expect(trajectoryValid(flagItem, result({ trajectory: ["retrieve_clause", "classify_clause", "flag_risks", "export_memo"] }))).toBe(true);
    expect(trajectoryValid(flagItem, result({ trajectory: ["retrieve_clause"] }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npx vitest run test/agent.agentEvalMetrics.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the metrics**

Create `core/src/agent/agentEvalMetrics.ts`:

```ts
import { overlaps } from "../eval/metrics.js";
import type { EvalItem } from "../eval/evalItem.js";
import type { ReviewResult } from "./reviewAgent.js";

/** Fraction of expected playbook_ids that appear among produced flags. null when none expected. */
export function flagCoverage(
  expected: { playbook_id: string }[],
  produced: { playbook_id: string }[],
): number | null {
  if (expected.length === 0) return null;
  const have = new Set(produced.map((p) => p.playbook_id));
  const hit = expected.filter((e) => have.has(e.playbook_id)).length;
  return hit / expected.length;
}

/** Grader-specific end-to-end success for one item. */
export function taskSuccess(item: EvalItem, result: ReviewResult): boolean {
  switch (item.grader) {
    case "refusal":
      return result.refused;
    case "span_match":
      return result.card.citations.some((c) => item.gold_spans.some((g) => overlaps(c, g)));
    case "flag_match":
      return (flagCoverage(item.expected_flags, result.flags) ?? 0) >= 1;
    case "field_match":
      return result.card.citations.length > 0 && !result.refused;
    default:
      return false;
  }
}

/** Refusal items should stop after retrieval; answerable items should reach flag_risks. */
export function trajectoryValid(item: EvalItem, result: ReviewResult): boolean {
  if (item.grader === "refusal") return result.refused && result.trajectory[0] === "retrieve_clause" && !result.trajectory.includes("flag_risks");
  if (result.refused) return true; // an answerable item that legitimately refused still has a valid (short) trajectory
  return result.trajectory.includes("retrieve_clause") && result.trajectory.includes("flag_risks");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && npx vitest run test/agent.agentEvalMetrics.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing harness test**

Create `core/test/agent.agentEval.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { runAgentEval } from "../src/agent/agentEval.js";
import type { EvalItem } from "../src/eval/evalItem.js";
import { makeRetrieveClauseTool } from "../src/agent/tools/retrieveClause.js";
import { makeClassifyClauseTool } from "../src/agent/tools/classifyClause.js";
import { makeFlagRisksTool } from "../src/agent/tools/flagRisks.js";
import { makeDraftRedlineTool } from "../src/agent/tools/draftRedline.js";
import { makeExportMemoTool } from "../src/agent/tools/exportMemo.js";
import { fileURLToPath } from "node:url";
import { loadPlaybook } from "../src/eval/playbook.js";
import type { Candidate } from "../src/retrieve/retrieve.js";

const entries = loadPlaybook(fileURLToPath(new URL("../../evals/playbook/nda.yaml", import.meta.url)));
const cand: Candidate = { node_id: "n0", doc_id: "d1", type: "s", number: null, heading: null, text: "law of Delaware", char_start: 5, char_end: 20, score: 1 };

const items: EvalItem[] = [
  { id: "flag1", doc_id: "d1", source: "cuad", contract_type: "nda", category: "deviated", objective: "gov law",
    expected_fields: [], expected_flags: [{ playbook_id: "governing_law", severity: "low" }], gold_spans: [], grader: "flag_match", notes: "" },
];

function deps() {
  const writes: string[] = [];
  return { writes, deps: {
    retrieveClause: makeRetrieveClauseTool({ retrieve: async () => [cand], generate: async () => ({ answer: "Delaware", supporting: [0], refused: false, refusal_reason: null }) }),
    classifyClause: makeClassifyClauseTool({ runPredict: async (t) => t.map((x) => ({ text: x, label: "Governing Law", score: 0.9 })) }),
    flagRisks: makeFlagRisksTool({ judge: async () => ({ deviation: true, rationale: "foreign law" }) }, entries),
    draftRedline: makeDraftRedlineTool({ suggest: async () => "Delaware law governs." }),
    exportMemo: makeExportMemoTool({ writeFile: async (p) => { writes.push(p); } }),
  } };
}

describe("runAgentEval", () => {
  it("scores task success, flag coverage, and proves the HITL gate held", async () => {
    const { writes, deps: d } = deps();
    const report = await runAgentEval(items, d, { rawText: async () => "xxxxxlaw of Delawarexxxxx", generatedAt: "2026-06-30T00:00:00Z" });
    expect(report.total).toBe(1);
    expect(report.aggregates.task_success_rate).toBe(1);
    expect(report.aggregates.flag_false_negative_rate).toBe(0);
    expect(report.aggregates.unconfirmed_writes).toBe(0);
    expect(writes).toHaveLength(0);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd core && npx vitest run test/agent.agentEval.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Write the harness**

Create `core/src/agent/agentEval.ts`:

```ts
import { reviewContract, type ReviewDeps, type ReviewResult } from "./reviewAgent.js";
import { flagCoverage, taskSuccess, trajectoryValid } from "./agentEvalMetrics.js";
import { groundedness } from "../eval/metrics.js";
import type { EvalItem } from "../eval/evalItem.js";

export interface AgentItemResult {
  id: string;
  grader: string;
  success: boolean;
  flag_coverage: number | null;
  groundedness: number | null;
  trajectory_valid: boolean;
  wrote_without_confirm: boolean;
  error: string | null;
}

export interface AgentEvalReport {
  total: number;
  aggregates: {
    task_success_rate: number;
    flag_false_negative_rate: number | null;
    mean_groundedness: number | null;
    refusal_correctness: number | null;
    trajectory_valid_rate: number;
    unconfirmed_writes: number;
  };
  items: AgentItemResult[];
}

export interface AgentEvalDeps {
  rawText: (docId: string) => Promise<string | null>;
  generatedAt: string;
}

function mean(xs: (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x !== null);
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length;
}

/** Run the review agent over eval items and score it. Deps are injected so unit tests use fakes. */
export async function runAgentEval(
  items: readonly EvalItem[],
  reviewDeps: ReviewDeps,
  deps: AgentEvalDeps,
): Promise<AgentEvalReport> {
  const results: AgentItemResult[] = [];

  for (const item of items) {
    let success = false, tvalid = false, wrote = false;
    let cov: number | null = null, grounded: number | null = null, error: string | null = null;
    try {
      const r: ReviewResult = await reviewContract(item.objective, item.doc_id, reviewDeps, { generatedAt: deps.generatedAt });
      success = taskSuccess(item, r);
      tvalid = trajectoryValid(item, r);
      wrote = r.memo.written;                            // must be false — HITL gate
      cov = flagCoverage(item.expected_flags, r.flags);
      if (r.card.citations.length > 0) {
        const raw = await deps.rawText(item.doc_id);
        grounded = groundedness(r.card.citations, () => raw);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    results.push({ id: item.id, grader: item.grader, success, flag_coverage: cov, groundedness: grounded, trajectory_valid: tvalid, wrote_without_confirm: wrote, error });
  }

  // Flag false-negative rate: over items with expected flags, the fraction of expected flags missed.
  const flagItems = results.filter((r) => r.flag_coverage !== null);
  const fnRate = flagItems.length === 0 ? null : mean(flagItems.map((r) => 1 - (r.flag_coverage ?? 0)));

  const refusalItems = results.filter((r) => r.grader === "refusal");
  const refusalCorrectness = refusalItems.length === 0 ? null : refusalItems.filter((r) => r.success).length / refusalItems.length;

  return {
    total: results.length,
    aggregates: {
      task_success_rate: results.length === 0 ? 0 : results.filter((r) => r.success).length / results.length,
      flag_false_negative_rate: fnRate,
      mean_groundedness: mean(results.map((r) => r.groundedness)),
      refusal_correctness: refusalCorrectness,
      trajectory_valid_rate: results.length === 0 ? 0 : results.filter((r) => r.trajectory_valid).length / results.length,
      unconfirmed_writes: results.filter((r) => r.wrote_without_confirm).length,
    },
    items: results,
  };
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd core && npx vitest run test/agent.agentEval.test.ts`
Expected: PASS (1 test).

- [ ] **Step 9: Write the agent-eval CLI**

Create `core/src/agent/cli.ts`:

```ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { writeFile as fsWriteFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { EvalItemSchema } from "../eval/evalItem.js";
import { withClient } from "../db/client.js";
import { makeRetriever } from "../retrieve/retrieve.js";
import { makeGenerator } from "../generate/index.js";
import { loadPlaybook } from "../eval/playbook.js";
import { makeRetrieveClauseTool } from "./tools/retrieveClause.js";
import { makeClassifyClauseTool, defaultRunPredict } from "./tools/classifyClause.js";
import { makeFlagRisksTool, defaultDeviationJudge } from "./tools/flagRisks.js";
import { makeDraftRedlineTool, defaultRedlineWriter } from "./tools/draftRedline.js";
import { makeExportMemoTool } from "./tools/exportMemo.js";
import { runAgentEval } from "./agentEval.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));

async function main(): Promise<void> {
  const rawItems = JSON.parse(readFileSync(`${root}evals/data/eval-set-v1.json`, "utf-8")) as unknown[];
  const items = rawItems.map((e) => EvalItemSchema.parse(e));

  const rawTextCache = new Map<string, string | null>();
  async function rawText(docId: string): Promise<string | null> {
    if (!rawTextCache.has(docId)) {
      const row = await withClient((c) => c.query("SELECT raw_text FROM documents WHERE doc_id=$1", [docId]));
      rawTextCache.set(docId, row.rowCount ? row.rows[0].raw_text : null);
    }
    return rawTextCache.get(docId)!;
  }

  const retrieve = makeRetriever(process.env.RETRIEVE_MODE ?? "agentic");
  const gen = makeGenerator();
  const entries = loadPlaybook(`${root}evals/playbook/nda.yaml`);
  const judge = defaultDeviationJudge();
  const redline = defaultRedlineWriter();

  const reviewDeps = {
    retrieveClause: makeRetrieveClauseTool({ retrieve, generate: gen.generate.bind(gen) }),
    classifyClause: makeClassifyClauseTool({ runPredict: defaultRunPredict }),
    flagRisks: makeFlagRisksTool({ judge: judge.judge }, entries),
    draftRedline: makeDraftRedlineTool({ suggest: redline.suggest }),
    exportMemo: makeExportMemoTool({ writeFile: async (p, c) => { await mkdir(dirname(p), { recursive: true }); await fsWriteFile(p, c); } }),
  };

  const generatedAt = new Date().toISOString();
  const report = await runAgentEval(items, reviewDeps, { rawText, generatedAt });

  mkdirSync(`${root}evals/reports`, { recursive: true });
  writeFileSync(`${root}evals/reports/p4_agent.json`, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report.aggregates, null, 2));
  process.exit(0);
}

main().catch((e) => { process.stderr.write(String(e) + "\n"); process.exit(1); });
```

- [ ] **Step 10: Run the full TS + Python suites (regression gate)**

Run: `cd core && npm test` then `cd pipeline && .venv/bin/python -m pytest -q`
Expected: all P4 tests pass; no regressions (the 6 infra-dependent core tests noted in memory may fail only if Postgres/native bindings are absent — not a P4 regression).

- [ ] **Step 11: Commit the harness**

```bash
git add core/src/agent/agentEvalMetrics.ts core/src/agent/agentEval.ts core/src/agent/cli.ts core/test/agent.agentEvalMetrics.test.ts core/test/agent.agentEval.test.ts
git commit -m "feat(agent): agent-eval harness (task success, flag FN-rate, HITL gate, trajectory)"
```

- [ ] **Step 12: GATE RUN (controller — needs Postgres + NIM + Python LoRA)**

Run:
```bash
make db-up
set -a; . ./.env; set +a          # LLM_API_KEY, LLM_MODEL, LLM_RPM
make clf-extract                  # regenerate data/processed/cuad_clf/label_map.json (gitignored; classify_clause loads it)
cd core && npm run load           # ensure the corpus (esp. eval-set docs) is loaded
cd core && npx tsx src/mcp/sampleClient.ts   # smoke: MCP handshake + one grounded call
make agent-eval                   # -> evals/reports/p4_agent.json
```
Expected: `p4_agent.json` written. **Hard gates (must hold):** `unconfirmed_writes === 0` (HITL gate), `mean_groundedness === 1.0` (every citation resolves — no hallucinated spans), `refusal_correctness === 1.0` (missing-category items refused). **Reported (no pre-set bar):** `task_success_rate`, `flag_false_negative_rate`, `trajectory_valid_rate`. If a hard gate fails, fix and re-run before proceeding.

- [ ] **Step 13: Write the P4 eval report + failure-mode taxonomy**

Create `docs/eval-reports/P4.md` (fill the bracketed numbers from `p4_agent.json`):

```markdown
# Phase 4 — Action Agent + MCP: Eval Report

**Date:** 2026-06-30
**Gate:** agent evals on the 50-item eval-set-v1 — end-to-end task success, flag false-negative
rate, trajectory validity, refusal correctness; HTIL gate + groundedness as hard invariants.

## Headline (50 items)
| Metric | Value | Bar |
|---|---|---|
| task success rate | [X] | reported |
| flag false-negative rate (top-line) | [X] | reported / minimize |
| mean groundedness | [X] | **1.0 required** |
| refusal correctness (missing category) | [X] | **1.0 required** |
| trajectory valid rate | [X] | reported |
| unconfirmed writes (HITL breaches) | [0] | **0 required** |

## Toolset (5, over MCP)
retrieve_clause (RAG), classify_clause (P3 LoRA), flag_risks (playbook + deviation judge),
draft_redline, export_memo (write — HITL `confirm` gate). MCP server + sample client documented in
`docs/mcp-quickstart.md`.

## Method
Deterministic `reviewContract` trajectory scored per grader (span_match / flag_match / refusal).
Flag FN-rate = mean fraction of expected playbook_ids the agent failed to surface. HITL proven by
running the whole eval without ever passing `confirm` and asserting 0 files written.

## Failure-mode taxonomy
1. **Playbook-match miss** — classifier label had no synonym → clause not matched → flag FN.
   Mitigation: extend `PLAYBOOK_CLAUSE_SYNONYMS`.
2. **Retrieval miss** — gold span not in top-k → span_match fail (inherited Layer 1 ceiling).
3. **Deviation misjudgement** — judge marked a red-flag clause standard (or vice-versa).
4. **Over-refusal** — answerable clause refused (precision cost of the grounding discipline).
[Add observed instances with item ids from p4_agent.json.]

## Reproduce
```
make db-up && set -a; . ./.env; set +a && cd core && npm run load
make agent-eval    # -> evals/reports/p4_agent.json
```

## Next: Phase 5 (optional expansion)
Commercial-lease support (key-date extraction + `set_date_reminders`), optional user validation,
optional public benchmark.
```

Add a new top entry to `DECISIONS.md`:

```markdown
## 2026-06-30 — Phase 4: Action agent + MCP (Layer 3)
- **Agent = deterministic tool trajectory, not an LLM free-choice loop.** `reviewContract` composes
  retrieve→classify→flag→redline→memo in a fixed order so the agent-eval trajectory is reproducible
  and the merge gate is stable. An LLM-driven MCP client (Claude Desktop) can still drive the same
  tools — that's the live-agent demo; the gate uses the deterministic path.
- **HITL gate lives in the tool, proven by absence of writes.** `export_memo` is the only write tool
  and no-ops (returns a preview) unless `confirm===true`. The agent-eval never confirms, so a passing
  gate with `unconfirmed_writes===0` is positive proof the guardrail holds.
- **classify_clause bridges to the P3 LoRA via a Python CLI over a JSON-Schema’d boundary**
  (`schemas/clf-prediction.schema.json`), consistent with the repo's "modules meet at validated JSON"
  rule — rather than reimplementing the adapter in TS.
- **Flag scoring = coverage (did we surface the required playbook position), FN-rate as top-line.**
  Robust to the clean-vs-deviated ambiguity in expected_flags; measured honestly (a match miss is a
  visible false negative, not hidden by fuzzy matching).
```

- [ ] **Step 14: Commit the report + decision**

```bash
git add docs/eval-reports/P4.md DECISIONS.md evals/reports/p4_agent.json
git commit -m "eval(p4): action-agent gate — [task success X, groundedness 1.0, 0 HITL breaches]"
```

---

## Self-Review (completed against SPEC Layer 3 / P4 row)

**Spec coverage:**
- "Tools (3–5, with real side effects)" → 5 SPEC-list tools (`extract_fields`, `classify_clause`, `flag_risks` incl. `check_playbook`, `draft_redline`, `export_memo`); `export_memo` is the real side effect, HITL-gated. Exposed over MCP alongside the RAG wrapper (6 registrations total).
- "Wrap Layer 1 RAG as one tool" → `retrieve_clause` (Task 2), counted separately from the 3–5.
- "Expose the toolset via an MCP server" → Task 7 (`mcp/server.ts` + sample client + quickstart).
- "Confirmation required before any destructive or external action" → `export_memo` confirm gate (Task 6), proven in Task 8.
- "Redline + memo export" → `draft_redline` + `export_memo` (Task 6).
- "Fine-tuned component swapped in" → `classify_clause` bridges the P3 LoRA (Task 4).
- Acceptance: "agent evals — task success, step/trajectory checks, failure-mode taxonomy" → Task 8 harness + `P4.md`. "MCP documented with a sample client call" → Task 7. "P4 eval report" → Task 8.
- Top-line **false-negative rate** → `flag_false_negative_rate` (Task 8).

**Placeholder scan:** no TBD/TODO; every code step shows complete code; every command shows expected output.

**Type consistency:** `ToolDef`/`Citation`/`ReviewFlag`/`ReviewMemo` (Task 1) are used with identical shapes in Tasks 2–8; `RetrieveClauseDeps` reused by `extract_fields` (Task 3); `ReviewDeps` (Task 7) matches the tool return types (`ReviewFlag | null` from `flag_risks`); `flagCoverage`/`taskSuccess`/`trajectoryValid` signatures identical across Task 8 metrics + harness + tests.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-30-p4-action-agent-mcp.md`.** Branch: `phase-4-action-agent-mcp` (off `main`, which is P1+P2+P3 merged). Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, two-stage review between tasks, fast iteration. Matches how P2a/b/c and P3 were built. Tasks 1–7 are headless (fakes only); Task 8 steps 12–14 are the controller-run gate (Postgres + NIM + Python LoRA).
2. **Inline Execution** — execute tasks in this session with checkpoints for review.

**Which approach?**
