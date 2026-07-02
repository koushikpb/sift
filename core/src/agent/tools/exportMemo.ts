import { z } from "zod";
import type { ReviewMemo, ToolDef } from "./types.js";
import { ReviewMemoSchema } from "./types.js";

// Re-exported so app/app/api/memo/route.ts (Task 7) can validate its POST body against the exact
// shape renderMemoMarkdown consumes, via the DB-free `@sift/core/agent/memo` entry point below —
// not `@sift/core/agent` (index.ts), which also imports db/client.ts for buildReviewDeps'
// clause-label lookups and throws at module-evaluation time when DATABASE_URL isn't visible.
export { ReviewMemoSchema };
export type { ReviewMemo };

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
    const loc = fl.citation
      ? ` _(chars ${fl.citation.char_start}-${fl.citation.char_end})_`
      : " _(clause not found — missing)_";
    lines.push(`- **${fl.playbook_id}** (${fl.severity}${fl.deviation ? ", DEVIATION" : ""}): ${fl.rationale}${loc}`);
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
