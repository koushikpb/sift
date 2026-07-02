import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClauseCard } from "../schemas/clauseCard.js";
import { loadPlaybook } from "../eval/playbook.js";
import { withClient } from "../db/client.js";
import { getClauseLabel } from "../db/clauseLabels.js";
import type { ClauseLabel } from "../db/clauseLabels.js";
import { reviewContract } from "./reviewAgent.js";
import type { ReviewDeps, ReviewResult } from "./reviewAgent.js";
import { makeRetrieveClauseTool } from "./tools/retrieveClause.js";
import type { RetrieveClauseDeps, RetrieveClauseInput } from "./tools/retrieveClause.js";
import type { ClassifyInput } from "./tools/classifyClause.js";
import { makeFlagRisksTool, defaultDeviationJudge } from "./tools/flagRisks.js";
import { makeDraftRedlineTool, defaultRedlineWriter } from "./tools/draftRedline.js";
import { makeExportMemoTool } from "./tools/exportMemo.js";
import type { Citation, ClauseClassification, ToolDef } from "./tools/types.js";

export { reviewContract };
export type { ReviewDeps, ReviewResult };

/**
 * Resolve the NDA playbook YAML on disk. Order:
 *
 * 1. PLAYBOOK_PATH env — explicit deployer override, always wins.
 * 2. cwd-relative candidates: `evals/playbook/nda.yaml`, then `../evals/playbook/nda.yaml`.
 *    This is the branch that works in the deployed Vercel function: the file ships with the
 *    function via app/next.config.mjs's outputFileTracingIncludes, preserving the repo-relative
 *    layout under the function root (/var/task). The function's cwd may be the repo root or
 *    app/ (Vercel Root Directory = app), hence both probes.
 * 3. import.meta.url-relative fallback — correct ONLY in non-bundled usage (vitest, tsx CLI,
 *    MCP server). When this module is bundled by Next.js webpack (transpilePackages:
 *    ["@sift/core"], see app/next.config.mjs), webpack treats `new URL(literal,
 *    import.meta.url)` as a static-asset import and rewrites it to a *single*-arg
 *    `new URL("static/media/nda.<hash>.yaml")` call — dropping import.meta.url entirely.
 *    Verified by inspecting `app/.next/server/chunks/*.js` after `npm -w @sift/app run build`:
 *    the compiled output is `new c.U(c(98995))` where module 98995 returns
 *    `c.p + "static/media/nda.<hash>.yaml"` — a bare relative string with no scheme, which
 *    throws `TypeError: Invalid URL`. In the bundled app this branch is therefore only reached
 *    when both cwd probes miss, and the throw is caught by the review route's
 *    dependency-construction guard (clean 500, no crash).
 *
 * NOTE a build-time `process.env.PLAYBOOK_PATH` default in next.config.mjs does NOT work on
 * Vercel and was removed: `.next/required-server-files.json` serializes the resolved config
 * with `env: {}` (an imperative process.env assignment is a config-load side effect, not
 * config), and Vercel's launcher instantiates the server from that JSON without re-running
 * next.config.mjs — so the injected value never reaches the lambda. The cwd probes above are
 * the deterministic mechanism instead.
 *
 * `env`/`cwd` are injectable for tests only; production callers use the defaults. Called
 * lazily (from buildReviewDeps) rather than at module load so a resolution failure surfaces
 * where callers can guard it.
 */
