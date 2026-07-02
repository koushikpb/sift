import { z } from "zod";
import { ReviewMemoSchema, makeExportMemoTool } from "@sift/core/agent/memo";
import { getRateLimiter, getRpmLimit, getClientKey, rateLimitedResponse } from "../../../src/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * export_memo mapped to the Vercel-safe demo (Task 7). This is the same HITL gate `reviewContract`
 * uses internally (see core/src/agent/index.ts's buildReviewDeps, whose exportMemo throws on any
 * real write attempt): without `confirm:true` the tool returns a rendered-markdown PREVIEW only
 * (`written:false`); nothing downstream can happen with it. The only difference here is that
 * `confirm:true` is a *reachable*, legitimate path — a human explicitly asked for the export via
 * ExportMemoDialog's confirm button — so the tool is allowed to complete. Even then, `writeFile`
 * below is a no-op: Vercel functions have no writable/persistent filesystem, and the "write" the
 * human confirmed is the client-side download in ExportMemoDialog, not anything server-side. This
 * route never touches disk on either path — the HITL gate is honest, not just enforced by
 * convention.
 *
 * The request body is validated against the exact shape `renderMemoMarkdown` consumes
 * (ReviewMemoSchema), minus the two fields the server derives rather than trusts from the client:
 * - `fields` — the streamed clause events (see core/src/serve/reviewStream.ts's ReviewEvent) never
 *   carry an extracted field value to the browser, only citation/classification/flag/redline — so
 *   the client has nothing honest to send here. Always rendered empty.
 * - `generated_at` — server-set at request time, not client-supplied.
 * What's left (`doc_id`, `objective`, `flags`, `redlines`) is exactly what the client has from the
 * streamed review results.
 *
 * Imported from `@sift/core/agent/memo` (core/src/agent/tools/exportMemo.ts directly), not
 * `@sift/core/agent` (index.ts) — index.ts also imports db/client.ts for buildReviewDeps' clause-
 * label lookups, unrelated to this route, and throws at module-evaluation time when DATABASE_URL
 * isn't visible. exportMemo.ts has no DB dependency (only zod + the clause-card span schema), so
 * this route never risks that failure mode.
 *
 * Length/array caps (Task 9, closes review finding M7-4): `ReviewMemoSchema` itself is the shared
 * cross-language contract (also consumed by the MCP export_memo tool and CLI evals) and stays
 * unbounded there; this route tightens it locally via `.max()` on the same field schemas
 * (`ReviewMemoSchema.shape.*`, reused rather than redeclared so enum/strict-object validation is
 * untouched) to whatever the UI can actually produce. EVERY client-controlled string in the tree
 * is bounded — top-level fields, flag/redline text, AND the nested citation spans (`flag.citation`
 * / `redline.original`, bounded once as `BoundedCitation` below and reused in both) whose `quote`
 * would otherwise accept a multi-megabyte payload; the span offsets additionally get a hard
 * ceiling on top of the int/nonnegative checks inherited from core's SpanSchema. The curated demo
 * playbook (evals/playbook/nda.yaml) has 7 positions, so one review run yields at most 7
 * flags/redlines in practice — the caps below give generous headroom above that while still
 * bounding a hostile client's payload size.
 */
const MAX_OBJECTIVE_LEN = 500; // matches the review route's objective cap (same field, echoed back)
const MAX_DOC_ID_LEN = 100;
const MAX_ID_LEN = 200; // playbook_id / clause_type identifiers
const MAX_ARRAY_LEN = 50; // real usage tops out at 7 (one per playbook position)
const MAX_RATIONALE_LEN = 2000;
const MAX_SUGGESTED_TEXT_LEN = 5000; // a proposed redline can be a full clause rewrite
const MAX_QUOTE_LEN = 20_000; // a citation quote is one clause span — generous but finite
const MAX_CHAR_OFFSET = 10_000_000; // largest corpus doc is well under 1M chars; hard sanity ceiling

const FlagElement = ReviewMemoSchema.shape.flags.element;
const RedlineElement = ReviewMemoSchema.shape.redlines.element;

// One bounded citation-span schema, reused by both flag.citation and redline.original. Derived
// from the core CitationSchema (via RedlineElement.shape.original) so `.strict()` and the
// int/nonnegative offset checks are inherited, with route-local ceilings layered on top.
const CitationBase = RedlineElement.shape.original;
const BoundedCitation = CitationBase.extend({
  doc_id: CitationBase.shape.doc_id.max(MAX_DOC_ID_LEN),
  char_start: CitationBase.shape.char_start.max(MAX_CHAR_OFFSET),
  char_end: CitationBase.shape.char_end.max(MAX_CHAR_OFFSET),
  quote: CitationBase.shape.quote.max(MAX_QUOTE_LEN),
});

const MemoRequestSchema = ReviewMemoSchema.omit({ fields: true, generated_at: true }).extend({
  doc_id: ReviewMemoSchema.shape.doc_id.max(MAX_DOC_ID_LEN),
  objective: ReviewMemoSchema.shape.objective.max(MAX_OBJECTIVE_LEN),
  flags: FlagElement.extend({
    playbook_id: FlagElement.shape.playbook_id.max(MAX_ID_LEN),
    clause_type: FlagElement.shape.clause_type.max(MAX_ID_LEN),
    rationale: FlagElement.shape.rationale.max(MAX_RATIONALE_LEN),
    citation: BoundedCitation.nullable(),
  })
    .array()
    .max(MAX_ARRAY_LEN),
  redlines: RedlineElement.extend({
    playbook_id: RedlineElement.shape.playbook_id.max(MAX_ID_LEN),
    original: BoundedCitation,
    suggested_text: RedlineElement.shape.suggested_text.max(MAX_SUGGESTED_TEXT_LEN),
    rationale: RedlineElement.shape.rationale.max(MAX_RATIONALE_LEN),
  })
    .array()
    .max(MAX_ARRAY_LEN),
  confirm: z.boolean().optional(),
});

const exportMemoTool = makeExportMemoTool({
  // Never touches disk — see module doc above.
  writeFile: async () => {},
});

export async function POST(request: Request): Promise<Response> {
  // Rate limit runs BEFORE reading/validating the body — protects the (cheap) parse/validate work
  // too, matching the review route's ordering.
  const clientKey = getClientKey(request);
  const limiter = await getRateLimiter("memo", { limit: getRpmLimit(), windowMs: 60_000 });
  const decision = await limiter.limit(clientKey);
  if (!decision.success) {
    return rateLimitedResponse(decision);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const parsed = MemoRequestSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "invalid memo request" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const { doc_id, objective, flags, redlines, confirm } = parsed.data;

  try {
    const result = await exportMemoTool.run({
      memo: { doc_id, objective, fields: [], flags, redlines, generated_at: new Date().toISOString() },
      confirm,
    });

    if (!result.written) {
      return new Response(JSON.stringify({ written: false, preview: result.markdown }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ written: true, markdown: result.markdown }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.error("memo route: export_memo failed:", err);
    return new Response(JSON.stringify({ error: "failed to render memo" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
