export interface RefusalNoticeProps {
  reason: string;
}

function ShieldIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5 shrink-0 text-accent"
      aria-hidden="true"
    >
      <path d="M10 2.5 16.5 5v4.5c0 4.14-2.79 7.36-6.5 8-3.71-.64-6.5-3.86-6.5-8V5L10 2.5Z" />
      <path d="M10 10v-2.5" />
      <circle cx="10" cy="12.75" r="0.75" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * Refusal is a correct, first-class outcome — not an error. Styled with the accent (calm,
 * intentional) rather than the danger palette, and framed as the system honoring the
 * grounding contract rather than failing.
 */
export function RefusalNotice({ reason }: RefusalNoticeProps) {
  return (
    <div role="status" className="flex items-start gap-3 rounded-lg border border-accent/25 bg-accent/5 p-4">
      <ShieldIcon />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">Insufficient context to review this objective</p>
        <p className="text-sm text-muted">{reason}</p>
        <p className="text-xs text-muted">
          Sift only answers when it can ground a claim in a cited passage — refusing here is the correct outcome, not a system error.
        </p>
      </div>
    </div>
  );
}
