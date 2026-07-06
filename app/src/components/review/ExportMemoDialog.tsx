"use client";

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "../../lib/cn";
import { Button } from "../ui/Button";
import type { ReviewFlag } from "./ClauseCard";
import type { RedlineProposal } from "./RedlineDraft";

export interface ExportMemoDialogProps {
  docId: string;
  objective: string;
  flags: ReviewFlag[];
  redlines: RedlineProposal[];
}

type Status = "idle" | "loading" | "ready" | "confirming" | "downloaded" | "error";

interface MemoPreviewResponse {
  written: false;
  preview: string;
}
interface MemoConfirmedResponse {
  written: true;
  markdown: string;
}

function memoRequestBody(props: ExportMemoDialogProps, confirm?: true): string {
  return JSON.stringify({
    doc_id: props.docId,
    objective: props.objective,
    flags: props.flags,
    redlines: props.redlines,
    ...(confirm ? { confirm: true } : {}),
  });
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
      <path d="M5 5l10 10M15 5 5 15" />
    </svg>
  );
}

function downloadMarkdown(docId: string, markdown: string): void {
  const blob = new Blob([markdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `sift-memo-${docId}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * The HITL gate for exporting a review memo, made visible in the UI. Opening this dialog
 * fetches a PREVIEW only (`POST /api/memo` without `confirm` — see route.ts's honest gate: it
 * returns `{written:false, preview}` and never touches disk). The "Confirm & download" button is
 * the ONLY code path in this component that sends `confirm:true`; its response is the only thing
 * ever downloaded, and only after the human has read the preview and clicked it explicitly. No
 * effect here ever auto-confirms or pre-fetches the confirmed variant.
 */
export function ExportMemoDialog(props: ExportMemoDialogProps) {
  const { docId } = props;
  const [status, setStatus] = useState<Status>("idle");
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadPreview() {
    setStatus("loading");
    setPreview(null);
    setError(null);
    try {
      const res = await fetch("/api/memo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: memoRequestBody(props),
      });
      if (!res.ok) throw new Error("preview request failed");
      const data = (await res.json()) as MemoPreviewResponse;
      setPreview(data.preview);
      setStatus("ready");
    } catch {
      setStatus("error");
      setError("Could not build a memo preview. Try again.");
    }
  }

  async function confirmAndDownload() {
    setStatus("confirming");
    setError(null);
    try {
      const res = await fetch("/api/memo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: memoRequestBody(props, true),
      });
      if (!res.ok) throw new Error("export request failed");
      const data = (await res.json()) as MemoConfirmedResponse;
      downloadMarkdown(docId, data.markdown);
      setStatus("downloaded");
    } catch {
      setStatus("error");
      setError("Could not export the memo. Try again.");
    }
  }

  return (
    <Dialog.Root
      onOpenChange={(open) => {
        if (open) void loadPreview();
      }}
    >
      <Dialog.Trigger asChild>
        <Button variant="secondary">Export memo</Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            "fixed inset-0 bg-background/80 backdrop-blur-sm",
            "motion-safe:data-[state=open]:animate-[fade-in_150ms_ease-out]",
            "motion-safe:data-[state=closed]:animate-[fade-out_150ms_ease-in]",
          )}
        />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2",
            "rounded-xl border border-foreground/10 bg-background p-6 shadow-xl",
            "focus-visible:outline-none",
            "motion-safe:data-[state=open]:animate-[dialog-in_200ms_ease-out]",
            "motion-safe:data-[state=closed]:animate-[dialog-out_150ms_ease-in]",
          )}
        >
          <Dialog.Close
            aria-label="Close"
            className={cn(
              "absolute right-4 top-4 rounded-full p-1.5 text-muted transition-colors duration-200",
              "hover:bg-foreground/5 hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
            )}
          >
            <CloseIcon />
          </Dialog.Close>

          <Dialog.Title className="text-base font-semibold text-foreground">Export review memo</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-muted">
            Preview the memo below — nothing downloads until you confirm.
          </Dialog.Description>

          <div
            aria-live="polite"
            className="mt-4 max-h-72 overflow-y-auto rounded-lg border border-foreground/10 bg-foreground/[0.03] p-4"
          >
            {status === "loading" && <p className="text-sm text-muted">Building preview…</p>}
            {error && <p className="text-sm text-danger">{error}</p>}
            {preview && (
              <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground/90">{preview}</pre>
            )}
          </div>

          <div className="mt-6 flex justify-end gap-3">
            <Dialog.Close asChild>
              <Button variant="secondary">Cancel</Button>
            </Dialog.Close>
            <Button onClick={() => void confirmAndDownload()} disabled={!preview || status === "confirming"}>
              {status === "downloaded" ? "Downloaded" : status === "confirming" ? "Exporting…" : "Confirm & download"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
