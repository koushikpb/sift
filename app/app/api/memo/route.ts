import { z } from "zod";
import { ReviewMemoSchema, makeExportMemoTool } from "@sift/core/agent/memo";

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
 */
const MemoRequestSchema = ReviewMemoSchema.omit({ fields: true, generated_at: true }).extend({
  confirm: z.boolean().optional(),
});

const exportMemoTool = makeExportMemoTool({
  // Never touches disk — see module doc above.
  writeFile: async () => {},
});

export async function POST(request: Request): Promise<Response> {
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
