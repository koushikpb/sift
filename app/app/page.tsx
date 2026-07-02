"use client";

import { useRef, useState } from "react";
import type { ReviewEvent } from "@sift/core/serve/review";
import { cn } from "../src/lib/cn";
import { ClauseCard } from "../src/components/review/ClauseCard";
import { DocPicker } from "../src/components/review/DocPicker";

type ClauseEvent = Extract<ReviewEvent, { type: "clause" }>;
type StatusEvent = Extract<ReviewEvent, { type: "status" }>;
type ErrorEvent = Extract<ReviewEvent, { type: "error" }>;

/**
 * The review UI — this app's only page (no landing page, no dashboard). Picks a curated NDA +
 * objective, opens `/api/review` as an SSE stream, and renders each `clause` event as it arrives.
 * Mirrors the previous /api/answer page's EventSource handling (status/error/done), swapped onto
 * the review endpoint's richer clause-event shape.
 */
export default function Page() {
  const [docId, setDocId] = useState("");
  const [objective, setObjective] = useState("");
  const [submittedObjective, setSubmittedObjective] = useState("");
  const [statusMessages, setStatusMessages] = useState<string[]>([]);
  const [clauses, setClauses] = useState<ClauseEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  function reset() {
    setStatusMessages([]);
    setClauses([]);
    setError(null);
  }

  function handleSubmit() {
    const trimmedObjective = objective.trim();
    if (!trimmedObjective || !docId) return;
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    reset();
    setRunning(true);
    setSubmittedObjective(trimmedObjective);

    const params = new URLSearchParams({ objective: trimmedObjective, docId });
    const es = new EventSource(`/api/review?${params.toString()}`);
    esRef.current = es;

    es.addEventListener("status", (e: MessageEvent) => {
      const event = JSON.parse(e.data) as StatusEvent;
      setStatusMessages((prev) => [...prev, event.message]);
    });

    es.addEventListener("clause", (e: MessageEvent) => {
      const event = JSON.parse(e.data) as ClauseEvent;
      setClauses((prev) => [...prev, event]);
    });

    es.addEventListener("error", (e: MessageEvent) => {
      if (!e.data) return; // connection-level error — handled by onerror below
      const event = JSON.parse(e.data) as ErrorEvent;
      setError(event.message);
    });

    es.addEventListener("done", () => {
      es.close();
      esRef.current = null;
      setRunning(false);
    });

    // Also handle SSE-level errors (connection dropped, etc.)
    es.onerror = () => {
      es.close();
      esRef.current = null;
      setRunning(false);
    };
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12 sm:py-16">
      <header className="mb-10">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">sift</h1>
        <p className="mt-1.5 text-sm text-muted">
          Grounded contract clause review — every claim cited to the source text, or refused.
        </p>
      </header>

      <DocPicker
        docId={docId}
        onDocIdChange={setDocId}
        objective={objective}
        onObjectiveChange={setObjective}
        onSubmit={handleSubmit}
        running={running}
      />

      {statusMessages.length > 0 && (
        <div aria-live="polite" className="mt-8 space-y-1.5 border-l border-foreground/10 pl-4">
          {statusMessages.map((msg, i) => {
            const isCurrent = running && i === statusMessages.length - 1;
            return (
              <p key={i} className={cn("text-xs", isCurrent ? "text-foreground" : "text-muted")}>
                <span className={cn("mr-1.5 inline-block", isCurrent && "motion-safe:animate-pulse")} aria-hidden="true">
                  {isCurrent ? "●" : "○"}
                </span>
                {msg}
              </p>
            );
          })}
        </div>
      )}

      {error && (
        <div role="alert" className="mt-6 rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
          <strong className="font-medium">Something went wrong: </strong>
          {error}
        </div>
      )}

      {clauses.length > 0 && (
        <div className="mt-8 space-y-4">
          {clauses.map((event, i) => (
            <ClauseCard
              key={i}
              objective={submittedObjective}
              citation={event.citation}
              classification={event.classification}
              flag={event.flag}
              redline={event.redline}
              refused={event.refused}
              refusal_reason={event.refusal_reason}
            />
          ))}
        </div>
      )}
    </main>
  );
}
