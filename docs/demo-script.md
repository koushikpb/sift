# Demo script — sift NDA review copilot

A 30–45s screen recording → GIF (1280px wide is plenty). One take, one page load, two review
runs (a refusal, then a grounded one), then an export. Every click target and label below is
copied verbatim from the app's source (`app/app/page.tsx` and
`app/src/components/review/*.tsx`) — if the live UI ever shows different text, trust the UI and
treat this script as stale.

**URL:** https://sift-koushikpb1.vercel.app (production; goes live once `phase-6-deploy-wrapup`
merges — that's the point at which this GIF gets recorded).

## Why this script deviates from the original brief

- **Objective text is "confidential information", not "confidentiality term".** The hosted demo
  runs `RETRIEVE_MODE=lexical` (Postgres full-text search; `websearch_to_tsquery` ANDs every word
  of the objective against `clauses.text_search`). Live FTS counts against the production DB
  (`contractnli_4`, curated demo doc):
  - `"confidential information"` → **6** matching clauses.
  - `"confidentiality term"` → **0** matching clauses (the word "term" never appears in this
    document) → the agent refuses.
  So "confidentiality term" can't carry the grounded-review beat — it has nothing to retrieve.
  "confidential information" also resolves cleanly through the playbook synonym map
  (`PLAYBOOK_CLAUSE_SYNONYMS["confidential information"] → definition_scope`,
  `core/src/agent/tools/playbookMatch.ts`), so it drives a real playbook check, not just a
  citation.
- **The zero-hit case becomes the refusal beat (beat 2 below)**, instead of being avoided. Sift
  refusing on an ungrounded objective — instead of hallucinating — is the project's core
  differentiator, and it costs nothing to show: type the objective, submit, and the
  `RefusalNotice` card renders in under a couple of seconds since there's no candidate span to
  reason over.
- **Only one clause card renders per run**, not several streaming in. `reviewContract`
  (`core/src/agent/reviewAgent.ts`) grounds on a single top retrieved clause
  (`card.citations[0]`) and emits at most one `flag` (`core/src/serve/reviewStream.ts`'s
  `clauseEventsFor` — "currently 0 or 1"). What visibly streams is the **status list** above the
  card (`Starting review…`, then the rest), not multiple clause cards.
- **The redline beat is written defensively.** Whether the flagged position actually deviates
  (and therefore whether a "Suggested redline" panel appears) is a live LLM judgment
  (`flag_risks` → `defaultDeviationJudge`, `core/src/agent/tools/flagRisks.ts`) made fresh on
  every run — it cannot be predetermined by this script. Beat 6 branches on whichever the run
  actually produces.

## Setup

- Fresh browser tab, window ≈1280px wide, at the URL above (no query params).
- Nothing needs to be typed into the URL — the doc + objective are picked in the UI.

## Beats

**1. Land on `/` (~3s)**
Page header reads **sift** with the tagline "Grounded contract clause review — every claim
cited to the source text, or refused." Hold briefly so the tagline is readable.

**2. Pick the document (~2s)**
Under the **Document** legend, click the pill labeled exactly **`ContractNLI #4 · ~2.4k chars`**.
It switches to the selected style (accent border, tinted background, `aria-pressed`).

**3. Refusal beat — off-vocabulary objective (~5s)**
Click into the **Review objective** field (labeled "Review objective", placeholder
"e.g. Term / Duration of Confidentiality") and type: `confidentiality term`
— type it directly; it is **not** one of the suggestion chips below the field, so don't click a
chip here. Click **Review clause**.
Within a couple seconds a single card renders with an accent-tinted panel (not red — this is not
an error): the heading **"Insufficient context to review this objective"**, a generated reason
line underneath (wording varies by run — no action needed), and the footnote "Sift only answers
when it can ground a claim in a cited passage — refusing here is the correct outcome, not a
system error." Hold on this card for a beat — it's the refusal, called out deliberately.

**4. Re-run with the real objective (~3s)**
Clear the **Review objective** field and type: `confidential information` (again, type it — it
is not a suggestion chip). Click **Review clause** (it re-enables once the prior run's stream
closed).

**5. Status list (~4s)**
Under the form, a bulleted, `aria-live` status list grows: **"Starting review…"** appears first
(the pulsing `●` marks the active line); the remaining lines — "Retrieving the clause…",
"Checking the playbook position…", "Classifying the clause…", "Flagging deviations…", possibly
"Drafting a redline…", and "Rendering the review memo (preview only)…" — tend to land in a quick
burst once the backend finishes the run, rather than trickling in one at a time. That's expected
behavior, not a dropped frame — no need to reshoot if they all appear together.

**6. The clause card (~6s)**
One card renders. Point at, top to bottom:
- Header: "Reviewing: **confidential information**" plus a severity badge at top-right — either
  green **"Meets playbook standard"** or an amber/red **"`<Severity>` severity · deviation"**
  (the specific outcome is a live LLM judgment call it either way).
- The classification pill just below (LoRA clause-type label · confidence %) — precomputed from
  the `clause_labels` table, exact label/score varies by run.
- The cited quote in the left-bordered blockquote — **hover over the highlighted (`<mark>`)
  span for ~1s**: this is the grounding invariant made visible, the exact
  `rawText.slice(char_start, char_end)`.
- The footer directly under the quote: `contractnli_4 · [char_start, char_end)` — the same
  offsets that produced the highlight.
- The flag rationale sentence below that.

**7. Redline beat — branch on what actually renders (~3s)**
- If a **"Suggested redline"** panel appears (accent-bordered box, uppercase label, suggested
  text + rationale) — open/hover it and read the suggested text.
- If it doesn't (this run's judgment came back non-deviating) — instead hover the flag rationale
  sentence from beat 6 for ~2s.
Either branch shows the grounded reasoning behind the flag; don't dead-end waiting for a redline
that may not come.

**8. Export memo (~3s)**
Once the run finishes (status list stops pulsing), click **Export memo** (bottom-right,
secondary-styled button — only appears once a run has completed). A dialog opens titled
**"Export review memo"** with the description "Preview the memo below — nothing downloads until
you confirm." — it fetches and shows the preview automatically on open (`POST /api/memo` without
`confirm`, never touches disk).

**9. Preview (~3s)**
Point at the monospace preview text inside the scrollable panel. Nothing has downloaded yet —
this is a preview only.

**10. Confirm & download (~3s)**
Click **Confirm & download** (bottom-right of the dialog). Its label flips
"Exporting…" → "Downloaded"; the browser saves `sift-memo-contractnli_4.md`. Close the dialog
(the **×** top-right, labeled "Close") or click outside it.

## Timing note for the recorder

Steps 3–5 and 8–10 each involve a live network round trip (SSE stream / `/api/memo` POST) whose
latency isn't scripted here — trim the dead air in editing rather than speeding up the actual
click/hover beats, to land the final GIF in the 30–45s target.
