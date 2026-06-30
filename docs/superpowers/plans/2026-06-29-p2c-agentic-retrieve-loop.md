# P2c — Agentic retrieve→evaluate loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `agentic` retrieval mode — retrieve → LLM sufficiency judge → (if insufficient) one multi-query reformulation round, fused and reranked — that rescues one-shot retrieval misses while holding groundedness and preserving refusal on out-of-scope questions.

**Architecture:** A new `agenticRetrieve` composes the four P2a primitives (`dense`, `lexical`, `rrfFuse`, `rerank`) plus an injected LLM `judge`, generalized from one query to N and wrapped in a bounded loop. It lives behind the existing `makeRetriever` factory as `RETRIEVE_MODE=agentic` and returns the same `Candidate[]`, so the eval runner, metrics, and SSE route are untouched. The generator keeps ownership of refusal. All LLM calls (generator + judge) share one process-level rpm throttle.

**Tech Stack:** TypeScript / Node 20, ESM (`moduleResolution: Bundler`, but relative imports use `.js` extensions to match the codebase), Zod for tolerant parsing, `openai` SDK against NIM (OpenAI-compatible), `@huggingface/transformers` cross-encoder (reused from P2a), Postgres + pgvector, vitest.

## Global Constraints

(Copied from the spec and `CLAUDE.md`; every task's requirements implicitly include these.)

- **Citation grounding is `quote === raw_text.slice(char_start, char_end)`** exactly (strict `===`, no trim/normalize). P2c does not touch citation construction, but must not regress it.
- **Typed payloads only** — validate every cross-boundary artifact with Zod (TS). The judge's LLM output is parsed with a tolerant Zod schema; a parse failure is a safe fallback, never a throw across the boundary.
- **Refuse when ungrounded** — "insufficient context" is a correct answer. The generator owns the final refusal; the loop must not manufacture context. The `missing` eval category MUST still refuse.
- **All DB access goes through `core/src/db/`** — the loop only calls `dense`/`lexical`, which already do.
- **Vector backend swappable via config** — unchanged; no direct DB access added.
- **Evals are the merge gate** — no task is done until its test/eval passes; the p2a→p2c delta table + the `missing`-category refusal check is the final gate.
- **Relative imports use `.js` extensions** (e.g. `from "./judge.js"`), matching every existing file.
- **Tests run with `cd core && npm test`** (vitest); a single file: `cd core && npx vitest run test/<file>.test.ts`.
- **Degrade, never crash** — a judge or rerank failure falls back to a valid retrieval result and logs to stderr; it never aborts a query.
- **No new model download in the hot path beyond P2a's reranker.** The judge reuses the configured LLM provider/model (`LLM_PROVIDER` / `LLM_MODEL`).

---

## File Structure

**New files:**
- `core/src/llm/throttle.ts` — shared process-level request pacing (`reserveSlot`, `resolveMinIntervalMs`). One responsibility: keep combined LLM request rate under the rpm cap.
- `core/test/llm.throttle.test.ts` — pacing + shared-budget + no-throttle tests.
- `core/src/agent/judge.ts` — `judgeSufficiency(objective, candidates, deps?)`: the LLM sufficiency judge. One responsibility: decide sufficiency + propose reformulations, degrading safely.
- `core/test/agent.judge.test.ts` — verdict parsing, reformulation cap, degrade-on-failure.
- `core/src/agent/loop.ts` — `agenticRetrieve(...)`: the bounded retrieve→judge→reformulate loop. One responsibility: compose primitives + judge into the final `Candidate[]`.
- `core/test/agent.loop.test.ts` — orchestration with injected fakes (no DB/LLM).

**Modified files:**
- `core/src/generate/openaiCompat.ts` — move the inline throttle to `llm/throttle.ts`; call `reserveSlot`; re-export `resolveMinIntervalMs` for back-compat.
- `core/src/retrieve/retrieve.ts` — `makeRetriever` gains the `agentic` branch.
- `core/src/eval/cli.ts` — stamp `agent_max_rounds`; extend `rerank_model` to agentic; `outName` learns `agentic → p2c.json`.
- `docs/superpowers/specs/2026-06-29-p2c-agentic-retrieve-loop-design.md` — fill the Results section (Task 5).

**New test files (also new):**
- `core/test/retrieve.agentic-routing.test.ts` — asserts `makeRetriever("agentic")` routes to `agenticRetrieve`.

---

## Task 1: Shared LLM throttle

Extract the generator's per-instance throttle into a process-level shared module so the judge and the generator draw from one rpm budget. The generator's external behavior is unchanged.

**Files:**
- Create: `core/src/llm/throttle.ts`
- Create: `core/test/llm.throttle.test.ts`
- Modify: `core/src/generate/openaiCompat.ts`

**Interfaces:**
- Produces:
  - `resolveMinIntervalMs(env?: NodeJS.ProcessEnv): number` — moved verbatim from `openaiCompat.ts`.
  - `reserveSlot(minIntervalMs: number): Promise<void>` — awaits until the next allowed slot; `<= 0` returns immediately without advancing the clock.
  - `__resetThrottle(): void` — test-only clock reset.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test**

Create `core/test/llm.throttle.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { reserveSlot, resolveMinIntervalMs, __resetThrottle } from "../src/llm/throttle.js";

describe("reserveSlot", () => {
  beforeEach(() => __resetThrottle());

  it("does not wait when minIntervalMs <= 0", async () => {
    const t0 = Date.now();
    await reserveSlot(0);
    await reserveSlot(0);
    expect(Date.now() - t0).toBeLessThan(20);
  });

  it("paces successive calls by at least minIntervalMs", async () => {
    const times: number[] = [];
    await reserveSlot(40); times.push(Date.now());
    await reserveSlot(40); times.push(Date.now());
    await reserveSlot(40); times.push(Date.now());
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(35);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(35);
  });

  it("shares one budget across independent callers", async () => {
    // Three callers reserving from the same module clock must serialize: slots at
    // 0, 50, 100 → the last resolves ~100ms after the first.
    const start = Date.now();
    await Promise.all([reserveSlot(50), reserveSlot(50), reserveSlot(50)]);
    expect(Date.now() - start).toBeGreaterThanOrEqual(90);
  });
});

describe("resolveMinIntervalMs", () => {
  it("derives the inter-request interval from LLM_RPM", () => {
    expect(resolveMinIntervalMs({ LLM_RPM: "40" } as NodeJS.ProcessEnv)).toBe(1500);
  });
  it("lets LLM_MIN_INTERVAL_MS override LLM_RPM", () => {
    expect(resolveMinIntervalMs({ LLM_RPM: "40", LLM_MIN_INTERVAL_MS: "250" } as NodeJS.ProcessEnv)).toBe(250);
  });
  it("returns 0 (no throttle) when unset or invalid", () => {
    expect(resolveMinIntervalMs({} as NodeJS.ProcessEnv)).toBe(0);
    expect(resolveMinIntervalMs({ LLM_RPM: "abc" } as NodeJS.ProcessEnv)).toBe(0);
    expect(resolveMinIntervalMs({ LLM_RPM: "0" } as NodeJS.ProcessEnv)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npx vitest run test/llm.throttle.test.ts`
Expected: FAIL — cannot resolve `../src/llm/throttle.js` (module does not exist).

- [ ] **Step 3: Create the throttle module**

Create `core/src/llm/throttle.ts`:

```ts
/**
 * Shared client-side request pacing for all LLM callers in the process
 * (the generator and the agentic sufficiency judge), so their COMBINED request
 * rate stays under the provider's rpm cap. A single module-level slot clock means
 * two callers cannot each independently burst to the limit.
 */

let nextAllowedAt = 0;

/**
 * Minimum spacing (ms) between outgoing requests. `LLM_MIN_INTERVAL_MS` is an
 * explicit override; otherwise derived from `LLM_RPM` (60000 / rpm). Unset or
 * invalid → 0 (no throttle), preserving the original behavior.
 */
export function resolveMinIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const explicit = env.LLM_MIN_INTERVAL_MS;
  if (explicit != null && explicit !== "") {
    const ms = Number(explicit);
    if (Number.isFinite(ms) && ms > 0) return Math.ceil(ms);
  }
  const rpm = env.LLM_RPM;
  if (rpm != null && rpm !== "") {
    const n = Number(rpm);
    if (Number.isFinite(n) && n > 0) return Math.ceil(60000 / n);
  }
  return 0;
}

/**
 * Reserve the next outgoing-request time slot; resolves after waiting if needed.
 * Shared across all callers in the process. `minIntervalMs <= 0` returns immediately
 * WITHOUT advancing the clock, so the no-throttle path is byte-for-byte unchanged.
 */
export async function reserveSlot(minIntervalMs: number): Promise<void> {
  if (minIntervalMs <= 0) return;
  const slot = Math.max(Date.now(), nextAllowedAt);
  nextAllowedAt = slot + minIntervalMs;
  const wait = slot - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

/** Test-only: reset the shared slot clock so pacing tests are deterministic. */
export function __resetThrottle(): void {
  nextAllowedAt = 0;
}
```

- [ ] **Step 4: Run the throttle test to verify it passes**

Run: `cd core && npx vitest run test/llm.throttle.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Refactor the generator to use the shared throttle**

Replace the whole of `core/src/generate/openaiCompat.ts` with:

```ts
import OpenAI from "openai";
import { buildPrompt, parseRawGen } from "./prompt.js";
import type { GenInput, Generator, RawGen } from "./types.js";
import { reserveSlot, resolveMinIntervalMs } from "../llm/throttle.js";

/** Minimal surface of the OpenAI chat client, so tests can inject a fake. */
export interface ChatClient {
  chat: {
    completions: {
      create(args: {
        model: string;
        messages: { role: "system" | "user"; content: string }[];
        temperature?: number;
      }): Promise<{ choices: { message: { content: string | null } }[] }>;
    };
  };
}

// Re-exported for back-compat: callers/tests still import this from openaiCompat.
export { resolveMinIntervalMs } from "../llm/throttle.js";

export function makeOpenAICompatGenerator(
  opts: { client?: ChatClient; model?: string; minIntervalMs?: number } = {},
): Generator {
  const model = opts.model ?? process.env.LLM_MODEL ?? "moonshotai/kimi-k2-instruct";
  const client: ChatClient =
    opts.client ??
    (new OpenAI({
      baseURL: process.env.LLM_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
      apiKey: process.env.LLM_API_KEY ?? "",
    }) as unknown as ChatClient);

  // Client-side rate limit shared across all LLM callers via llm/throttle.
  const minIntervalMs = opts.minIntervalMs ?? resolveMinIntervalMs();

  return {
    async generate(input: GenInput): Promise<RawGen> {
      await reserveSlot(minIntervalMs);
      const { system, user } = buildPrompt(input);
      const resp = await client.chat.completions.create({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });
      return parseRawGen(resp.choices[0]?.message?.content ?? "");
    },
  };
}
```

- [ ] **Step 6: Run the generator + throttle tests to verify nothing regressed**

Run: `cd core && npx vitest run test/generate.openai.test.ts test/llm.throttle.test.ts`
Expected: PASS. The existing `generate.openai.test.ts` (including its `resolveMinIntervalMs` cases via the re-export and the `minIntervalMs: 40` pacing test) stays green.

- [ ] **Step 7: Typecheck**

Run: `cd core && npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add core/src/llm/throttle.ts core/test/llm.throttle.test.ts core/src/generate/openaiCompat.ts
git commit -m "refactor(llm): shared process-level request throttle (generator + judge)"
```

---

## Task 2: LLM sufficiency judge

The agentic loop's decision-maker: given an objective and candidates, returns whether they suffice and, if not, up to 3 reformulated queries. Degrades to "sufficient" on any failure so a broken judge stops the loop instead of crashing it.

**Files:**
- Create: `core/src/agent/judge.ts`
- Create: `core/test/agent.judge.test.ts`

**Interfaces:**
- Consumes: `extractJsonObject` from `../generate/prompt.js`; `ChatClient` from `../generate/openaiCompat.js`; `reserveSlot`, `resolveMinIntervalMs` from `../llm/throttle.js`; `Candidate` from `../retrieve/types.js`.
- Produces:
  - `interface JudgeVerdict { sufficient: boolean; reformulations: string[] }`
  - `interface JudgeDeps { client?: ChatClient; model?: string; minIntervalMs?: number }`
  - `judgeSufficiency(objective: string, candidates: Candidate[], deps?: JudgeDeps): Promise<JudgeVerdict>`

- [ ] **Step 1: Write the failing test**

Create `core/test/agent.judge.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npx vitest run test/agent.judge.test.ts`
Expected: FAIL — cannot resolve `../src/agent/judge.js`.

- [ ] **Step 3: Implement the judge**

Create `core/src/agent/judge.ts`:

```ts
import OpenAI from "openai";
import { z } from "zod";
import { extractJsonObject } from "../generate/prompt.js";
import type { ChatClient } from "../generate/openaiCompat.js";
import { reserveSlot, resolveMinIntervalMs } from "../llm/throttle.js";
import type { Candidate } from "../retrieve/types.js";

export interface JudgeVerdict {
  sufficient: boolean;
  reformulations: string[];
}

export interface JudgeDeps {
  client?: ChatClient;
  model?: string;
  minIntervalMs?: number;
}

const SYSTEM = [
  "You are the retrieval-sufficiency judge for a contract-review system.",
  "Given an objective and a set of numbered candidate clauses, decide whether the candidates",
  "contain enough information to answer the objective.",
  "If they are sufficient, set `sufficient` to true and `reformulations` to [].",
  "If they are NOT sufficient, set `sufficient` to false and propose 1-3 alternative search",
  "queries in `reformulations` (synonyms, legal-term variants, or narrower sub-aspects of the",
  "objective) that might retrieve the missing clause. Do not invent clause content.",
  'Reply with ONLY a JSON object: {"sufficient": boolean, "reformulations": string[]}.',
].join(" ");

function buildUser(objective: string, candidates: Candidate[]): string {
  const lines = candidates.map(
    (c, i) => `[${i}] (${c.doc_id}, chars ${c.char_start}-${c.char_end}) ${c.text}`,
  );
  return `Objective: ${objective}\n\nCandidate clauses:\n${lines.join("\n")}`;
}

const VerdictSchema = z.object({
  sufficient: z.boolean().catch(false),
  reformulations: z.array(z.string()).catch([]),
});

/**
 * LLM sufficiency judge. Returns whether the candidates can answer the objective and,
 * if not, up to 3 reformulated queries. Degrades to {sufficient:true, reformulations:[]}
 * on any call failure OR unparseable output, so a broken judge stops the loop rather than
 * crashing retrieval. Shares the process rpm budget via reserveSlot.
 */
export async function judgeSufficiency(
  objective: string,
  candidates: Candidate[],
  deps: JudgeDeps = {},
): Promise<JudgeVerdict> {
  const model = deps.model ?? process.env.LLM_MODEL ?? "moonshotai/kimi-k2-instruct";
  const client: ChatClient =
    deps.client ??
    (new OpenAI({
      baseURL: process.env.LLM_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
      apiKey: process.env.LLM_API_KEY ?? "",
    }) as unknown as ChatClient);
  const minIntervalMs = deps.minIntervalMs ?? resolveMinIntervalMs();

  await reserveSlot(minIntervalMs);

  let content: string;
  try {
    const resp = await client.chat.completions.create({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: buildUser(objective, candidates) },
      ],
    });
    content = resp.choices[0]?.message?.content ?? "";
  } catch {
    return { sufficient: true, reformulations: [] };
  }

  try {
    const obj = VerdictSchema.parse(extractJsonObject(content));
    const reformulations = obj.reformulations
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 3);
    return { sufficient: obj.sufficient, reformulations };
  } catch {
    return { sufficient: true, reformulations: [] };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && npx vitest run test/agent.judge.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck**

Run: `cd core && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add core/src/agent/judge.ts core/test/agent.judge.test.ts
git commit -m "feat(agent): LLM retrieval-sufficiency judge with safe degrade"
```

---

## Task 3: Agentic retrieve loop

The orchestrator. Composes `dense`/`lexical`/`rrfFuse`/`rerank` + `judge` into a bounded loop, with the real implementations as default deps (mirroring `hybrid.ts`) so unit tests inject fakes and `makeRetriever` calls it with no wiring.

**Files:**
- Create: `core/src/agent/loop.ts`
- Create: `core/test/agent.loop.test.ts`

**Interfaces:**
- Consumes: `Candidate` from `../retrieve/types.js`; `JudgeVerdict`, `judgeSufficiency` from `./judge.js`; `denseRetrieve` from `../retrieve/dense.js`; `lexicalRetrieve` from `../retrieve/lexical.js`; `rrfFuse` from `../retrieve/rrf.js`; `rerank` from `../rerank/model.js`.
- Produces:
  - `interface AgenticDeps { dense; lexical; rerank; rrfFuse; judge }` (exact shapes below)
  - `const AGENT_DEFAULTS = { MAX_ROUNDS: 2, N: 50, M: 100, K_RRF: 60 }`
  - `agenticRetrieve(query: string, docId: string, k?: number, deps?: AgenticDeps, cfg?: typeof AGENT_DEFAULTS): Promise<Candidate[]>`

- [ ] **Step 1: Write the failing test**

Create `core/test/agent.loop.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { agenticRetrieve, type AgenticDeps } from "../src/agent/loop.js";
import { rrfFuse } from "../src/retrieve/rrf.js";
import type { Candidate } from "../src/retrieve/types.js";

function cand(id: string): Candidate {
  return { node_id: id, doc_id: "d", type: "section", number: null, heading: null, text: id, char_start: 0, char_end: 1, score: 0 };
}
// Fresh identity-rerank per test (slice top-k), so call counts are not shared across tests.
const rr = () => vi.fn(async (_q: string, cs: Candidate[], topK: number) => cs.slice(0, topK));
const cfg = { MAX_ROUNDS: 2, N: 50, M: 100, K_RRF: 60 };

describe("agenticRetrieve", () => {
  it("returns round-1 result and skips round 2 when the judge says sufficient", async () => {
    const deps: AgenticDeps = {
      dense: vi.fn().mockResolvedValue([cand("a")]),
      lexical: vi.fn().mockResolvedValue([cand("b")]),
      rerank: rr(),
      rrfFuse,
      judge: vi.fn().mockResolvedValue({ sufficient: true, reformulations: [] }),
    };
    const out = await agenticRetrieve("q", "d", 8, deps, cfg);
    expect(out.map((c) => c.node_id).sort()).toEqual(["a", "b"]);
    expect((deps.dense as any)).toHaveBeenCalledTimes(1); // only round 1
    expect((deps.judge as any)).toHaveBeenCalledTimes(1);
  });

  it("runs a reformulation round when insufficient, fusing the new candidates", async () => {
    const dense = vi.fn()
      .mockResolvedValueOnce([cand("a")])   // round 1
      .mockResolvedValueOnce([cand("c")]);  // round 2 (reformulation "r1")
    const lexical = vi.fn()
      .mockResolvedValueOnce([cand("b")])
      .mockResolvedValueOnce([cand("d")]);
    const deps: AgenticDeps = {
      dense, lexical, rerank: rr(), rrfFuse,
      judge: vi.fn().mockResolvedValue({ sufficient: false, reformulations: ["r1"] }),
    };
    const out = await agenticRetrieve("q", "d", 8, deps, cfg);
    expect(dense).toHaveBeenCalledTimes(2);
    expect(dense.mock.calls[1][0]).toBe("r1"); // reformulated query used
    expect(out.map((c) => c.node_id).sort()).toEqual(["a", "b", "c", "d"]); // fused union
  });

  it("stops early (returns round-1) when a reformulation round adds no new candidates", async () => {
    const dense = vi.fn()
      .mockResolvedValueOnce([cand("a")])
      .mockResolvedValueOnce([cand("a")]); // same id → nothing new
    const lexical = vi.fn()
      .mockResolvedValueOnce([cand("b")])
      .mockResolvedValueOnce([cand("b")]);
    const rerank = rr();
    const deps: AgenticDeps = {
      dense, lexical, rerank, rrfFuse,
      judge: vi.fn().mockResolvedValue({ sufficient: false, reformulations: ["r1"] }),
    };
    const out = await agenticRetrieve("q", "d", 8, deps, cfg);
    expect(out.map((c) => c.node_id).sort()).toEqual(["a", "b"]);
    expect(rerank).toHaveBeenCalledTimes(1); // round-1 rerank only; no second rerank
  });

  it("returns round-1 when the judge proposes no reformulations", async () => {
    const dense = vi.fn().mockResolvedValue([cand("a")]);
    const lexical = vi.fn().mockResolvedValue([cand("b")]);
    const deps: AgenticDeps = {
      dense, lexical, rerank: rr(), rrfFuse,
      judge: vi.fn().mockResolvedValue({ sufficient: false, reformulations: [] }),
    };
    const out = await agenticRetrieve("q", "d", 8, deps, cfg);
    expect(dense).toHaveBeenCalledTimes(1);
    expect(out.map((c) => c.node_id).sort()).toEqual(["a", "b"]);
  });

  it("degrades to round-1 when the judge throws", async () => {
    const deps: AgenticDeps = {
      dense: vi.fn().mockResolvedValue([cand("a")]),
      lexical: vi.fn().mockResolvedValue([cand("b")]),
      rerank: rr(), rrfFuse,
      judge: vi.fn().mockRejectedValue(new Error("llm down")),
    };
    const out = await agenticRetrieve("q", "d", 8, deps, cfg);
    expect(out.map((c) => c.node_id).sort()).toEqual(["a", "b"]);
  });

  it("falls back to fused order when rerank throws", async () => {
    const deps: AgenticDeps = {
      dense: vi.fn().mockResolvedValue([cand("a")]),
      lexical: vi.fn().mockResolvedValue([cand("b")]),
      rerank: vi.fn().mockRejectedValue(new Error("model load failed")),
      rrfFuse,
      judge: vi.fn().mockResolvedValue({ sufficient: true, reformulations: [] }),
    };
    const out = await agenticRetrieve("q", "d", 8, deps, cfg);
    expect(out.map((c) => c.node_id).sort()).toEqual(["a", "b"]); // fused order, no throw
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npx vitest run test/agent.loop.test.ts`
Expected: FAIL — cannot resolve `../src/agent/loop.js`.

- [ ] **Step 3: Implement the loop**

Create `core/src/agent/loop.ts`:

```ts
import type { Candidate } from "../retrieve/types.js";
import type { JudgeVerdict } from "./judge.js";
import { judgeSufficiency } from "./judge.js";
import { denseRetrieve } from "../retrieve/dense.js";
import { lexicalRetrieve } from "../retrieve/lexical.js";
import { rrfFuse } from "../retrieve/rrf.js";
import { rerank as rerankDefault } from "../rerank/model.js";

export interface AgenticDeps {
  dense: (query: string, docId: string, n: number) => Promise<Candidate[]>;
  lexical: (query: string, docId: string, n: number) => Promise<Candidate[]>;
  rerank: (query: string, candidates: Candidate[], topK: number) => Promise<Candidate[]>;
  rrfFuse: (lists: Candidate[][], opts: { k: number }) => Candidate[];
  judge: (objective: string, candidates: Candidate[]) => Promise<JudgeVerdict>;
}

export const AGENT_DEFAULTS = { MAX_ROUNDS: 2, N: 50, M: 100, K_RRF: 60 };
export type AgenticConfig = typeof AGENT_DEFAULTS;

const defaultDeps: AgenticDeps = {
  dense: denseRetrieve,
  lexical: lexicalRetrieve,
  rerank: rerankDefault,
  rrfFuse,
  judge: judgeSufficiency,
};

/** rerank with degrade-to-fused-order on failure (mirrors hybridRetrieve). */
async function safeRerank(
  deps: AgenticDeps,
  query: string,
  pool: Candidate[],
  k: number,
): Promise<Candidate[]> {
  if (pool.length === 0) return [];
  try {
    return await deps.rerank(query, pool, k);
  } catch (e) {
    process.stderr.write(
      `agentic rerank failed, falling back to fused order: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return pool.slice(0, k);
  }
}

