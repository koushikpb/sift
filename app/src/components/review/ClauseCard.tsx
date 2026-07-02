import { CitationHighlight } from "./CitationHighlight";
import type { Span } from "./CitationHighlight";
import { SeverityBadge } from "./SeverityBadge";
import type { Severity } from "./SeverityBadge";
import { RefusalNotice } from "./RefusalNotice";
import { RedlineDraft } from "./RedlineDraft";
import type { RedlineProposal } from "./RedlineDraft";

export type { RedlineProposal };

export interface ClauseClassification {
  clause_type: string;
  score: number;
}

export interface ReviewFlag {
  playbook_id: string;
  clause_type: string;
  severity: Severity;
  deviation: boolean;
  rationale: string;
  citation: Span | null;
}

export interface ClauseCardProps {
  /** The user's review request — shown for context since a card is self-contained. */
  objective: string;
  /** The grounding citation for this finding. null only for a missing-required-clause finding
      (grounded in absence) or a refusal. */
  citation: Span | null;
  classification: ClauseClassification | null;
  flag: ReviewFlag | null;
  redline: RedlineProposal | null;
  refused: boolean;
  refusal_reason: string | null;
}

/**
 * The stream carries only the cited span (`citation.quote`), not the full document — so the
 * highlight is anchored over the whole quoted excerpt itself: rawText = quote, and the marked
 * range covers it end to end. The invariant (`quote === rawText.slice(char_start, char_end)`)
 * still holds exactly; there's just no surrounding, unhighlighted context to show here.
 */
function fullSpan(citation: Span): Span {
  return { ...citation, char_start: 0, char_end: citation.quote.length };
}

/**
 * One reviewed position: the objective, the LoRA clause-type label, the playbook flag/severity,
 * the grounding citation (highlighted verbatim), and a redline proposal when the position
 * deviates. Refusals render via RefusalNotice, never as an error or an empty state.
 */
export function ClauseCard({
  objective,
  citation,
  classification,
  flag,
  redline,
  refused,
  refusal_reason,
}: ClauseCardProps) {
  return (
    <article className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-5 sm:p-6">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <p className="text-sm text-muted">
          Reviewing: <span className="text-foreground">{objective}</span>
        </p>
        {flag && <SeverityBadge severity={flag.severity} deviation={flag.deviation} />}
      </header>

      {classification && (
        <span className="mb-4 inline-flex items-center gap-1.5 rounded-full border border-foreground/15 px-2.5 py-1 text-xs text-muted">
          {classification.clause_type}
          <span className="text-foreground/50">· {Math.round(classification.score * 100)}%</span>
        </span>
      )}

      {refused ? (
        <RefusalNotice reason={refusal_reason ?? "Insufficient context to ground an answer in the contract text."} />
      ) : (
        <div className="space-y-4">
          {citation ? (
            <blockquote className="border-l-2 border-accent/40 pl-4 text-sm leading-relaxed text-foreground/90">
              <CitationHighlight rawText={citation.quote} span={fullSpan(citation)} />
              <footer className="mt-2 text-xs text-muted">
                {citation.doc_id} · [{citation.char_start}, {citation.char_end})
              </footer>
            </blockquote>
          ) : (
            <p className="text-sm text-danger">
              No source text found — this position does not appear anywhere in the document.
            </p>
          )}

          {flag && <p className="text-sm text-muted">{flag.rationale}</p>}

          {redline && <RedlineDraft redline={redline} />}
        </div>
      )}
    </article>
  );
}
