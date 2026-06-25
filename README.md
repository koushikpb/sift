# sift — Grounded Contract Clause Review Copilot

An agentic, citation-grounded NDA review copilot: extracts clauses, flags deviations against
a playbook, drafts redlines, and takes actions — grounding every claim in a cited source span
and refusing when context is insufficient. See `SPEC.md` for the plan and `CLAUDE.md` for
conventions. Build status: **Phase 0 (Foundation)**.

## Quick start
```bash
cp .env.example .env
make db-up && make migrate         # Postgres + pgvector
make ingest && make parse && make load   # build & load the corpus
make verify-p0                      # Phase 0 gate
```
