import { withClient } from "../db/client.js";
import { EvalItemSchema, type EvalItem } from "./evalItem.js";

export interface ValidateOptions {
  minItems?: number;       // default 50
  requireRefusal?: boolean; // default true
  requireAllCategories?: boolean; // default true (skip in unit tests by setting false)
}

export interface ValidateResult {
  ok: boolean;
  errors: string[];
  stats: { total: number; byCategory: Record<string, number>; byGrader: Record<string, number> };
}

export async function validateEvalSet(
  rawItems: unknown[],
  opts: ValidateOptions = {},
): Promise<ValidateResult> {
  const minItems = opts.minItems ?? 50;
  const requireRefusal = opts.requireRefusal ?? true;
  const requireAllCategories = opts.requireAllCategories ?? true;
  const errors: string[] = [];

  // 1) Schema validity.
  const items: EvalItem[] = [];
  rawItems.forEach((r, i) => {
    const parsed = EvalItemSchema.safeParse(r);
    if (!parsed.success) errors.push(`item ${i}: schema invalid: ${parsed.error.message}`);
    else items.push(parsed.data);
  });

  // 2) Every gold span resolves against the loaded corpus (the grounding gate).
  const rawTextCache = new Map<string, string | null>();
  async function rawText(docId: string): Promise<string | null> {
    if (!rawTextCache.has(docId)) {
      const row = await withClient((c) =>
        c.query("SELECT raw_text FROM documents WHERE doc_id=$1", [docId]),
      );
      rawTextCache.set(docId, row.rowCount ? row.rows[0].raw_text : null);
    }
    return rawTextCache.get(docId)!;
  }
  for (const item of items) {
    for (const s of item.gold_spans) {
      const text = await rawText(s.doc_id);
      if (text === null) {
        errors.push(`item ${item.id}: unknown document ${s.doc_id} (load the corpus first)`);
        continue;
      }
      if (text.slice(s.char_start, s.char_end) !== s.quote) {
        errors.push(`item ${item.id}: gold span [${s.char_start},${s.char_end}) does not match ${s.doc_id}`);
      }
    }
  }

  // 3) Composition gates.
  const byCategory: Record<string, number> = { clean: 0, deviated: 0, missing: 0 };
  const byGrader: Record<string, number> = {};
  for (const item of items) {
    byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;
    byGrader[item.grader] = (byGrader[item.grader] ?? 0) + 1;
  }
  if (items.length < minItems) errors.push(`need at least ${minItems} items, have ${items.length}`);
  if (requireAllCategories) {
    for (const cat of ["clean", "deviated", "missing"]) {
      if (!byCategory[cat]) errors.push(`category "${cat}" has no items (need a clean/deviated/missing mix)`);
    }
  }
  if (requireRefusal && !byGrader["refusal"]) {
    errors.push("no refusal items (need at least one 'insufficient context' item)");
  }

  return { ok: errors.length === 0, errors, stats: { total: items.length, byCategory, byGrader } };
}