/**
 * Agentic doc-scoped retrieval: dense+lexical → RRF → rerank top-k → LLM sufficiency
 * judge → (if insufficient) one multi-query reformulation round, RRF-fused ONCE over all
 * rounds' raw lists and reranked against the ORIGINAL objective. Returns the final top-k
 * Candidate[] (unchanged shape). Degrades to the round-1 result when: MAX_ROUNDS <= 1, the
 * judge says sufficient, the judge throws, there are no reformulations, or a round adds no
 * new candidates. Real implementations are the default deps, so makeRetriever needs no wiring.
 */
export async function agenticRetrieve(
  query: string,
  docId: string,
  k = 8,
  deps: AgenticDeps = defaultDeps,
  cfg: AgenticConfig = AGENT_DEFAULTS,
): Promise<Candidate[]> {
  // Round 1: dense + lexical (parallel) → RRF → cap M → rerank top-k.
  const [d1, x1] = await Promise.all([
    deps.dense(query, docId, cfg.N),
    deps.lexical(query, docId, cfg.N),
  ]);
  const lists: Candidate[][] = [d1, x1];
  const round1Ids = new Set(lists.flat().map((c) => c.node_id));
  const top1 = await safeRerank(deps, query, deps.rrfFuse(lists, { k: cfg.K_RRF }).slice(0, cfg.M), k);

  if (cfg.MAX_ROUNDS <= 1) {
    process.stderr.write(`agentic doc=${docId} rounds=1 retried=false\n`);
    return top1;
  }

  // Sufficiency judge — a throwing judge degrades to "sufficient" (return round-1).
  let verdict: JudgeVerdict;
  try {
    verdict = await deps.judge(query, top1);
  } catch {
    process.stderr.write(`agentic doc=${docId} rounds=1 retried=false judge_error=true\n`);
    return top1;
  }

  if (verdict.sufficient || verdict.reformulations.length === 0) {
    process.stderr.write(
      `agentic doc=${docId} rounds=1 retried=false sufficient=${verdict.sufficient}\n`,
    );
    return top1;
  }

  // Round 2: retrieve each reformulation, accumulate raw lists.
  for (const q of verdict.reformulations) {
    const [d, x] = await Promise.all([
      deps.dense(q, docId, cfg.N),
      deps.lexical(q, docId, cfg.N),
    ]);
    lists.push(d, x);
  }

  // Convergence guard: if round 2 introduced no new node_id, the fusion equals round 1.
  const addedNew = lists.slice(2).flat().some((c) => !round1Ids.has(c.node_id));
  if (!addedNew) {
    process.stderr.write(`agentic doc=${docId} rounds=2 retried=true added_new=false\n`);
    return top1;
  }

  const fused = deps.rrfFuse(lists, { k: cfg.K_RRF }).slice(0, cfg.M);
  const top2 = await safeRerank(deps, query, fused, k);
  process.stderr.write(
    `agentic doc=${docId} rounds=2 retried=true added_new=true reformulations=${verdict.reformulations.length}\n`,
  );
  return top2;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && npx vitest run test/agent.loop.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck**

Run: `cd core && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add core/src/agent/loop.ts core/test/agent.loop.test.ts
git commit -m "feat(agent): bounded retrieve→judge→reformulate loop"
```

---

## Task 4: Wire agentic mode into makeRetriever + eval CLI

Expose `agentic` through the existing factory and record its provenance in the eval report. No call-site changes (eval CLI and SSE route already go through `makeRetriever`).

**Files:**
- Modify: `core/src/retrieve/retrieve.ts`
- Modify: `core/src/eval/cli.ts:86-98`
- Create: `core/test/retrieve.agentic-routing.test.ts`

**Interfaces:**
- Consumes: `agenticRetrieve` and `AGENT_DEFAULTS` from `../agent/loop.js`.
- Produces: `makeRetriever("agentic")` → a `RetrieveFn` routing to `agenticRetrieve`; eval report gains `agent_max_rounds` and writes `p2c.json` for agentic runs.

- [ ] **Step 1: Write the failing test**

Create `core/test/retrieve.agentic-routing.test.ts`. It mocks `agent/loop.js` (which also keeps the heavy reranker/judge imports out of this unit test) and asserts the factory actually routes the `agentic` mode to `agenticRetrieve`, threading `(query, docId, k)` through:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npx vitest run test/retrieve.agentic-routing.test.ts`
Expected: FAIL — before the wiring, `makeRetriever("agentic")` falls through to `denseRetrieve`, so `agenticRetrieve` is never called and the `toHaveBeenCalledWith` assertion fails (and `out[0].node_id` is not `"AGENTIC"`). This is a real red.

> Note: the loop's *behavior* is fully covered by Task 3's unit tests; this task's test guards only the factory wiring (routing + k pass-through), which is the new logic here. The end-to-end agentic path is exercised by the Task 5 eval.

- [ ] **Step 3: Wire the agentic branch into makeRetriever**

Replace the whole of `core/src/retrieve/retrieve.ts` with:

```ts
import { denseRetrieve } from "./dense.js";
import { hybridRetrieve } from "./hybrid.js";
import { agenticRetrieve } from "../agent/loop.js";
import type { Candidate } from "./types.js";

export type { Candidate } from "./types.js";

export type RetrieveFn = (query: string, docId: string, k?: number) => Promise<Candidate[]>;

/** Select a retrieval strategy. naive = dense cosine top-k (P1); hybrid = P2a; agentic = P2c. */
export function makeRetriever(mode: string | undefined): RetrieveFn {
  if (mode === "hybrid") return (q, d, k = 8) => hybridRetrieve(q, d, k);
  if (mode === "agentic") return (q, d, k = 8) => agenticRetrieve(q, d, k);
  return (q, d, k = 8) => denseRetrieve(q, d, k); // default: naive
}

/** Back-compat entry point: resolves the mode from RETRIEVE_MODE (default naive). */
export function retrieve(query: string, docId: string, k = 8): Promise<Candidate[]> {
  return makeRetriever(process.env.RETRIEVE_MODE)(query, docId, k);
}
```

- [ ] **Step 4: Stamp provenance + report name in the eval CLI**

In `core/src/eval/cli.ts`, add the import near the other retrieve imports (after line 12, `import { makeRetriever } ...`):

```ts
import { AGENT_DEFAULTS } from "../agent/loop.js";
```

Then replace the provenance block (currently lines 86-98) with:

```ts
  // Provenance: provider/model match makeGenerator(); retrieve_mode/rerank_model/embed_model/
  // agent_max_rounds record config. rerank runs in both hybrid and agentic modes.
  const provider = process.env.LLM_PROVIDER ?? "openai";
  const model = process.env.LLM_MODEL ?? null;
  const usesRerank = mode === "hybrid" || mode === "agentic";
  const rerank_model = usesRerank ? (process.env.RERANK_MODEL ?? "Xenova/ms-marco-MiniLM-L-6-v2") : null;
  const embed_model = process.env.EMBED_MODEL ?? "bge-large-en-v1.5";
  const agent_max_rounds = mode === "agentic" ? AGENT_DEFAULTS.MAX_ROUNDS : null;

  // EVAL_OUT overrides the report filename so a benchmark run doesn't clobber an existing report.
  const outName =
    process.env.EVAL_OUT ??
    (mode === "hybrid" ? "p2a.json" : mode === "agentic" ? "p2c.json" : "baseline.json");
  mkdirSync(`${root}evals/reports`, { recursive: true });
  writeFileSync(
    `${root}evals/reports/${outName}`,
    JSON.stringify(
      { provider, model, retrieve_mode: mode, rerank_model, embed_model, agent_max_rounds, ...report },
      null,
      2,
    ) + "\n",
  );
```

- [ ] **Step 5: Run the routing test + typecheck**

Run: `cd core && npx vitest run test/retrieve.agentic-routing.test.ts test/retrieve.hybrid.test.ts && npm run typecheck`
Expected: PASS — the routing test now goes green, the existing hybrid/makeRetriever tests stay green, and there are no type errors (confirms `agenticRetrieve` and `AGENT_DEFAULTS` resolve and are used).

- [ ] **Step 6: Run the full unit suite (no-infra subset must stay green)**

Run: `cd core && npm test`
Expected: the pre-existing infra-dependent failures (the 6 DB/native-binding tests documented in the headless test-infra boundary) are unchanged; every other test, including all new P2c tests, passes. No NEW failures introduced.

- [ ] **Step 7: Commit**

```bash
git add core/src/retrieve/retrieve.ts core/src/eval/cli.ts core/test/retrieve.agentic-routing.test.ts
git commit -m "feat(retrieve): wire agentic mode into makeRetriever + eval provenance"
```

---

## Task 5: Eval gate — run, compare, decide, record

The merge gate. Requires infra (`make db-up`, embeddings loaded) and a working NIM key. **The controller runs this task directly** (it needs live DB + LLM + the user's credentials); it is not a sandboxed implementer task. Produces the p2a→p2c delta, the `missing`-category refusal check, and the recorded decision.

**Files:**
- Modify: `docs/superpowers/specs/2026-06-29-p2c-agentic-retrieve-loop-design.md` (fill the Results section)

**Preconditions:**
- `make db-up` and the corpus + bge-large embeddings are loaded (same DB used for the P2a run that produced `evals/reports/p2a.json`).
- `.env` has a valid NIM `LLM_API_KEY`. Use `LLM_MODEL=meta/llama-3.3-70b-instruct` (the free, working model) and `LLM_RPM=36` (under the 40-rpm cap; now shared across generator + judge).

- [ ] **Step 1: Run the agentic eval**

Run:
```bash
cd core && RETRIEVE_MODE=agentic EVAL_OUT=p2c.json \
  LLM_PROVIDER=openai LLM_MODEL=meta/llama-3.3-70b-instruct LLM_RPM=36 \
  npm run eval -- run
```
Expected: per-item progress on stderr interleaved with `agentic doc=… rounds=… retried=…` lines; a final JSON summary on stdout; `evals/reports/p2c.json` written. (A non-zero exit from the onnxruntime teardown crash after the reranker loads is the known cosmetic artifact — the report is written before exit; confirm the file exists and is complete.)

- [ ] **Step 2: Confirm provenance + report shape**

Run: `jq '{retrieve_mode, rerank_model, embed_model, agent_max_rounds, k, total, aggregates}' evals/reports/p2c.json` (from repo root, or `../evals/...` from core)
Expected: `retrieve_mode: "agentic"`, `agent_max_rounds: 2`, `rerank_model` set, `embed_model: "bge-large-en-v1.5"`, `total: 50`.

- [ ] **Step 3: Delta table vs the P2a best**

Run: `cd core && npm run eval -- compare p2a.json p2c.json`
Expected: a printed delta table (recall@8, NDCG@8, groundedness, refusal_rate, false_negative_rate). Record it.

- [ ] **Step 4: The make-or-break guardrail — `missing`-category refusal**

Run:
```bash
for f in p2a p2c; do
  echo "== $f =="
  jq '[.items[] | select(.category=="missing")] | {missing: length, refused: (map(select(.refused)) | length)}' evals/reports/$f.json
done
```
Expected: P2c's `refused` count among `missing` items is **>=** P2a's. A drop means the loop manufactured context for out-of-scope questions — a **FAIL** regardless of recall gains.

- [ ] **Step 5: Retry/rescue observability**

From the captured stderr of Step 1: count items where `retried=true` and where `added_new=true`. (Optional precise rescue tally: join per-item `recall_at_k` across the two reports —
```bash
jq -n --slurpfile a evals/reports/p2a.json --slurpfile b evals/reports/p2c.json \
  '($a[0].items | map({(.id): .recall_at_k}) | add) as $ar | $b[0].items
   | map(select((.recall_at_k // 0) > 0 and (($ar[.id]) // 0) == 0)) | {rescued: length}'
```
gives the count of items whose gold span was retrieved in P2c but missed in P2a.)

- [ ] **Step 6: Decide against the gate and record Results**

Apply the gate from the spec: **PASS** iff recall@8 and/or false_negative_rate improve over p2a, groundedness holds ~1.0, AND `missing`-category refusal is preserved (Step 4). Fill the "Results (P2c) — TBD" section of `docs/superpowers/specs/2026-06-29-p2c-agentic-retrieve-loop-design.md` with: the provider/model/k line, the delta table, the rescued/retry tallies, the `missing`-refusal check, and the **KEEP / REVERT** decision with rationale. A flat or negative result is a valid recorded finding (as in P2b) — it points at P3's LoRA query-rewriter or the deferred legal embedder.

- [ ] **Step 7: Commit the report + Results**

```bash
git add evals/reports/p2c.json docs/superpowers/specs/2026-06-29-p2c-agentic-retrieve-loop-design.md
git commit -m "eval(p2c): agentic loop report + p2a→p2c delta and decision"
```

---

## Notes for the executor

- **Infra-dependent tests:** Tasks 1-4 are fully unit-testable without DB/LLM (injected fakes / pure throttle). `cd core && npm test` will still show the pre-existing ~6 infra failures (DB/native-binding) documented in the headless test-infra boundary — those are NOT regressions; only assert that no NEW failures appear and all new P2c tests pass.
- **onnxruntime teardown crash:** loading the cross-encoder (Task 5 eval, or any rerank-loading test run in the same process) can emit a `mutex lock failed` crash on `process.exit`. It is cosmetic — the eval report is written before exit. Run model-loading tests in isolation when verifying.
- **Secrets:** never echo `.env` contents; reference `LLM_API_KEY` by name only.
- **Branch:** `phase-2c-agentic-retrieve-loop` (already created off `main` with P2a + P2b). The spec is already committed (`fc8b841`).
