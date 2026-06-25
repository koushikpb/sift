# CLAUDE.md — Grounded Contract Clause Review Copilot ("sift")

Read `SPEC.md` for the full project plan. This file is the working contract for agents.

## What this is
An agentic, citation-grounded contract-review copilot for NDAs (wedge). It extracts
clauses/fields, flags deviations against a playbook, drafts redlines, and takes actions —
every claim grounded in a cited source span, refusing when context is insufficient.

## Stack (hybrid monorepo)
- `pipeline/` — **Python 3.11**: dataset ingestion + structure-aware parser. Emits JSON
  artifacts to `data/processed/`. Reserved (per spec) for data work, fine-tuning, encoders.
- `core/` — **TypeScript / Node 20**: pgvector schema, corpus loader, eval tooling. Reads
  the Python artifacts. The future Next.js app (P1) depends on `core/`.
- `schemas/` — JSON Schema source of truth for every cross-language artifact.
- Postgres 16 + `pgvector`, run locally via `docker-compose.yml`.

## Non-negotiable conventions
- **Citation format:** a grounded span is `{ doc_id, char_start, char_end, quote }` with
  `quote === raw_text.slice(char_start, char_end)` exactly. Tests enforce this.
- **Typed payloads only:** validate every artifact — pydantic (Python) / Zod (TS) — against
  `schemas/`. No unvalidated data crosses a module boundary.
- **Refuse when ungrounded:** "insufficient context" is a correct answer, not a failure.
- **Public data only.** No client data, no PII. Licenses recorded in `DATA.md`.
- **Vector backend is swappable:** all DB access goes through `core/src/db/`.
- **Evals are the merge gate.** No task is done until its test/eval passes.

## Commands
- DB:        `make db-up` / `make db-down`
- Migrate:   `make migrate`
- Python:    `make py-test` · `make py-lint`
- TS:        `make ts-test` · `make ts-typecheck`
- Ingest:    `make ingest`        (CUAD + ContractNLI → data/processed/*/raw.jsonl,gold.jsonl)
- Parse:     `make parse`         (raw.jsonl → docs.jsonl with hierarchy nodes)
- Load:      `make load`          (docs.jsonl → pgvector)
- Phase gate: `make verify-p0`

## Non-goals
Not legal advice (human decides). Not a multi-contract enterprise platform. Not a
chat-over-PDF wrapper — the action layer, MCP server, and eval rigor are the point.
