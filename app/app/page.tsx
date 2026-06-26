"use client";

import { useState, useRef } from "react";
import type { AnswerEvent } from "@sift/core/serve";

type CardEvent = Extract<AnswerEvent, { type: "card" }>;

export default function Page() {
  const [objective, setObjective] = useState("");
  const [docId, setDocId] = useState("");
  const [statusMessages, setStatusMessages] = useState<string[]>([]);
  const [card, setCard] = useState<CardEvent["card"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  function reset() {
    setStatusMessages([]);
    setCard(null);
    setError(null);
  }

  function handleSubmit() {
    if (!objective.trim() || !docId.trim()) return;
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    reset();
    setRunning(true);

    const params = new URLSearchParams({ objective: objective.trim(), docId: docId.trim() });
    const es = new EventSource(`/api/answer?${params.toString()}`);
    esRef.current = es;

    es.addEventListener("status", (e: MessageEvent) => {
      const event = JSON.parse(e.data) as Extract<AnswerEvent, { type: "status" }>;
      setStatusMessages((prev) => [...prev, event.message]);
    });

    es.addEventListener("card", (e: MessageEvent) => {
      const event = JSON.parse(e.data) as CardEvent;
      setCard(event.card);
    });

    es.addEventListener("error", (e: MessageEvent) => {
      if (!e.data) return; // connection-level error — handled by onerror below
      const event = JSON.parse(e.data) as Extract<AnswerEvent, { type: "error" }>;
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
    <main style={{ fontFamily: "sans-serif", maxWidth: 720, margin: "40px auto", padding: "0 16px" }}>
      <h1 style={{ fontSize: 22, marginBottom: 16 }}>sift — Contract Clause Review</h1>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
        <label>
          Objective
          <input
            type="text"
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            placeholder="e.g. What are the confidentiality obligations?"
            style={{ display: "block", width: "100%", marginTop: 4, padding: "6px 8px", fontSize: 14, boxSizing: "border-box" }}
          />
        </label>
        <label>
          Document ID
          <input
            type="text"
            value={docId}
            onChange={(e) => setDocId(e.target.value)}
            placeholder="e.g. cuad-0001"
            style={{ display: "block", width: "100%", marginTop: 4, padding: "6px 8px", fontSize: 14, boxSizing: "border-box" }}
          />
        </label>
        <button
          onClick={handleSubmit}
          disabled={running || !objective.trim() || !docId.trim()}
          style={{ alignSelf: "flex-start", padding: "8px 20px", cursor: "pointer" }}
        >
          {running ? "Running…" : "Review"}
        </button>
      </div>

      {statusMessages.length > 0 && (
        <div style={{ background: "#f5f5f5", padding: 12, borderRadius: 4, marginBottom: 12 }}>
          {statusMessages.map((msg, i) => (
            <div key={i} style={{ fontSize: 13, color: "#555" }}>{msg}</div>
          ))}
        </div>
      )}

      {error && (
        <div style={{ background: "#fff0f0", border: "1px solid #f99", padding: 12, borderRadius: 4, marginBottom: 12 }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {card && (
        <div style={{ border: "1px solid #ccc", borderRadius: 4, padding: 16 }}>
          <h2 style={{ fontSize: 16, marginTop: 0 }}>{card.objective}</h2>

          {card.refused ? (
            <div style={{ color: "#a00" }}>
              <strong>Refused:</strong> {card.refusal_reason ?? "Insufficient context."}
            </div>
          ) : (
            <>
              <p style={{ marginTop: 8 }}>{card.answer}</p>
              {card.citations.length > 0 && (
                <div>
                  <h3 style={{ fontSize: 14, marginBottom: 6 }}>Citations</h3>
                  {card.citations.map((span, i) => (
                    <div
                      key={i}
                      style={{ background: "#fffbe6", border: "1px solid #ffe58f", borderRadius: 3, padding: "6px 10px", marginBottom: 6, fontSize: 13 }}
                    >
                      <span style={{ color: "#888" }}>
                        {span.doc_id} [{span.char_start},{span.char_end})
                      </span>
                      <blockquote style={{ margin: "4px 0 0", padding: "4px 8px", borderLeft: "3px solid #ffe58f" }}>
                        {span.quote}
                      </blockquote>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </main>
  );
}
