# Phase 5 Scope — Demo, Hosting & Security Hardening

**Status:** scoping (pre-plan). Not started.
**Framing:** P5 turns the completed 3-layer system (L1 agentic RAG, L2 LoRA classifier, L3 action
agent + MCP) into a **shareable, hosted, secured demo** suitable for a resume. This is a
*productize + prove* phase — no new ML capability.

---

## Goal
A public URL an interviewer can open and use in under a minute, with zero setup, that shows the
product's differentiator — **grounded, cited clause review that refuses when it can't ground an
answer** — backed by a security posture we've actually tested (rate limits, no exposed secrets).

## Success criteria
- Public, working demo link; loads and produces a real grounded review in seconds.
- Clean, professional UI (not overdone) that foregrounds citations + refusal + the HITL action.
- Security **validated, not assumed**: automated secret scan clean over repo *and git history*;
  API rate-limited; NIM key never reaches the client; inputs validated; deps audited.
- Demo stays reliable despite NIM free-tier latency (the hard part).

---

## Prerequisite — P5.0: clean gate re-run (off-peak)
Before building a demo on top, land a clean 50/50 gate (0 transport errors) with the hard
invariants holding. Peak-hours NIM congestion made this flaky; run off-peak (early AM Pacific)
on the canonical `llama-3.3-70b` if responsive, else `llama-3.1-70b`. Runner is prepared
(`scratchpad/run_gate.sh`, auto model-probe). Blocks the "project done" claim; does not block P5
design.

---

## Workstreams

### A. Demo reliability strategy — the pivotal decision
Core tension: **live NIM calls are 7–120s and flaky on the free tier → a bad live demo.** Options:
1. **Curated + cached (recommended).** Ship 2–3 pre-loaded sample NDAs; run the agent live once,
   cache the grounded trajectory; "demo mode" serves cached results instantly, with an optional
   "run live" button. Reliable, fast, still shows real output.
2. **Live-only.** Simplest to build, worst experience. Not recommended.
3. **Swap inference for the demo** to a low-latency paid provider behind the same OpenAI-compat
   interface (the client is already provider-agnostic via `LLM_BASE_URL`/`LLM_MODEL`). Best live
   UX for small cost.
→ Recommend **(1)**, optionally **(3)** for the "run live" path.

### B. Web UI — Next.js app in the monorepo (per SPEC, consumes `core/`)
New `app/` (or `web/`) package. Minimal, focused screens:
- **Pick a contract** — curated samples (optional paste).
- **Review view** — clause cards with risk flags + severity, and **inline citations that highlight
  the exact source span** (the money shot — proves grounding). Refusals shown explicitly.
- **Redline drafts** per flagged clause.
- **Export memo** — the HITL action, with the `confirm` gate visible in the UI.
Design: single accent color, system font, generous whitespace, Tailwind + a few Radix primitives.
No dashboard sprawl.

### C. Backend API — expose the agent to the UI
Thin server-side layer wrapping `reviewContract` + individual tools (Next.js route handlers or a
small Node server). Holds NIM key + DB creds server-side only. Stream clause cards as they resolve
for perceived speed. Note: the Python LoRA `classify` subprocess is a hosting constraint (see E) —
either colocate it or precompute classifications for curated docs.

### D. Security & hardening
- **Secret scanning:** `gitleaks` (or trufflehog) over working tree **and full git history** to
  *verify* no key/password was ever committed (`.env` is gitignored — this confirms it). Add a
  pre-commit hook + CI check to keep it clean.
- **Rate limiting:** per-IP limit + global concurrency cap on the API (protects the NIM key/cost,
  prevents abuse). Upstash Ratelimit on Vercel, or Redis/in-process token bucket otherwise.
- **Key hygiene:** NIM key server-side only; never in the client bundle; host secret store.
- **Input validation & limits:** Zod on every API input (existing pattern); cap document size;
  reject non-text.
- **Web hardening:** security headers (CSP, HSTS), CORS locked to the app origin, no verbose error
  leakage.
- **Dependency audit:** `npm audit` + `pip-audit`; patch highs.
- **Cost guardrail:** NIM free tier = 1000 credits; a public demo could exhaust it → lean on (A)
  caching + rate limits + a daily cap.

### E. Hosting / deployment
Stack = Next.js (TS) + Postgres/pgvector + a **Python LoRA subprocess** + outbound NIM. Options:
1. **Split:** Frontend+API on **Vercel**; pgvector on **Neon/Supabase**; Python classify as a small
   container (Fly.io/Railway/Render) *or* dropped from the live path (precompute for curated docs).
2. **Single container (recommended):** Node + Python colocated on **Fly.io/Railway** + managed
   pgvector. Matches how `classify` is spawned today — least refactor.
→ Recommend **single container**; use Vercel-split only if we drop live Python from the demo path.

### F. Polish & narrative
- README with architecture diagram, the 3-layer story, and the eval numbers.
- Short demo GIF / script for the resume.
- In-app "How it works" page (grounding invariant, refusal, HITL) — sells the engineering.

---

## Decisions to make (recommendations in bold)
1. **Demo reliability:** **curated+cached** vs live vs swap-provider.
2. **Hosting target:** **single container (Fly.io/Railway)** vs Vercel-split.
3. **Live-path inference:** **NIM free (cheap/slow)** vs a faster paid provider for the demo.
4. **Security depth:** **essentials above** vs a deeper pen-test-style pass.

## Rough timeline (calendar, part-time)
| Item | Est. |
|---|---|
| P5.0 clean gate (off-peak, mostly wait) | <1 day |
| A decisions + scaffolding | ~1 day |
| B UI | ~3–4 days |
| C API | ~2 days |
| D security | ~1–2 days |
| E hosting | ~1–2 days |
| F polish | ~1 day |
| **Total** | **≈ 9–12 working days** |

---

## Non-goals (unchanged from SPEC)
Not legal advice. Not multi-contract enterprise. Not a chat-over-PDF wrapper. P5 adds no new legal
capability — it packages and hardens what exists.

---

## Curated demo docs

The Task-4 precompute pipeline (`make clf-precompute`) runs against exactly three public
ContractNLI NDAs selected for size variety and clean node structure:

| doc_id | approx. chars | clause rows |
|---|---|---|
| `contractnli_4` | 2 405 | 9 |
| `contractnli_6` | 8 715 | 20 |
| `contractnli_1` | 16 632 | 13 |

These are the **demo/review allowlist** for the Task-5 API.  All are licensed for NLP research
(ContractNLI public corpus). Total: 42 precomputed label rows in `clause_labels`.
