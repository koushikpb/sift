import { cn } from "../../lib/cn";

export type Severity = "low" | "medium" | "high";

export interface SeverityBadgeProps {
  severity: Severity;
  /** true = a red-flag / non-standard term; false = matches the playbook's standard position. */
  deviation: boolean;
}

const SEVERITY_LABEL: Record<Severity, string> = { low: "Low", medium: "Medium", high: "High" };

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 shrink-0" aria-hidden="true">
      <path d="M4 10.5 8 14.5 16 5.5" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 shrink-0" aria-hidden="true">
      <path d="M10 3 2 17h16L10 3Z" />
      <path d="M10 8.25v3.5" />
      <circle cx="10" cy="14.25" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

function FlagIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 shrink-0" aria-hidden="true">
      <path d="M4 17V3" />
      <path d="M4 4h9l-2 3 2 3H4Z" />
    </svg>
  );
}

/**
 * Renders a playbook position's deviation state. Color always ships with a text label + icon
 * (never color alone). `deviation:false` reads as compliant regardless of the playbook's severity
 * rating — severity only matters once a position is actually violated.
 */
export function SeverityBadge({ severity, deviation }: SeverityBadgeProps) {
  if (!deviation) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 py-1 text-xs font-medium text-success">
        <CheckIcon />
        Meets playbook standard
      </span>
    );
  }

  const toneClasses: Record<Severity, string> = {
    high: "border-danger/30 bg-danger/10 text-danger",
    medium: "border-warning/30 bg-warning/10 text-warning",
    low: "border-muted/30 bg-muted/10 text-muted",
  };
  const Icon = severity === "low" ? FlagIcon : AlertIcon;

  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium", toneClasses[severity])}>
      <Icon />
      {SEVERITY_LABEL[severity]} severity · deviation
    </span>
  );
}