export function resolvePlaybookPath(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): string {
  if (env.PLAYBOOK_PATH) return env.PLAYBOOK_PATH;
  for (const candidate of [
    resolve(cwd, "evals/playbook/nda.yaml"),
    resolve(cwd, "../evals/playbook/nda.yaml"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return fileURLToPath(new URL("../../../evals/playbook/nda.yaml", import.meta.url));
}

/** Looks up a precomputed clause label for a grounded span. Matches db/clauseLabels.ts's getClauseLabel. */
export type ClauseLabelLookup = (docId: string, charStart: number, charEnd: number) => Promise<ClauseLabel | null>;

const defaultLookupClauseLabel: ClauseLabelLookup = (docId, charStart, charEnd) =>
  withClient((client) => getClauseLabel(client, docId, charStart, charEnd));

/**
 * Assemble a real ReviewDeps for the hosted demo (Task 5's /api/review). Mirrors
 * mcp/tools.ts's buildTools, but the classify dep reads the precomputed clause_labels table
 * (Task 4) instead of spawning Python — required for Vercel serverless (no Python runtime).
 *
 * classify_clause's ToolDef input is `{text}` only (no span — see tools/classifyClause.ts), so
 * the precomputed lookup needs the citation span from another source: we capture it from the
 * immediately-preceding retrieve_clause call via a closure. This is safe because reviewContract's
 * trajectory always classifies the clause it just retrieved (see reviewAgent.ts) — never a
 * different one.
 *
 * export_memo's writer throws if ever invoked: reviewContract never sets confirm:true, so normal
 * operation never reaches it. Throwing (rather than silently writing or no-op'ing) makes the HITL
 * gate a hard backstop at the dependency boundary, not just a convention callers must uphold.
 *
 * `lookupClauseLabel` defaults to the real DB-backed lookup but is injectable so callers (tests)
 * can exercise the classify wiring — including the ordering-invariant check below — without a
 * live Postgres.
 */
export function buildReviewDeps(
  docId: string,
  io: RetrieveClauseDeps,
  k = 8,
  lookupClauseLabel: ClauseLabelLookup = defaultLookupClauseLabel,
): ReviewDeps {
  const entries = loadPlaybook(resolvePlaybookPath());

  let lastCitation: Citation | null = null;
  const baseRetrieveClause = makeRetrieveClauseTool(io, k);
  const retrieveClause: ToolDef<RetrieveClauseInput, ClauseCard> = {
    ...baseRetrieveClause,
    async run(input: RetrieveClauseInput): Promise<ClauseCard> {
      const card = await baseRetrieveClause.run(input);
      lastCitation = card.citations[0] ?? null;
      return card;
    },
  };

  const classifyClause: ToolDef<ClassifyInput, ClauseClassification> = {
    name: "classify_clause",
    title: "Classify a clause (precomputed LoRA label)",
    description:
      "Look up the precomputed LoRA clause-type label for the most recently retrieved citation (Task 4 clause_labels table). No Python subprocess.",
    sideEffect: "read",
    inputShape: { text: z.string().min(1) },
    // input.text is declared but reviewAgent's fixed ClassifyInput = {text} can't carry the
    // span this lookup needs (see module doc above) — lastCitation supplies it instead. That
    // makes the {text} contract only a promise if the caller's ordering invariant holds
    // (classify_clause always follows the retrieve_clause it's about to classify). Enforce it
    // here rather than trusting it silently: if input.text doesn't match the captured span's
    // quote, something violated the ordering (or a future caller changed it) — refuse to
    // classify the wrong clause and throw loudly instead of returning a plausible-looking but
    // wrong label. streamReview's try/catch turns this into a clean `error` SSE event.
    async run(input: ClassifyInput): Promise<ClauseClassification> {
      if (!lastCitation) return { clause_type: "unclassified", score: 0 };
      if (input.text !== lastCitation.quote) {
        throw new Error(
          "classify_clause: input.text does not match the most recently retrieved citation — refusing to classify the wrong span (ordering invariant violated)",
        );
      }
      const { char_start, char_end } = lastCitation;
      const row = await lookupClauseLabel(docId, char_start, char_end);
      return row ? { clause_type: row.label, score: row.score } : { clause_type: "unclassified", score: 0 };
    },
  };

  const judge = defaultDeviationJudge();
  const redline = defaultRedlineWriter();

  return {
    playbook: entries,
    retrieveClause,
    classifyClause,
    flagRisks: makeFlagRisksTool({ judge: judge.judge }, entries),
    draftRedline: makeDraftRedlineTool({ suggest: redline.suggest }),
    exportMemo: makeExportMemoTool({
      writeFile: async () => {
        throw new Error("export_memo: filesystem writes are disabled in the serve path (HITL gate — confirm is never set)");
      },
    }),
  };
}
