/** A grounded citation span: quote === rawText.slice(char_start, char_end) exactly. */
export interface Span {
  doc_id: string;
  char_start: number;
  char_end: number;
  quote: string;
}

interface CitationHighlightProps {
  /** The text the span's offsets are relative to. */
  rawText: string;
  span: Span;
}

/**
 * Renders `rawText` with `[span.char_start, span.char_end)` wrapped in `<mark>` — slice-and-wrap,
 * no fuzzy matching. This is the grounding invariant made visible: the marked text is always
 * exactly `rawText.slice(char_start, char_end)`, which by construction equals `span.quote`.
 */
export function CitationHighlight({ rawText, span }: CitationHighlightProps) {
  const before = rawText.slice(0, span.char_start);
  const marked = rawText.slice(span.char_start, span.char_end);
  const after = rawText.slice(span.char_end);

  return (
    <span>
      {before}
      <mark className="rounded-sm bg-accent/25 px-0.5 text-foreground box-decoration-clone">{marked}</mark>
      {after}
    </span>
  );
}
