import type { Span } from "./CitationHighlight";

/** A grounded, playbook-compliant redline proposal for a flagged clause. */
export interface RedlineProposal {
  playbook_id: string;
  original: Span;
  suggested_text: string;
  rationale: string;
}

export interface RedlineDraftProps {
  redline: RedlineProposal;
}

/**
 * A single playbook-grounded redline proposal: the suggested replacement text and the rationale
 * for it. Extracted from ClauseCard (Task 7) so ExportMemoDialog's preview can render each of a
 * doc's redlines with the same visual language as the inline per-clause panel — same markup, same
 * component, one definition of "what a redline looks like."
 */
export function RedlineDraft({ redline }: RedlineDraftProps) {
  return (
    <div className="rounded-lg border border-accent/20 bg-accent/5 p-4">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-accent">Suggested redline</p>
      <p className="text-sm leading-relaxed text-foreground/90">{redline.suggested_text}</p>
      <p className="mt-2 text-xs text-muted">{redline.rationale}</p>
    </div>
  );
}
