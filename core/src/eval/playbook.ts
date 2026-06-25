import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

export const PlaybookEntrySchema = z.object({
  playbook_id: z.string().min(1),
  clause_type: z.string().min(1),
  standard_position: z.string().min(1),
  fallback: z.string(),
  red_flags: z.array(z.string()).min(1),
  severity: z.enum(["low", "medium", "high"]),
}).strict();

export type PlaybookEntry = z.infer<typeof PlaybookEntrySchema>;

export function loadPlaybook(path: string): PlaybookEntry[] {
  const raw = parse(readFileSync(path, "utf-8"));
  const entries = z.array(PlaybookEntrySchema).parse(raw);
  const ids = new Set<string>();
  for (const e of entries) {
    if (ids.has(e.playbook_id)) throw new Error(`duplicate playbook_id: ${e.playbook_id}`);
    ids.add(e.playbook_id);
  }
  return entries;
}

export function playbookIds(entries: PlaybookEntry[]): Set<string> {
  return new Set(entries.map((e) => e.playbook_id));
}
