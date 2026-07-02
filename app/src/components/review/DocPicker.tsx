import { cn } from "../../lib/cn";
import { Button } from "../ui/Button";

export interface CuratedDoc {
  id: string;
  label: string;
}

/** Mirrors the API allowlist (app/app/api/review/route.ts CURATED_DOC_IDS) — the only doc_ids
    with precomputed classify labels in `clause_labels`. */
export const CURATED_DOCS: CuratedDoc[] = [
  { id: "contractnli_1", label: "ContractNLI #1 · ~16.6k chars" },
  { id: "contractnli_4", label: "ContractNLI #4 · ~2.4k chars" },
  { id: "contractnli_6", label: "ContractNLI #6 · ~8.7k chars" },
];

/**
 * Playbook position labels, copied verbatim from evals/playbook/nda.yaml `clause_type` fields.
 * reviewContract resolves which playbook position an objective concerns by matching the
 * objective text directly against these labels (see agent/tools/playbookMatch.ts) — so typing
 * one of these exactly (rather than a paraphrased question) is what routes the review through
 * the playbook check and, when the clause deviates, a drafted redline.
 */
export const OBJECTIVE_SUGGESTIONS: string[] = [
  "Term / Duration of Confidentiality",
  "Governing Law",
  "Return or Destruction",
  "Standard Exclusions",
  "Mutual vs One-Sided",
];

export interface DocPickerProps {
  docId: string;
  onDocIdChange: (id: string) => void;
  objective: string;
  onObjectiveChange: (value: string) => void;
  onSubmit: () => void;
  running: boolean;
}

export function DocPicker({ docId, onDocIdChange, objective, onObjectiveChange, onSubmit, running }: DocPickerProps) {
  const canSubmit = docId.length > 0 && objective.trim().length > 0 && !running;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) onSubmit();
      }}
      className="space-y-6"
    >
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-foreground">Document</legend>
        <div className="flex flex-wrap gap-2">
          {CURATED_DOCS.map((doc) => (
            <button
              key={doc.id}
              type="button"
              aria-pressed={docId === doc.id}
              onClick={() => onDocIdChange(doc.id)}
              disabled={running}
              className={cn(
                "min-h-11 cursor-pointer rounded-full border px-4 py-2 text-sm transition-colors duration-200",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                "disabled:pointer-events-none disabled:opacity-50",
                docId === doc.id
                  ? "border-accent bg-accent/15 text-foreground"
                  : "border-foreground/15 text-muted hover:bg-foreground/5",
              )}
            >
              {doc.label}
            </button>
          ))}
        </div>
      </fieldset>

      <div>
        <label htmlFor="objective" className="mb-2 block text-sm font-medium text-foreground">
          Review objective
        </label>
        <input
          id="objective"
          type="text"
          value={objective}
          onChange={(e) => onObjectiveChange(e.target.value)}
          placeholder="e.g. Term / Duration of Confidentiality"
          disabled={running}
          className={cn(
            "w-full rounded-lg border border-foreground/15 bg-foreground/5 px-4 py-3 text-sm text-foreground placeholder:text-muted",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
            "disabled:pointer-events-none disabled:opacity-50",
          )}
        />
        <p className="mt-1.5 text-xs text-muted">
          Matching a playbook position by name (below) also checks it for deviations; other questions are answered and grounded, but skip the playbook check.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {OBJECTIVE_SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => onObjectiveChange(suggestion)}
              disabled={running}
              className={cn(
                "cursor-pointer rounded-full border border-foreground/10 px-3 py-2 text-xs text-muted transition-colors duration-200",
                "hover:bg-foreground/5 hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                "disabled:pointer-events-none disabled:opacity-50",
              )}
            >
              {suggestion}
            </button>
          ))}
        </div>
      </div>

      <Button type="submit" disabled={!canSubmit}>
        {running ? "Reviewing…" : "Review clause"}
      </Button>
    </form>
  );
}
