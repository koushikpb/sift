# Phase 0 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the repo, the foundational project docs, a structure-aware contract corpus (CUAD + ContractNLI) loaded into pgvector, and a 50-item graded eval set — the verifiable foundation every later phase builds on.

**Architecture:** Hybrid two-language monorepo. **Python** (`pipeline/`) owns dataset ingestion and the structure-aware parser, emitting normalized JSON artifacts to disk. **TypeScript** (`core/`) owns the pgvector schema, the corpus loader, and the eval tooling, reading those artifacts. The two sides meet only at documented on-disk JSON contracts (`schemas/`), so neither imports the other. Postgres + pgvector run locally via Docker Compose.

**Tech Stack:** Python 3.11 (pydantic v2, `datasets`, pytest, ruff) · TypeScript / Node 20 (`pg`, `zod`, `yaml`, `dotenv`, `tsx`, vitest) · Postgres 16 + `pgvector` (Docker) · JSON Schema (cross-language data contract).

## Global Constraints

These apply to **every** task. Copied from `PLAN.md` §"Core engineering invariants", §1, §4, §5.

- **Citation format is fixed:** a citation/grounded span is `{ doc_id, char_start, char_end, quote }` where `quote === raw_text.slice(char_start, char_end)` **exactly** (no trimming, no normalization). Offsets are 0-based character offsets into the document's canonical `raw_text`. This invariant is enforced by automated tests, not by convention.
- **Typed, schema-validated payloads only:** every artifact that crosses the Python↔TS seam or leaves a module is validated — pydantic on the Python side, Zod on the TS side — against the canonical JSON Schemas in `schemas/`. Unvalidated data is a bug.
- **Public data only:** CUAD, ContractNLI, LEDGAR, LegalBench-RAG, SEC EDGAR. No client data, no PII. Every dataset's source + license is recorded in `DATA.md` before it is used.
- **Refuse-when-ungrounded is a first-class behavior:** the eval set must include items whose correct answer is "insufficient context" (the `refusal` grader). Phase 0 only authors these items; later phases consume them.
- **Vector backend is swappable:** all DB access goes through `core/src/db/` — no raw `pg` calls scattered through feature code. pgvector is the Phase 0 default behind that boundary.
- **No secrets in git:** connection strings live in `.env` (gitignored); `.env.example` carries placeholders only.
- **NDA is the wedge.** `contract_type` is `"nda"` for ContractNLI docs and `"unknown"` for CUAD docs (CUAD is a multi-type clause-extraction corpus); do not infer finer types in Phase 0.

**Phase 0 eval gate (from PLAN.md §6):** Corpus loaded into pgvector; the structure-aware parser preserves hierarchy on 10 sample contracts; eval set v1 (50 items) authored and validated. Task 15 is the single command that proves all three.

**Repo note:** the existing `sift/` subdirectory is an unrelated Obsidian vault (a note on semiconductor companies) and `.claude/` / `.apm/` are agent tooling — leave them untouched. All Phase 0 work lands at the repo root and in the new directories below.

---

## File Structure

```
sift/                                  (repo root)
├── CLAUDE.md  SPEC.md  DECISIONS.md  DATA.md  README.md   # foundational docs (Task 1)
├── .gitignore  .env.example  docker-compose.yml  Makefile
├── schemas/                           # cross-language data contract (Tasks 1, 4)
│   ├── parsed-document.schema.json
│   ├── gold-label.schema.json
│   ├── eval-item.schema.json
│   └── examples/{parsed-document,gold-label}.example.json
├── pipeline/                          # PYTHON: ingestion + parser
│   ├── pyproject.toml  ruff.toml
│   ├── pipeline/
│   │   ├── __init__.py  artifacts.py  cli.py  parse_docs.py
│   │   ├── ingest/{__init__.py,cuad.py,contractnli.py}
│   │   └── parser/{__init__.py,structure.py}
│   ├── fixtures/contracts/*.txt       # 10 sample contracts (Task 10)
│   ├── fixtures/expected_hierarchy.json
│   └── tests/test_*.py
├── core/                              # TYPESCRIPT: db + loader + eval tooling
│   ├── package.json  tsconfig.json  vitest.config.ts  .nvmrc
│   ├── migrations/000{1,2,3}_*.sql
│   ├── src/
│   │   ├── db/{client.ts,migrate.ts}
│   │   ├── schemas/{parsedDocument.ts,goldLabel.ts}
│   │   ├── load/{loadDocs.ts,cli.ts}
│   │   └── eval/{evalItem.ts,playbook.ts,derive.ts,validate.ts,cli.ts}
│   └── test/*.test.ts
├── evals/
│   ├── playbook/nda.yaml              # NDA playbook (Task 12)
│   └── data/{candidates.jsonl,eval-set-v1.json}
├── data/                             # GITIGNORED build artifacts
│   ├── raw/<source>/…
│   └── processed/<source>/{raw.jsonl,gold.jsonl,docs.jsonl}
└── docs/
    ├── superpowers/plans/2026-06-24-phase-0-foundation.md   (this file)
    └── eval-reports/P0.md            (Task 15)
```

**The Python↔TS seam** is exactly three on-disk formats, all defined by `schemas/`:
- `data/processed/<source>/raw.jsonl` — one `ParsedDocument` per line, `nodes: []` (Tasks 7–8).
- `data/processed/<source>/docs.jsonl` — the same documents with `nodes` populated by the parser (Task 10).
- `data/processed/<source>/gold.jsonl` — one `GoldLabel` per line (Tasks 7–8).

Python writes them; TS reads them. No code dependency crosses the line.

---

## Task 1: Repo skeleton + foundational docs

**Files:**
- Create: `CLAUDE.md`, `SPEC.md`, `DECISIONS.md`, `DATA.md`, `README.md`
- Create: `.gitignore`, `.env.example`
- Create: `schemas/parsed-document.schema.json`, `schemas/gold-label.schema.json`, `schemas/eval-item.schema.json`

**Interfaces:**
- Produces: the canonical JSON Schemas (`ParsedDocument`, `GoldLabel`, `EvalItem`) that Tasks 4, 7–8, 13–14 implement against; the citation-format and convention docs every later task follows.

- [ ] **Step 1: Create `.gitignore`**

```gitignore
# Python
__pycache__/
*.py[cod]
.venv/
.pytest_cache/
.ruff_cache/
*.egg-info/

# Node
node_modules/
dist/
.tsbuildinfo

# Env & secrets
.env
.env.local

# Build artifacts (regenerated by the pipeline)
/data/raw/
/data/processed/

# OS
.DS_Store
```

- [ ] **Step 2: Create `.env.example`**

```bash
# Copy to .env and fill in. .env is gitignored.
DATABASE_URL=postgres://sift:sift@localhost:5433/sift
```

- [ ] **Step 3: Create `schemas/parsed-document.schema.json`**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://sift.local/schemas/parsed-document.json",
  "title": "ParsedDocument",
  "type": "object",
  "additionalProperties": false,
  "required": ["doc_id", "source", "contract_type", "raw_text", "char_length", "raw_sha256", "nodes"],
  "properties": {
    "doc_id": { "type": "string", "minLength": 1 },
    "source": { "enum": ["cuad", "contractnli"] },
    "title": { "type": ["string", "null"] },
    "contract_type": { "type": "string" },
    "raw_text": { "type": "string" },
    "char_length": { "type": "integer", "minimum": 0 },
    "raw_sha256": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
    "nodes": { "type": "array", "items": { "$ref": "#/$defs/node" } }
  },
  "$defs": {
    "node": {
      "type": "object",
      "additionalProperties": false,
      "required": ["node_id", "parent_id", "type", "number", "heading", "text", "char_start", "char_end", "depth"],
      "properties": {
        "node_id": { "type": "string", "minLength": 1 },
        "parent_id": { "type": ["string", "null"] },
        "type": { "enum": ["preamble", "recital", "article", "section", "subsection", "definition", "exhibit", "clause"] },
        "number": { "type": ["string", "null"] },
        "heading": { "type": ["string", "null"] },
        "text": { "type": "string" },
        "char_start": { "type": "integer", "minimum": 0 },
        "char_end": { "type": "integer", "minimum": 0 },
        "depth": { "type": "integer", "minimum": 0 }
      }
    }
  }
}
```

- [ ] **Step 4: Create `schemas/gold-label.schema.json`**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://sift.local/schemas/gold-label.json",
  "title": "GoldLabel",
  "type": "object",
  "additionalProperties": false,
  "required": ["label_id", "doc_id", "source", "kind", "spans"],
  "properties": {
    "label_id": { "type": "string", "minLength": 1 },
    "doc_id": { "type": "string", "minLength": 1 },
    "source": { "enum": ["cuad", "contractnli"] },
    "kind": { "enum": ["clause_span", "nli"] },
    "clause_type": { "type": ["string", "null"] },
    "hypothesis": { "type": ["string", "null"] },
    "nli_label": { "enum": ["entailment", "contradiction", "not_mentioned", null] },
    "spans": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["char_start", "char_end", "quote"],
        "properties": {
          "char_start": { "type": "integer", "minimum": 0 },
          "char_end": { "type": "integer", "minimum": 0 },
          "quote": { "type": "string" }
        }
      }
    }
  }
}
```

- [ ] **Step 5: Create `schemas/eval-item.schema.json`**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://sift.local/schemas/eval-item.json",
  "title": "EvalItem",
  "type": "object",
  "additionalProperties": false,
  "required": ["id", "doc_id", "source", "contract_type", "category", "objective", "expected_fields", "expected_flags", "gold_spans", "grader", "notes"],
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "doc_id": { "type": "string", "minLength": 1 },
    "source": { "enum": ["cuad", "contractnli"] },
    "contract_type": { "type": "string" },
    "category": { "enum": ["clean", "deviated", "missing"] },
    "objective": { "type": "string", "minLength": 1 },
    "expected_fields": {
      "type": "array",
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["name", "value"],
        "properties": { "name": { "type": "string" }, "value": { "type": ["string", "null"] } }
      }
    },
    "expected_flags": {
      "type": "array",
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["playbook_id", "severity"],
        "properties": { "playbook_id": { "type": "string" }, "severity": { "enum": ["low", "medium", "high"] } }
      }
    },
    "gold_spans": {
      "type": "array",
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["doc_id", "char_start", "char_end", "quote"],
        "properties": {
          "doc_id": { "type": "string" },
          "char_start": { "type": "integer", "minimum": 0 },
          "char_end": { "type": "integer", "minimum": 0 },
          "quote": { "type": "string" }
        }
      }
    },
    "grader": { "enum": ["span_match", "field_match", "flag_match", "refusal"] },
    "notes": { "type": "string" }
  }
}
```

- [ ] **Step 6: Create `CLAUDE.md`**

```markdown
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
```

- [ ] **Step 7: Create `SPEC.md`** — a trimmed restatement of `PLAN.md`. Include: project summary (PLAN.md §"Project summary"), goals (§"Goals"), the core engineering invariants verbatim (§"Core engineering invariants"), the three layers + acceptance criteria (§2), the eval harness datasets/metrics table (§3), and the phased roadmap table (§6). Keep it to the durable spec — omit prose rationale. Begin the file with: `> Trimmed from PLAN.md. PLAN.md remains the canonical source; update both together.`

- [ ] **Step 8: Create `DECISIONS.md`**

```markdown
# DECISIONS.md

Architectural decisions, kept current as they are made. Newest first.

## 2026-06-24 — Phase 0 foundations
- **Hybrid language split.** Python (`pipeline/`) owns ingestion + the structure-aware
  parser; TypeScript (`core/`) owns the pgvector schema, loader, and eval tooling. They meet
  only at on-disk JSON artifacts validated against `schemas/`. Rationale: keep data-heavy
  parsing in Python's ecosystem while keeping the DB/retrieval layer in the app's TS
  ecosystem (Layer 1 is TS/Next.js); reserve Python for data + fine-tuning per the spec.
- **pgvector via local Docker Compose** for development (image `pgvector/pgvector:pg16`).
  Defer hosted Postgres to P1 when a live URL is needed. Rationale: self-contained,
  reproducible, no external account or secrets in Phase 0.
- **Eval set v1 derived-then-curated.** A converter derives candidate items from CUAD +
  ContractNLI gold labels; humans curate down to 50 (clean/deviated/missing mix).
  Rationale: ground the set in expert labels and reach a defensible v1 faster than
  hand-authoring from scratch.
- **Embeddings deferred to P1.** Phase 0 sets up pgvector (extension, schema, smoke test)
  and loads structured chunks without vectors; the embedder is a measured P1/P2 experiment,
  so committing to a model/dimension now would be premature. Embedding column dimension is
  a single documented constant (`embeddings.embedding vector(1024)`) that P1 confirms.
```

- [ ] **Step 9: Create `DATA.md`**

```markdown
# DATA.md

Public datasets only. No client data, no PII. Record source + license **before** use.

| Dataset | Source | License | Use in this project |
|---|---|---|---|
| CUAD | The Atticus Project — https://www.atticusprojectai.org/cuad · HF `theatticusproject/cuad-qa` | CC BY 4.0 (credit The Atticus Project) | Gold clause-extraction spans → corpus + eval candidates |
| ContractNLI | https://stanfordnlp.github.io/contract-nli/ | CC BY 4.0 — **confirm against the dataset's LICENSE/README on download and record the exact string here** | NDA hypotheses (entail/contradict/not-mentioned) + evidence spans → NDA corpus + risk-flag eval candidates |

Planned later (not ingested in Phase 0): LEDGAR (LexGLUE, fine-tuning), LegalBench-RAG
(retrieval ground truth), LegalBench (reasoning), SEC EDGAR (demo + lease expansion).

## Verification
On first download, confirm each license from the dataset's own LICENSE/README and update
the table above with the exact license string and the date confirmed. Do not ingest a
dataset whose license has not been recorded here.

## Storage
Raw downloads land in `data/raw/<source>/` and normalized artifacts in
`data/processed/<source>/`. Both are gitignored — regenerate with `make ingest && make parse`.
```

- [ ] **Step 10: Create `README.md`**

```markdown
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
```

- [ ] **Step 11: Verify all docs and schemas are present and valid JSON**

Run:
```bash
cd /Users/koushik/Documents/GitHub/sift && \
ls CLAUDE.md SPEC.md DECISIONS.md DATA.md README.md .gitignore .env.example && \
python3 -c "import json,glob,sys; [json.load(open(f)) for f in glob.glob('schemas/*.json')]; print('schemas OK')"
```
Expected: the file list prints with no "No such file" error, then `schemas OK`.

- [ ] **Step 12: Commit**

```bash
git add CLAUDE.md SPEC.md DECISIONS.md DATA.md README.md .gitignore .env.example schemas/
git commit -m "chore: repo skeleton, foundational docs, and JSON Schema data contract"
```

---

## Task 2: Python toolchain bootstrap

**Files:**
- Create: `pipeline/pyproject.toml`, `pipeline/ruff.toml`
- Create: `pipeline/pipeline/__init__.py`
- Test: `pipeline/tests/test_smoke.py`
- Modify: `Makefile` (create with Python targets)

**Interfaces:**
- Produces: the `pipeline` Python package importable as `pipeline.*`, and `make py-test` / `make py-lint`. All later Python tasks run inside this.

- [ ] **Step 1: Create `pipeline/pyproject.toml`**

```toml
[project]
name = "sift-pipeline"
version = "0.0.0"
requires-python = ">=3.11"
dependencies = [
  "pydantic>=2.6",
  "datasets>=2.18",
  "requests>=2.31",
]

[project.optional-dependencies]
dev = ["pytest>=8.0", "ruff>=0.4"]

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
include = ["pipeline*"]

[tool.pytest.ini_options]
pythonpath = ["."]
testpaths = ["tests"]
```

- [ ] **Step 2: Create `pipeline/ruff.toml`**

```toml
line-length = 100
target-version = "py311"
[lint]
select = ["E", "F", "I", "UP"]
```

- [ ] **Step 3: Write the failing test — `pipeline/tests/test_smoke.py`**

```python
def test_package_imports():
    import pipeline
    assert pipeline.__name__ == "pipeline"
```

- [ ] **Step 4: Create the venv, install, and run the test to verify it FAILS**

Run:
```bash
cd /Users/koushik/Documents/GitHub/sift/pipeline && \
python3 -m venv .venv && ./.venv/bin/pip install -q -e ".[dev]" && \
./.venv/bin/python -m pytest tests/test_smoke.py -q
```
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline'` (the package `__init__.py` does not exist yet).

- [ ] **Step 5: Create the package — `pipeline/pipeline/__init__.py`**

```python
"""sift data pipeline: dataset ingestion + structure-aware contract parsing."""
```

- [ ] **Step 6: Run the test to verify it PASSES**

Run: `cd /Users/koushik/Documents/GitHub/sift/pipeline && ./.venv/bin/python -m pytest tests/test_smoke.py -q`
Expected: PASS (1 passed).

- [ ] **Step 7: Create `Makefile` (repo root) with Python targets**

```makefile
PY := pipeline/.venv/bin/python
PIP := pipeline/.venv/bin/pip

.PHONY: py-test py-lint
py-test:
	cd pipeline && .venv/bin/python -m pytest -q
py-lint:
	cd pipeline && .venv/bin/python -m ruff check .
```

- [ ] **Step 8: Verify Make targets work**

Run: `cd /Users/koushik/Documents/GitHub/sift && make py-test && make py-lint`
Expected: `1 passed` then ruff reports `All checks passed!` (or no output / exit 0).

- [ ] **Step 9: Commit**

```bash
git add pipeline/pyproject.toml pipeline/ruff.toml pipeline/pipeline/__init__.py pipeline/tests/test_smoke.py Makefile
git commit -m "build(pipeline): python toolchain (pydantic, datasets, pytest, ruff)"
```

---

## Task 3: TypeScript toolchain bootstrap

**Files:**
- Create: `core/package.json`, `core/tsconfig.json`, `core/vitest.config.ts`, `core/.nvmrc`
- Create: `core/src/index.ts`
- Test: `core/test/smoke.test.ts`
- Modify: `Makefile` (add TS targets)

**Interfaces:**
- Produces: the `core` TS package (Node 20, ESM), `make ts-test` / `make ts-typecheck`. All later TS tasks run inside this.

- [ ] **Step 1: Create `core/.nvmrc`**

```
20
```

- [ ] **Step 2: Create `core/package.json`**

```json
{
  "name": "@sift/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "migrate": "tsx src/db/migrate.ts",
    "load": "tsx src/load/cli.ts",
    "eval": "tsx src/eval/cli.ts"
  },
  "dependencies": {
    "dotenv": "^16.4.5",
    "pg": "^8.11.5",
    "yaml": "^2.4.5",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.12.0",
    "@types/pg": "^8.11.0",
    "tsx": "^4.10.0",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 3: Create `core/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 4: Create `core/vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
  },
});
```

- [ ] **Step 5: Write the failing test — `core/test/smoke.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { hello } from "../src/index.js";

describe("toolchain smoke", () => {
  it("imports from src", () => {
    expect(hello()).toBe("sift-core");
  });
});
```

- [ ] **Step 6: Install and run the test to verify it FAILS**

Run:
```bash
cd /Users/koushik/Documents/GitHub/sift/core && npm install --silent && npm test
```
Expected: FAIL — cannot resolve `../src/index.js` / `hello` is not exported (file does not exist yet).

- [ ] **Step 7: Create `core/src/index.ts`**

```typescript
export function hello(): string {
  return "sift-core";
}
```

- [ ] **Step 8: Run the test to verify it PASSES**

Run: `cd /Users/koushik/Documents/GitHub/sift/core && npm test`
Expected: PASS (1 passed).

- [ ] **Step 9: Add TS targets to `Makefile`**

```makefile
.PHONY: ts-test ts-typecheck
ts-test:
	cd core && npm test
ts-typecheck:
	cd core && npm run typecheck
```

- [ ] **Step 10: Verify typecheck is clean**

Run: `cd /Users/koushik/Documents/GitHub/sift && make ts-typecheck`
Expected: exit 0, no type errors.

- [ ] **Step 11: Commit**

```bash
git add core/package.json core/package-lock.json core/tsconfig.json core/vitest.config.ts core/.nvmrc core/src/index.ts core/test/smoke.test.ts Makefile
git commit -m "build(core): typescript toolchain (pg, zod, yaml, tsx, vitest)"
```

---

## Task 4: Artifact validators (pydantic + Zod) cross-checked on shared examples

**Files:**
- Create: `pipeline/pipeline/artifacts.py`
- Create: `schemas/examples/parsed-document.example.json`, `schemas/examples/gold-label.example.json`
- Create: `core/src/schemas/parsedDocument.ts`, `core/src/schemas/goldLabel.ts`
- Test: `pipeline/tests/test_artifacts.py`, `core/test/schemas.test.ts`

**Interfaces:**
- Consumes: the JSON Schemas from Task 1.
- Produces:
  - Python: `Span`, `Node`, `ParsedDocument`, `GoldLabel` pydantic models (`pipeline.artifacts`). Tasks 7–10 build and serialize these.
  - TS: `ParsedDocumentSchema` (+ `NodeSchema`, `type ParsedDocument`) and `GoldLabelSchema` (+ `type GoldLabel`). Tasks 10–14 parse with these.
  - Shared example files both sides validate against — the seam is proven consistent here.

- [ ] **Step 1: Create the shared example — `schemas/examples/parsed-document.example.json`**

(`raw_text` is `"ARTICLE I TERM\nThis lasts."` — 26 chars; the node text is the whole document, `char_start=0 char_end=26`. `raw_sha256` is the SHA-256 of `raw_text`, recomputed by the test in Step 3.)

```json
{
  "doc_id": "example_0001",
  "source": "cuad",
  "title": "Example Agreement",
  "contract_type": "unknown",
  "raw_text": "ARTICLE I TERM\nThis lasts.",
  "char_length": 26,
  "raw_sha256": "0eaf4d2d6f7d3a6f4d0a6a3d2c1b0a9e8f7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b",
  "nodes": [
    {
      "node_id": "example_0001/article-i",
      "parent_id": null,
      "type": "article",
      "number": "I",
      "heading": "TERM",
      "text": "ARTICLE I TERM\nThis lasts.",
      "char_start": 0,
      "char_end": 26,
      "depth": 0
    }
  ]
}
```

> Note: `raw_sha256` above is illustrative. In Step 2 the Python test recomputes the real digest and rewrites this field so the example is self-consistent; commit the corrected file.

- [ ] **Step 2: Create the shared example — `schemas/examples/gold-label.example.json`**

```json
{
  "label_id": "example_0001::clause::document-name::0",
  "doc_id": "example_0001",
  "source": "cuad",
  "kind": "clause_span",
  "clause_type": "Document Name",
  "hypothesis": null,
  "nli_label": null,
  "spans": [
    { "char_start": 0, "char_end": 14, "quote": "ARTICLE I TERM" }
  ]
}
```

- [ ] **Step 3: Write the failing test — `pipeline/tests/test_artifacts.py`**

```python
import hashlib
import json
from pathlib import Path

from pipeline.artifacts import GoldLabel, ParsedDocument

EX = Path(__file__).resolve().parents[2] / "schemas" / "examples"

def test_parsed_document_roundtrips_and_is_self_consistent():
    raw = json.loads((EX / "parsed-document.example.json").read_text())
    # Make the committed example self-consistent: digest matches raw_text, len matches.
    raw["raw_sha256"] = hashlib.sha256(raw["raw_text"].encode("utf-8")).hexdigest()
    raw["char_length"] = len(raw["raw_text"])
    (EX / "parsed-document.example.json").write_text(json.dumps(raw, indent=2) + "\n")

    doc = ParsedDocument.model_validate(raw)
    assert doc.raw_sha256 == hashlib.sha256(doc.raw_text.encode("utf-8")).hexdigest()
    assert doc.char_length == len(doc.raw_text)
    # Citation invariant: each node's text equals its slice of raw_text.
    for node in doc.nodes:
        assert doc.raw_text[node.char_start:node.char_end] == node.text

def test_gold_label_roundtrips():
    raw = json.loads((EX / "gold-label.example.json").read_text())
    label = GoldLabel.model_validate(raw)
    assert label.kind == "clause_span"
    assert label.spans[0].quote == "ARTICLE I TERM"
```

- [ ] **Step 4: Run to verify it FAILS**

Run: `cd /Users/koushik/Documents/GitHub/sift/pipeline && ./.venv/bin/python -m pytest tests/test_artifacts.py -q`
Expected: FAIL — `ModuleNotFoundError` / cannot import `pipeline.artifacts`.

- [ ] **Step 5: Create `pipeline/pipeline/artifacts.py`**

```python
"""Pydantic models mirroring schemas/*.json — the canonical artifact types."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict

NodeType = Literal[
    "preamble", "recital", "article", "section",
    "subsection", "definition", "exhibit", "clause",
]
Source = Literal["cuad", "contractnli"]


class Span(BaseModel):
    model_config = ConfigDict(extra="forbid")
    char_start: int
    char_end: int
    quote: str


class Node(BaseModel):
    model_config = ConfigDict(extra="forbid")
    node_id: str
    parent_id: Optional[str] = None
    type: NodeType
    number: Optional[str] = None
    heading: Optional[str] = None
    text: str
    char_start: int
    char_end: int
    depth: int


class ParsedDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")
    doc_id: str
    source: Source
    title: Optional[str] = None
    contract_type: str
    raw_text: str
    char_length: int
    raw_sha256: str
    nodes: list[Node] = []


class GoldLabel(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label_id: str
    doc_id: str
    source: Source
    kind: Literal["clause_span", "nli"]
    clause_type: Optional[str] = None
    hypothesis: Optional[str] = None
    nli_label: Optional[Literal["entailment", "contradiction", "not_mentioned"]] = None
    spans: list[Span] = []
```

- [ ] **Step 6: Run to verify it PASSES**

Run: `cd /Users/koushik/Documents/GitHub/sift/pipeline && ./.venv/bin/python -m pytest tests/test_artifacts.py -q`
Expected: PASS (2 passed). The example file is now rewritten with the correct digest/length — leave it as written.

- [ ] **Step 7: Write the failing TS test — `core/test/schemas.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ParsedDocumentSchema } from "../src/schemas/parsedDocument.js";
import { GoldLabelSchema } from "../src/schemas/goldLabel.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(root + p, "utf-8"));

describe("artifact schemas (TS) match the shared examples", () => {
  it("parses the parsed-document example and enforces the citation invariant", () => {
    const doc = ParsedDocumentSchema.parse(read("schemas/examples/parsed-document.example.json"));
    for (const n of doc.nodes) {
      expect(doc.raw_text.slice(n.char_start, n.char_end)).toBe(n.text);
    }
  });
  it("parses the gold-label example", () => {
    const label = GoldLabelSchema.parse(read("schemas/examples/gold-label.example.json"));
    expect(label.spans[0].quote).toBe("ARTICLE I TERM");
  });
});
```

- [ ] **Step 8: Run to verify it FAILS**

Run: `cd /Users/koushik/Documents/GitHub/sift/core && npm test -- schemas`
Expected: FAIL — cannot resolve `../src/schemas/parsedDocument.js` (files do not exist).

- [ ] **Step 9: Create `core/src/schemas/parsedDocument.ts`**

```typescript
import { z } from "zod";

export const NodeType = z.enum([
  "preamble", "recital", "article", "section",
  "subsection", "definition", "exhibit", "clause",
]);

export const NodeSchema = z.object({
  node_id: z.string().min(1),
  parent_id: z.string().nullable(),
  type: NodeType,
  number: z.string().nullable(),
  heading: z.string().nullable(),
  text: z.string(),
  char_start: z.number().int().nonnegative(),
  char_end: z.number().int().nonnegative(),
  depth: z.number().int().nonnegative(),
}).strict();

export const ParsedDocumentSchema = z.object({
  doc_id: z.string().min(1),
  source: z.enum(["cuad", "contractnli"]),
  title: z.string().nullable(),
  contract_type: z.string(),
  raw_text: z.string(),
  char_length: z.number().int().nonnegative(),
  raw_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  nodes: z.array(NodeSchema),
}).strict();

export type Node = z.infer<typeof NodeSchema>;
export type ParsedDocument = z.infer<typeof ParsedDocumentSchema>;
```

- [ ] **Step 10: Create `core/src/schemas/goldLabel.ts`**

```typescript
import { z } from "zod";

export const SpanSchema = z.object({
  char_start: z.number().int().nonnegative(),
  char_end: z.number().int().nonnegative(),
  quote: z.string(),
}).strict();

export const GoldLabelSchema = z.object({
  label_id: z.string().min(1),
  doc_id: z.string().min(1),
  source: z.enum(["cuad", "contractnli"]),
  kind: z.enum(["clause_span", "nli"]),
  clause_type: z.string().nullable(),
  hypothesis: z.string().nullable(),
  nli_label: z.enum(["entailment", "contradiction", "not_mentioned"]).nullable(),
  spans: z.array(SpanSchema),
}).strict();

export type Span = z.infer<typeof SpanSchema>;
export type GoldLabel = z.infer<typeof GoldLabelSchema>;
```

- [ ] **Step 11: Run to verify it PASSES**

Run: `cd /Users/koushik/Documents/GitHub/sift/core && npm test -- schemas`
Expected: PASS (2 passed).

- [ ] **Step 12: Commit**

```bash
git add pipeline/pipeline/artifacts.py pipeline/tests/test_artifacts.py core/src/schemas/ core/test/schemas.test.ts schemas/examples/
git commit -m "feat: artifact validators (pydantic + zod) cross-checked on shared examples"
```

---

## Task 5: Docker pgvector + DB client + connection smoke

**Files:**
- Create: `docker-compose.yml`
- Create: `core/src/db/client.ts`
- Test: `core/test/db.connect.test.ts`
- Modify: `Makefile` (add db targets)

**Interfaces:**
- Consumes: `DATABASE_URL` from `.env`.
- Produces: `pool` (a `pg.Pool`) and `withClient<T>(fn)` from `core/src/db/client.ts`, used by all later DB tasks; `make db-up` / `make db-down`.

- [ ] **Step 1: Create `docker-compose.yml`**

```yaml
services:
  db:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: sift
      POSTGRES_PASSWORD: sift
      POSTGRES_DB: sift
    ports:
      - "5433:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U sift -d sift"]
      interval: 2s
      timeout: 3s
      retries: 20
    volumes:
      - sift_pgdata:/var/lib/postgresql/data

volumes:
  sift_pgdata:
```

- [ ] **Step 2: Add db targets to `Makefile`**

```makefile
.PHONY: db-up db-down
db-up:
	docker compose up -d db
	@echo "waiting for postgres..."
	@until docker compose exec -T db pg_isready -U sift -d sift >/dev/null 2>&1; do sleep 1; done
	@echo "postgres ready on localhost:5433"
db-down:
	docker compose down
```

- [ ] **Step 3: Start the database**

Run: `cd /Users/koushik/Documents/GitHub/sift && cp -n .env.example .env; make db-up`
Expected: ends with `postgres ready on localhost:5433`.

- [ ] **Step 4: Write the failing test — `core/test/db.connect.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { withClient } from "../src/db/client.js";

describe("db connection", () => {
  it("runs SELECT 1", async () => {
    const value = await withClient(async (c) => (await c.query("SELECT 1 AS v")).rows[0].v);
    expect(value).toBe(1);
  });
});
```

- [ ] **Step 5: Run to verify it FAILS**

Run: `cd /Users/koushik/Documents/GitHub/sift/core && npm test -- db.connect`
Expected: FAIL — cannot resolve `../src/db/client.js`.

- [ ] **Step 6: Create `core/src/db/client.ts`**

```typescript
import { Pool, type PoolClient } from "pg";
import * as dotenv from "dotenv";
import { fileURLToPath } from "node:url";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set (copy .env.example to .env)");
}

export const pool = new Pool({ connectionString });

/** Run `fn` with a pooled client, always releasing it. */
export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
```

- [ ] **Step 7: Run to verify it PASSES**

Run: `cd /Users/koushik/Documents/GitHub/sift/core && npm test -- db.connect`
Expected: PASS (1 passed).

- [ ] **Step 8: Commit**

```bash
git add docker-compose.yml core/src/db/client.ts core/test/db.connect.test.ts Makefile
git commit -m "feat(db): dockerized pgvector + pooled client with connection smoke test"
```

---

## Task 6: Migrations — schema, pgvector extension, cosine smoke

**Files:**
- Create: `core/migrations/0001_extensions.sql`, `core/migrations/0002_documents_clauses.sql`, `core/migrations/0003_embeddings.sql`
- Create: `core/src/db/migrate.ts`
- Test: `core/test/db.schema.test.ts`
- Modify: `Makefile` (add `migrate`)

**Interfaces:**
- Consumes: `withClient` from Task 5.
- Produces: `migrate()` (idempotent, applies pending `.sql` files in order, tracked in `_migrations`); the `documents`, `clauses`, `embeddings` tables. Task 11 loads into `documents`/`clauses`; Task 14 reads `documents.raw_text`.

- [ ] **Step 1: Create `core/migrations/0001_extensions.sql`**

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

- [ ] **Step 2: Create `core/migrations/0002_documents_clauses.sql`**

```sql
CREATE TABLE IF NOT EXISTS documents (
  doc_id        text PRIMARY KEY,
  source        text NOT NULL,
  title         text,
  contract_type text NOT NULL,
  raw_text      text NOT NULL,
  char_length   integer NOT NULL,
  raw_sha256    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clauses (
  node_id    text PRIMARY KEY,
  doc_id     text NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
  parent_id  text,
  type       text NOT NULL,
  number     text,
  heading    text,
  text       text NOT NULL,
  char_start integer NOT NULL,
  char_end   integer NOT NULL,
  depth      integer NOT NULL
);

CREATE INDEX IF NOT EXISTS clauses_doc_idx ON clauses(doc_id);
CREATE INDEX IF NOT EXISTS clauses_parent_idx ON clauses(parent_id);
```

- [ ] **Step 3: Create `core/migrations/0003_embeddings.sql`**

```sql
-- Embedding dimension default = 1024. Embeddings are populated in P1, where the embedder
-- is chosen as a measured experiment; if that model's dimension differs, change it here and
-- add the matching migration. The vector index is also deferred to P1 (added after vectors
-- exist). Phase 0 only needs the table to exist + the extension to work (proven below).
CREATE TABLE IF NOT EXISTS embeddings (
  node_id   text PRIMARY KEY REFERENCES clauses(node_id) ON DELETE CASCADE,
  model     text NOT NULL,
  embedding vector(1024)
);
```

- [ ] **Step 4: Create `core/src/db/migrate.ts`**

```typescript
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withClient } from "./client.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

export async function migrate(): Promise<string[]> {
  const applied: string[] = [];
  await withClient(async (c) => {
    await c.query(
      "CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const name of files) {
      const done = await c.query("SELECT 1 FROM _migrations WHERE name = $1", [name]);
      if (done.rowCount) continue;
      const sql = readFileSync(`${MIGRATIONS_DIR}/${name}`, "utf-8");
      await c.query("BEGIN");
      try {
        await c.query(sql);
        await c.query("INSERT INTO _migrations(name) VALUES ($1)", [name]);
        await c.query("COMMIT");
        applied.push(name);
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
    }
  });
  return applied;
}

// Allow `tsx src/db/migrate.ts` as a CLI.
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().then((a) => {
    console.log(a.length ? `applied: ${a.join(", ")}` : "no pending migrations");
    process.exit(0);
  });
}
```

- [ ] **Step 5: Write the failing test — `core/test/db.schema.test.ts`**

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { withClient } from "../src/db/client.js";

describe("schema + pgvector", () => {
  beforeAll(async () => { await migrate(); });

  it("creates the core tables", async () => {
    const names = await withClient(async (c) =>
      (await c.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public'",
      )).rows.map((r) => r.table_name),
    );
    expect(names).toEqual(expect.arrayContaining(["documents", "clauses", "embeddings"]));
  });

  it("orders by cosine distance (pgvector works)", async () => {
    const nearest = await withClient(async (c) => {
      await c.query("CREATE TEMP TABLE v_smoke (id int, e vector(3)) ON COMMIT DROP");
      await c.query("INSERT INTO v_smoke VALUES (1,'[1,0,0]'), (2,'[0,1,0]'), (3,'[0.9,0.1,0]')");
      const r = await c.query("SELECT id FROM v_smoke ORDER BY e <=> '[1,0,0]' LIMIT 1");
      return r.rows[0].id;
    });
    expect(nearest).toBe(1);
  });
});
```

> Note: the cosine test wraps work in a transaction so `ON COMMIT DROP` cleans up; `withClient` uses one client, and the implicit transaction commits on release — acceptable for the temp table. If your `pg` setup autocommits per statement, replace with `CREATE TEMP TABLE … ON COMMIT PRESERVE ROWS` and `DROP TABLE v_smoke` at the end.

- [ ] **Step 6: Run to verify it FAILS**

Run: `cd /Users/koushik/Documents/GitHub/sift/core && npm test -- db.schema`
Expected: FAIL — cannot resolve `../src/db/migrate.js`.

- [ ] **Step 7: Add `migrate` to `Makefile`**

```makefile
.PHONY: migrate
migrate:
	cd core && npm run migrate
```

- [ ] **Step 8: Run the migration, then run the test to verify it PASSES**

Run: `cd /Users/koushik/Documents/GitHub/sift && make migrate && make ts-test`
Expected: `applied: 0001_extensions.sql, 0002_documents_clauses.sql, 0003_embeddings.sql` then all tests pass.

- [ ] **Step 9: Verify migration is idempotent**

Run: `cd /Users/koushik/Documents/GitHub/sift && make migrate`
Expected: `no pending migrations`.

- [ ] **Step 10: Commit**

```bash
git add core/migrations/ core/src/db/migrate.ts core/test/db.schema.test.ts Makefile
git commit -m "feat(db): migrations for documents/clauses/embeddings + pgvector cosine smoke"
```

---

## Task 7: CUAD ingestion → raw.jsonl + gold.jsonl

**Files:**
- Create: `pipeline/pipeline/ingest/__init__.py`, `pipeline/pipeline/ingest/cuad.py`
- Test: `pipeline/tests/test_cuad.py`

**Interfaces:**
- Consumes: `ParsedDocument`, `GoldLabel`, `Span` from `pipeline.artifacts` (Task 4).
- Produces: `normalize_cuad(records: list[dict]) -> tuple[list[ParsedDocument], list[GoldLabel]]` and `load_cuad_qa(limit: int | None) -> list[dict]` (downloads via HF `datasets`). Tasks 10/15 run these via the CLI.

- [ ] **Step 1: Create `pipeline/pipeline/ingest/__init__.py`** (empty file):

```python
```

- [ ] **Step 2: Write the failing test — `pipeline/tests/test_cuad.py`**

```python
from pipeline.ingest.cuad import normalize_cuad


def _records():
    context = 'This Agreement is dated January 1, 2020. Governing law: State of Delaware.'
    date_at = context.index("January 1, 2020")
    law_at = context.index("State of Delaware")
    return [
        {
            "title": "ACME Mutual NDA",
            "context": context,
            "question": 'Highlight the parts related to "Agreement Date" ...',
            "answers": {"text": ["January 1, 2020"], "answer_start": [date_at]},
        },
        {
            "title": "ACME Mutual NDA",
            "context": context,
            "question": 'Highlight the parts related to "Governing Law" ...',
            "answers": {"text": ["State of Delaware"], "answer_start": [law_at]},
        },
        {  # a question with no answer span -> produces no gold label
            "title": "ACME Mutual NDA",
            "context": context,
            "question": 'Highlight the parts related to "Uncapped Liability" ...',
            "answers": {"text": [], "answer_start": []},
        },
    ]


def test_normalize_groups_by_title_into_one_document():
    docs, _ = normalize_cuad(_records())
    assert len(docs) == 1
    doc = docs[0]
    assert doc.source == "cuad"
    assert doc.contract_type == "unknown"
    assert doc.title == "ACME Mutual NDA"
    assert doc.char_length == len(doc.raw_text)
    assert doc.nodes == []  # parsing happens later


def test_gold_labels_carry_clause_type_and_exact_spans():
    docs, gold = normalize_cuad(_records())
    raw = docs[0].raw_text
    assert len(gold) == 2  # the empty-answer question yields nothing
    by_type = {g.clause_type: g for g in gold}
    assert set(by_type) == {"Agreement Date", "Governing Law"}
    for g in gold:
        assert g.kind == "clause_span"
        sp = g.spans[0]
        # Citation invariant: quote equals the raw_text slice.
        assert raw[sp.char_start:sp.char_end] == sp.quote
```

- [ ] **Step 3: Run to verify it FAILS**

Run: `cd /Users/koushik/Documents/GitHub/sift/pipeline && ./.venv/bin/python -m pytest tests/test_cuad.py -q`
Expected: FAIL — cannot import `pipeline.ingest.cuad`.

- [ ] **Step 4: Create `pipeline/pipeline/ingest/cuad.py`**

```python
"""Normalize CUAD (HF `theatticusproject/cuad-qa`) into ParsedDocument + GoldLabel."""
from __future__ import annotations

import hashlib
import re
from typing import Optional

from pipeline.artifacts import GoldLabel, ParsedDocument, Span

_CLAUSE_TYPE = re.compile(r'related to ["“]([^"”]+)["”]')


def _doc_id(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-") or "untitled"
    return f"cuad_{slug}"


def _clause_type(question: str) -> Optional[str]:
    m = _CLAUSE_TYPE.search(question)
    return m.group(1).strip() if m else None


def normalize_cuad(records: list[dict]) -> tuple[list[ParsedDocument], list[GoldLabel]]:
    docs: dict[str, ParsedDocument] = {}
    gold: list[GoldLabel] = []
    counters: dict[str, int] = {}

    for rec in records:
        title = rec["title"]
        context = rec["context"]
        doc_id = _doc_id(title)
        if doc_id not in docs:
            docs[doc_id] = ParsedDocument(
                doc_id=doc_id,
                source="cuad",
                title=title,
                contract_type="unknown",
                raw_text=context,
                char_length=len(context),
                raw_sha256=hashlib.sha256(context.encode("utf-8")).hexdigest(),
                nodes=[],
            )

        clause_type = _clause_type(rec["question"])
        answers = rec.get("answers", {}) or {}
        texts = answers.get("text", []) or []
        starts = answers.get("answer_start", []) or []
        if not texts or clause_type is None:
            continue

        spans = [Span(char_start=s, char_end=s + len(t), quote=t) for t, s in zip(texts, starts)]
        n = counters.get(doc_id, 0)
        counters[doc_id] = n + 1
        slug = re.sub(r"[^a-z0-9]+", "-", clause_type.lower()).strip("-")
        gold.append(
            GoldLabel(
                label_id=f"{doc_id}::clause::{slug}::{n}",
                doc_id=doc_id,
                source="cuad",
                kind="clause_span",
                clause_type=clause_type,
                spans=spans,
            )
        )

    return list(docs.values()), gold


def load_cuad_qa(limit: Optional[int] = None) -> list[dict]:
    """Download the CUAD-QA validation split from Hugging Face. Network-bound; not unit-tested."""
    from datasets import load_dataset  # imported lazily so tests don't require the network

    ds = load_dataset("theatticusproject/cuad-qa", split="test")
    rows = ds.select(range(limit)) if limit else ds
    return [dict(r) for r in rows]
```

- [ ] **Step 5: Run to verify it PASSES**

Run: `cd /Users/koushik/Documents/GitHub/sift/pipeline && ./.venv/bin/python -m pytest tests/test_cuad.py -q`
Expected: PASS (2 passed).

- [ ] **Step 6: Commit**

```bash
git add pipeline/pipeline/ingest/__init__.py pipeline/pipeline/ingest/cuad.py pipeline/tests/test_cuad.py
git commit -m "feat(ingest): CUAD normalizer -> ParsedDocument + clause-span GoldLabel"
```

---

## Task 8: ContractNLI ingestion → raw.jsonl + gold.jsonl

**Files:**
- Create: `pipeline/pipeline/ingest/contractnli.py`
- Test: `pipeline/tests/test_contractnli.py`

**Interfaces:**
- Consumes: `pipeline.artifacts`.
- Produces: `normalize_contractnli(data: dict) -> tuple[list[ParsedDocument], list[GoldLabel]]` (NLI gold labels with evidence spans) and `load_contractnli(path: str) -> dict` (reads a downloaded JSON file).

- [ ] **Step 1: Write the failing test — `pipeline/tests/test_contractnli.py`**

```python
from pipeline.ingest.contractnli import normalize_contractnli


def _data():
    text = "Confidential Information excludes public data. Term is three years."
    span_a = [0, 45]   # "Confidential Information excludes public data."
    span_b = [46, len(text)]  # "Term is three years."
    return {
        "documents": [
            {
                "id": "nda_1",
                "file_name": "nda_1.pdf",
                "text": text,
                "spans": [span_a, span_b],
                "annotation_sets": [
                    {
                        "annotations": {
                            "nda-1": {"choice": "Entailment", "spans": [0]},
                            "nda-2": {"choice": "NotMentioned", "spans": []},
                        }
                    }
                ],
            }
        ],
        "labels": {
            "nda-1": {"hypothesis": "Some information is excluded from confidentiality."},
            "nda-2": {"hypothesis": "The receiving party may not reverse-engineer."},
        },
    }


def test_one_document_typed_nda():
    docs, _ = normalize_contractnli(_data())
    assert len(docs) == 1
    assert docs[0].source == "contractnli"
    assert docs[0].contract_type == "nda"
    assert docs[0].doc_id == "contractnli_nda_1"


def test_gold_only_for_decided_hypotheses_with_exact_spans():
    docs, gold = normalize_contractnli(_data())
    raw = docs[0].raw_text
    # NotMentioned without evidence is dropped; only the Entailment remains.
    assert len(gold) == 1
    g = gold[0]
    assert g.kind == "nli"
    assert g.nli_label == "entailment"
    assert g.hypothesis.startswith("Some information is excluded")
    sp = g.spans[0]
    assert raw[sp.char_start:sp.char_end] == sp.quote
```

- [ ] **Step 2: Run to verify it FAILS**

Run: `cd /Users/koushik/Documents/GitHub/sift/pipeline && ./.venv/bin/python -m pytest tests/test_contractnli.py -q`
Expected: FAIL — cannot import `pipeline.ingest.contractnli`.

- [ ] **Step 3: Create `pipeline/pipeline/ingest/contractnli.py`**

```python
"""Normalize ContractNLI (stanfordnlp/contract-nli) into ParsedDocument + NLI GoldLabel."""
from __future__ import annotations

import hashlib
import json

from pipeline.artifacts import GoldLabel, ParsedDocument, Span

_CHOICE = {
    "Entailment": "entailment",
    "Contradiction": "contradiction",
    "NotMentioned": "not_mentioned",
}


def normalize_contractnli(data: dict) -> tuple[list[ParsedDocument], list[GoldLabel]]:
    labels_meta = data.get("labels", {})
    docs: list[ParsedDocument] = []
    gold: list[GoldLabel] = []

    for d in data["documents"]:
        text = d["text"]
        doc_id = f"contractnli_{d['id']}"
        docs.append(
            ParsedDocument(
                doc_id=doc_id,
                source="contractnli",
                title=d.get("file_name"),
                contract_type="nda",
                raw_text=text,
                char_length=len(text),
                raw_sha256=hashlib.sha256(text.encode("utf-8")).hexdigest(),
                nodes=[],
            )
        )

        char_spans = d.get("spans", [])
        ann_sets = d.get("annotation_sets", [])
        annotations = ann_sets[0]["annotations"] if ann_sets else {}
        for hkey, ann in annotations.items():
            label = _CHOICE.get(ann["choice"], "not_mentioned")
            evidence_idx = ann.get("spans", []) or []
            # Keep a label only if it carries evidence (a usable grounded span).
            if not evidence_idx:
                continue
            spans = [
                Span(char_start=char_spans[i][0], char_end=char_spans[i][1],
                     quote=text[char_spans[i][0]:char_spans[i][1]])
                for i in evidence_idx
            ]
            gold.append(
                GoldLabel(
                    label_id=f"{doc_id}::nli::{hkey}",
                    doc_id=doc_id,
                    source="contractnli",
                    kind="nli",
                    hypothesis=labels_meta.get(hkey, {}).get("hypothesis"),
                    nli_label=label,
                    spans=spans,
                )
            )

    return docs, gold


def load_contractnli(path: str) -> dict:
    """Load a downloaded ContractNLI split JSON (e.g. data/raw/contractnli/test.json)."""
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)
```

- [ ] **Step 4: Run to verify it PASSES**

Run: `cd /Users/koushik/Documents/GitHub/sift/pipeline && ./.venv/bin/python -m pytest tests/test_contractnli.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add pipeline/pipeline/ingest/contractnli.py pipeline/tests/test_contractnli.py
git commit -m "feat(ingest): ContractNLI normalizer -> nda ParsedDocument + NLI GoldLabel"
```

---

## Task 9: Structure-aware parser core

**Files:**
- Create: `pipeline/pipeline/parser/__init__.py`, `pipeline/pipeline/parser/structure.py`
- Test: `pipeline/tests/test_structure.py`

**Interfaces:**
- Consumes: `Node` from `pipeline.artifacts`.
- Produces: `parse_structure(doc_id: str, text: str) -> list[Node]` — detects articles, sections (dotted numbering), parenthetical subsections, definitions, and exhibits; nests them with `parent_id`/`depth`; every node satisfies `text == raw_text[char_start:char_end]`. Task 10 calls this per document.

- [ ] **Step 1: Create `pipeline/pipeline/parser/__init__.py`** (empty file):

```python
```

- [ ] **Step 2: Write the failing test — `pipeline/tests/test_structure.py`**

```python
from pipeline.parser.structure import parse_structure

TEXT = (
    "ARTICLE I DEFINITIONS\n"                              # article I
    '"Confidential Information" means non-public data.\n'  # definition
    "Section 1.1 Purpose\n"                                # section 1.1
    "The parties wish to exchange information.\n"
    "Section 1.2 Obligations\n"                            # section 1.2
    "(a) The Receiving Party shall protect it.\n"          # subsection (a)
    "(b) The Receiving Party shall not disclose it.\n"     # subsection (b)
    "ARTICLE II TERM\n"                                    # article II
    "This Agreement lasts three years.\n"
    "EXHIBIT A FORM OF NOTICE\n"                           # exhibit A
    "Notice template here.\n"
)


def _by(nodes, typ):
    return [n for n in nodes if n.type == typ]


def test_offsets_are_exact_for_every_node():
    nodes = parse_structure("doc1", TEXT)
    for n in nodes:
        assert TEXT[n.char_start:n.char_end] == n.text


def test_articles_sections_subsections_definitions_exhibits_detected():
    nodes = parse_structure("doc1", TEXT)
    assert {n.number for n in _by(nodes, "article")} == {"I", "II"}
    assert {n.number for n in _by(nodes, "section")} == {"1.1", "1.2"}
    assert {n.number for n in _by(nodes, "subsection")} == {"(a)", "(b)"}
    assert {n.heading for n in _by(nodes, "definition")} == {"Confidential Information"}
    assert {n.number for n in _by(nodes, "exhibit")} == {"A"}


def test_hierarchy_parents_are_correct():
    nodes = parse_structure("doc1", TEXT)
    by_id = {n.node_id: n for n in nodes}
    art1 = next(n for n in nodes if n.type == "article" and n.number == "I")
    sec12 = next(n for n in nodes if n.number == "1.2")
    sub_a = next(n for n in nodes if n.number == "(a)")
    assert by_id[sec12.parent_id] is art1            # 1.2 sits under Article I
    assert by_id[sub_a.parent_id] is sec12           # (a) sits under 1.2
    assert sub_a.depth == sec12.depth + 1
```

- [ ] **Step 3: Run to verify it FAILS**

Run: `cd /Users/koushik/Documents/GitHub/sift/pipeline && ./.venv/bin/python -m pytest tests/test_structure.py -q`
Expected: FAIL — cannot import `pipeline.parser.structure`.

- [ ] **Step 4: Create `pipeline/pipeline/parser/structure.py`**

```python
"""Heuristic structure-aware parser: contract text -> hierarchy of Nodes.

Detects ARTICLE / Section N.M / (a) subsections / "Term" means definitions / EXHIBIT.
Each structural node spans from its heading line to the next heading of the same-or-higher
level, so a parent's text contains its children's text. Definitions are inline leaves.
Every node satisfies: text == source[char_start:char_end].
"""
from __future__ import annotations

import re

from pipeline.artifacts import Node

_ROMAN = r"[IVXLCDM]+"
_ARTICLE = re.compile(rf"^[ \t]*ARTICLE\s+({_ROMAN}|\d+)\b[.:\-]?[ \t]*(.*)$")
_EXHIBIT = re.compile(r"^[ \t]*(?:EXHIBIT|SCHEDULE|ANNEX|APPENDIX)\s+([A-Z0-9]+)\b[.:\-]?[ \t]*(.*)$")
_SECTION_KW = re.compile(r"^[ \t]*Section\s+(\d+(?:\.\d+)*)\b[.:\-]?[ \t]*(.*)$")
_SECTION_NUM = re.compile(r"^[ \t]*(\d+(?:\.\d+)+)[.)]?\s+(\S.*)$")
_SECTION_TOP = re.compile(r"^[ \t]*(\d+)\.\s+(\S.*)$")
_SUBSEC = re.compile(r"^[ \t]*\(([a-z]{1,3}|[ivxlc]+)\)\s+(\S.*)$")
_DEFINITION = re.compile(r"[\"“]([^\"”]{1,80})[\"”]\s+means\b", re.IGNORECASE)


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")


def _classify(line: str):
    """Return (type, level_or_None, number, heading) for a heading line, else None."""
    m = _ARTICLE.match(line)
    if m:
        return ("article", 0, m.group(1), m.group(2).strip())
    m = _EXHIBIT.match(line)
    if m:
        return ("exhibit", 0, m.group(1), m.group(2).strip())
    m = _SECTION_KW.match(line)
    if m:
        return ("section", m.group(1).count(".") + 1, m.group(1), m.group(2).strip())
    m = _SECTION_NUM.match(line)
    if m:
        return ("section", m.group(1).count(".") + 1, m.group(1), m.group(2).strip())
    m = _SECTION_TOP.match(line)
    if m:
        return ("section", 1, m.group(1), m.group(2).strip())
    m = _SUBSEC.match(line)
    if m:
        return ("subsection", None, f"({m.group(1)})", m.group(2).strip())
    return None


def parse_structure(doc_id: str, text: str) -> list[Node]:
    # 1) Collect heading lines with their char offsets and resolved levels.
    heads: list[dict] = []
    offset = 0
    last_section_level = 0
    for raw_line in text.splitlines(keepends=True):
        c = _classify(raw_line)
        if c:
            typ, level, number, heading = c
            if typ == "subsection":
                level = last_section_level + 1
            else:
                last_section_level = level
            heads.append({"start": offset, "type": typ, "level": level,
                          "number": number, "heading": heading})
        offset += len(raw_line)

    # 2) Segment + nest structural headings with a level-stack.
    nodes: list[Node] = []
    stack: list[tuple[int, str]] = []  # (level, node_id)
    used: dict[str, int] = {}
    n = len(heads)
    for i, h in enumerate(heads):
        end = len(text)
        for j in range(i + 1, n):
            if heads[j]["level"] <= h["level"]:
                end = heads[j]["start"]
                break
        while stack and stack[-1][0] >= h["level"]:
            stack.pop()
        parent_id = stack[-1][1] if stack else None
        depth = len(stack)
        base = f"{doc_id}/{h['type']}-{_slug(h['number'] or h['heading'] or str(i))}"
        k = used.get(base, 0)
        used[base] = k + 1
        node_id = base if k == 0 else f"{base}-{k}"
        nodes.append(Node(
            node_id=node_id, parent_id=parent_id, type=h["type"],
            number=h["number"], heading=h["heading"] or None,
            text=text[h["start"]:end], char_start=h["start"], char_end=end, depth=depth,
        ))
        stack.append((h["level"], node_id))

    # 3) Definitions: inline leaves attached to the deepest containing structural node.
    for dm in _DEFINITION.finditer(text):
        ds, de = dm.start(), dm.end()
        dot = text.find(".", de)
        dend = dot + 1 if dot != -1 else de
        container = None
        for node in nodes:
            if node.char_start <= ds < node.char_end and (
                container is None or node.depth >= container.depth
            ):
                container = node
        term = dm.group(1)
        nodes.append(Node(
            node_id=f"{doc_id}/definition-{_slug(term)}",
            parent_id=container.node_id if container else None,
            type="definition", number=None, heading=term,
            text=text[ds:dend], char_start=ds, char_end=dend,
            depth=(container.depth + 1 if container else 0),
        ))

    nodes.sort(key=lambda x: (x.char_start, x.depth))
    return nodes
```

- [ ] **Step 5: Run to verify it PASSES**

Run: `cd /Users/koushik/Documents/GitHub/sift/pipeline && ./.venv/bin/python -m pytest tests/test_structure.py -q`
Expected: PASS (3 passed).

- [ ] **Step 6: Commit**

```bash
git add pipeline/pipeline/parser/__init__.py pipeline/pipeline/parser/structure.py pipeline/tests/test_structure.py
git commit -m "feat(parser): structure-aware hierarchy parser (articles/sections/subsections/defs/exhibits)"
```

---

## Task 10: Parse driver + 10-contract hierarchy gate

**Files:**
- Create: `pipeline/pipeline/parse_docs.py`
- Create: `pipeline/fixtures/contracts/` (10 `*.txt` sample contracts)
- Create: `pipeline/fixtures/expected_hierarchy.json` (generated snapshot, then hand-verified)
- Test: `pipeline/tests/test_parse_gate.py`

**Interfaces:**
- Consumes: `parse_structure` (Task 9), `ParsedDocument` (Task 4).
- Produces: `parse_raw_file(in_path, out_path) -> int` (reads `raw.jsonl`, writes `docs.jsonl` with nodes, returns doc count); the `make parse` corpus step.

- [ ] **Step 1: Assemble 10 sample contracts into `pipeline/fixtures/contracts/`**

Select 10 real contracts spanning both sources and copy each document's `raw_text` to its own `.txt` file named `<doc_id>.txt` (e.g. `pipeline/fixtures/contracts/contractnli_nda_17.txt`). Sourcing options:
  - From ContractNLI: run `make ingest` (Task 15 wires the CLI; or call `normalize_contractnli(load_contractnli("data/raw/contractnli/test.json"))` in a Python REPL) and write 7 NDA documents' `raw_text` to files.
  - From CUAD: write 3 documents' `raw_text` similarly.
Pick documents that actually contain numbered structure (skip ones that are pure prose) so the hierarchy gate is meaningful. Aim for a mix that includes `ARTICLE`/`Section` numbering and at least one with `(a)/(b)` subsections.

- [ ] **Step 2: Create `pipeline/pipeline/parse_docs.py`**

```python
"""Parse driver: raw.jsonl (no nodes) -> docs.jsonl (with hierarchy nodes)."""
from __future__ import annotations

import json
from pathlib import Path

from pipeline.artifacts import ParsedDocument
from pipeline.parser.structure import parse_structure


def parse_document(doc: ParsedDocument) -> ParsedDocument:
    return doc.model_copy(update={"nodes": parse_structure(doc.doc_id, doc.raw_text)})


def parse_raw_file(in_path: str | Path, out_path: str | Path) -> int:
    count = 0
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    with open(in_path, encoding="utf-8") as fin, open(out_path, "w", encoding="utf-8") as fout:
        for line in fin:
            line = line.strip()
            if not line:
                continue
            doc = parse_document(ParsedDocument.model_validate_json(line))
            fout.write(doc.model_dump_json() + "\n")
            count += 1
    return count
```

- [ ] **Step 3: Write the failing test — `pipeline/tests/test_parse_gate.py`**

This test enforces structural **invariants** on all 10 fixtures (these must always hold) and asserts a **snapshot** of per-contract node counts (regression guard once hand-verified).

```python
import json
from pathlib import Path

from pipeline.artifacts import ParsedDocument
from pipeline.parser.structure import parse_structure

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
CONTRACTS = sorted((FIXTURES / "contracts").glob("*.txt"))


def _parse(path: Path):
    text = path.read_text(encoding="utf-8")
    return text, parse_structure(path.stem, text)


def test_we_have_ten_sample_contracts():
    assert len(CONTRACTS) == 10


def test_invariants_hold_on_every_contract():
    for path in CONTRACTS:
        text, nodes = _parse(path)
        assert nodes, f"{path.name}: parser found no structure"
        ids = {n.node_id for n in nodes}
        for n in nodes:
            # Citation invariant.
            assert text[n.char_start:n.char_end] == n.text, f"{path.name}:{n.node_id} offset drift"
            # Every parent reference resolves.
            assert n.parent_id is None or n.parent_id in ids, f"{path.name}:{n.node_id} dangling parent"
            # Depth is consistent with the parent chain.
            if n.parent_id is None:
                assert n.depth == 0
        # Each ParsedDocument validates against the schema after parsing.
        ParsedDocument(
            doc_id=path.stem, source="cuad", contract_type="unknown",
            raw_text=text, char_length=len(text),
            raw_sha256="0" * 64, nodes=nodes,
        )


def test_node_count_snapshot():
    snapshot = json.loads((FIXTURES / "expected_hierarchy.json").read_text())
    actual = {p.stem: len(_parse(p)[1]) for p in CONTRACTS}
    assert actual == snapshot
```

- [ ] **Step 4: Run to verify it FAILS**

Run: `cd /Users/koushik/Documents/GitHub/sift/pipeline && ./.venv/bin/python -m pytest tests/test_parse_gate.py -q`
Expected: FAIL — `expected_hierarchy.json` does not exist (and/or fixtures missing).

- [ ] **Step 5: Generate the snapshot, then hand-verify it**

Run:
```bash
cd /Users/koushik/Documents/GitHub/sift/pipeline && ./.venv/bin/python -c "
import json, glob, os
from pipeline.parser.structure import parse_structure
snap = {}
for p in sorted(glob.glob('fixtures/contracts/*.txt')):
    stem = os.path.splitext(os.path.basename(p))[0]
    text = open(p, encoding='utf-8').read()
    snap[stem] = len(parse_structure(stem, text))
json.dump(snap, open('fixtures/expected_hierarchy.json','w'), indent=2, sort_keys=True)
print(json.dumps(snap, indent=2, sort_keys=True))
"
```
Then **manually verify hierarchy on all 10**: for at least 3 contracts, open the `.txt`, print the parsed tree, and confirm by eye that articles/sections/subsections nest sensibly:
```bash
cd /Users/koushik/Documents/GitHub/sift/pipeline && ./.venv/bin/python -c "
from pipeline.parser.structure import parse_structure
text = open('fixtures/contracts/<DOC_ID>.txt', encoding='utf-8').read()
for n in parse_structure('<DOC_ID>', text):
    print('  '*n.depth + f'[{n.type}] {n.number or n.heading!r}')
"
```
If a contract parses to obvious nonsense (e.g. everything flat, or a body line misread as a heading), refine the regexes in `structure.py` (Task 9) and re-run its unit tests before regenerating the snapshot. The snapshot is only trustworthy once the eyeball check passes — record in the P0 report (Task 15) which contracts you verified.

- [ ] **Step 6: Run to verify it PASSES**

Run: `cd /Users/koushik/Documents/GitHub/sift/pipeline && ./.venv/bin/python -m pytest tests/test_parse_gate.py -q`
Expected: PASS (3 passed).

- [ ] **Step 7: Commit**

```bash
git add pipeline/pipeline/parse_docs.py pipeline/fixtures/ pipeline/tests/test_parse_gate.py
git commit -m "feat(parser): parse driver + 10-contract hierarchy gate (invariants + snapshot)"
```

---

## Task 11: TS loader — docs.jsonl → pgvector (corpus loaded)

**Files:**
- Create: `core/src/load/loadDocs.ts`, `core/src/load/cli.ts`
- Test: `core/test/load.test.ts`
- Modify: `Makefile` (add `load`)

**Interfaces:**
- Consumes: `ParsedDocumentSchema` (Task 4), `withClient` (Task 5), the `documents`/`clauses` tables (Task 6).
- Produces: `assertOffsetIntegrity(doc)` (throws on `quote !== slice`); `loadDocsFile(path) -> {documents, clauses}` (idempotent upsert, returns counts). Task 15 runs it via `make load`.

- [ ] **Step 1: Write the failing test — `core/test/load.test.ts`**

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/db/migrate.js";
import { withClient } from "../src/db/client.js";
import { loadDocsFile, assertOffsetIntegrity } from "../src/load/loadDocs.js";

const raw = "ARTICLE I TERM\nThis lasts.";
const goodDoc = {
  doc_id: "loadtest_1", source: "cuad", title: "T", contract_type: "unknown",
  raw_text: raw, char_length: raw.length,
  raw_sha256: "a".repeat(64),
  nodes: [{
    node_id: "loadtest_1/article-i", parent_id: null, type: "article",
    number: "I", heading: "TERM", text: raw, char_start: 0, char_end: raw.length, depth: 0,
  }],
};

function writeJsonl(docs: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "sift-load-"));
  const p = join(dir, "docs.jsonl");
  writeFileSync(p, docs.map((d) => JSON.stringify(d)).join("\n") + "\n");
  return p;
}

describe("loader", () => {
  beforeAll(async () => {
    await migrate();
    await withClient((c) => c.query("DELETE FROM documents WHERE doc_id LIKE 'loadtest_%'"));
  });

  it("rejects a node whose quote does not match its slice", () => {
    const bad = structuredClone(goodDoc);
    bad.nodes[0].text = "WRONG";
    expect(() => assertOffsetIntegrity(bad as never)).toThrow(/offset integrity/i);
  });

  it("loads documents + clauses and is idempotent", async () => {
    const p = writeJsonl([goodDoc]);
    const first = await loadDocsFile(p);
    expect(first).toEqual({ documents: 1, clauses: 1 });
    await loadDocsFile(p); // second run must not duplicate
    const counts = await withClient(async (c) => ({
      d: Number((await c.query("SELECT count(*) FROM documents WHERE doc_id='loadtest_1'")).rows[0].count),
      n: Number((await c.query("SELECT count(*) FROM clauses WHERE doc_id='loadtest_1'")).rows[0].count),
    }));
    expect(counts).toEqual({ d: 1, n: 1 });
  });
});
```

- [ ] **Step 2: Run to verify it FAILS**

Run: `cd /Users/koushik/Documents/GitHub/sift/core && npm test -- load`
Expected: FAIL — cannot resolve `../src/load/loadDocs.js`.

- [ ] **Step 3: Create `core/src/load/loadDocs.ts`**

```typescript
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { ParsedDocumentSchema, type ParsedDocument } from "../schemas/parsedDocument.js";
import { withClient } from "../db/client.js";

/** Throw unless every node's text equals its slice of raw_text (the citation invariant). */
export function assertOffsetIntegrity(doc: ParsedDocument): void {
  for (const n of doc.nodes) {
    if (doc.raw_text.slice(n.char_start, n.char_end) !== n.text) {
      throw new Error(`offset integrity violation in ${doc.doc_id} node ${n.node_id}`);
    }
  }
}

export async function loadDocsFile(path: string): Promise<{ documents: number; clauses: number }> {
  let documents = 0;
  let clauses = 0;
  const rl = createInterface({ input: createReadStream(path, "utf-8"), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const doc = ParsedDocumentSchema.parse(JSON.parse(trimmed));
    assertOffsetIntegrity(doc);
    await withClient(async (c) => {
      await c.query("BEGIN");
      try {
        await c.query(
          `INSERT INTO documents (doc_id, source, title, contract_type, raw_text, char_length, raw_sha256)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (doc_id) DO UPDATE SET
             source=EXCLUDED.source, title=EXCLUDED.title, contract_type=EXCLUDED.contract_type,
             raw_text=EXCLUDED.raw_text, char_length=EXCLUDED.char_length, raw_sha256=EXCLUDED.raw_sha256`,
          [doc.doc_id, doc.source, doc.title, doc.contract_type, doc.raw_text, doc.char_length, doc.raw_sha256],
        );
        // Replace this doc's clauses so re-loads stay idempotent.
        await c.query("DELETE FROM clauses WHERE doc_id=$1", [doc.doc_id]);
        for (const n of doc.nodes) {
          await c.query(
            `INSERT INTO clauses (node_id, doc_id, parent_id, type, number, heading, text, char_start, char_end, depth)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [n.node_id, doc.doc_id, n.parent_id, n.type, n.number, n.heading, n.text, n.char_start, n.char_end, n.depth],
          );
          clauses += 1;
        }
        await c.query("COMMIT");
        documents += 1;
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
    });
  }
  return { documents, clauses };
}
```

- [ ] **Step 4: Create `core/src/load/cli.ts`**

```typescript
import { loadDocsFile } from "./loadDocs.js";

const sources = ["cuad", "contractnli"];
const root = new URL("../../../", import.meta.url).pathname;

const counts = { documents: 0, clauses: 0 };
for (const s of sources) {
  const path = `${root}data/processed/${s}/docs.jsonl`;
  try {
    const r = await loadDocsFile(path);
    counts.documents += r.documents;
    counts.clauses += r.clauses;
    console.log(`loaded ${s}: ${r.documents} docs, ${r.clauses} clauses`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      console.warn(`skip ${s}: ${path} not found (run make ingest && make parse first)`);
    } else {
      throw e;
    }
  }
}
console.log(`total: ${counts.documents} docs, ${counts.clauses} clauses`);
process.exit(0);
```

- [ ] **Step 5: Run to verify it PASSES**

Run: `cd /Users/koushik/Documents/GitHub/sift/core && npm test -- load`
Expected: PASS (2 passed).

- [ ] **Step 6: Add `load` to `Makefile`**

```makefile
.PHONY: load
load:
	cd core && npm run load
```

- [ ] **Step 7: Commit**

```bash
git add core/src/load/ core/test/load.test.ts Makefile
git commit -m "feat(load): idempotent docs.jsonl -> pgvector loader with offset-integrity guard"
```

---

## Task 12: NDA playbook

**Files:**
- Create: `evals/playbook/nda.yaml`
- Create: `core/src/eval/playbook.ts`
- Test: `core/test/playbook.test.ts`

**Interfaces:**
- Produces: `PlaybookSchema`, `type PlaybookEntry`, `loadPlaybook(path) -> PlaybookEntry[]`, and `playbookIds(entries) -> Set<string>`. Tasks 13–14 reference `playbook_id`s from here in `expected_flags`.

- [ ] **Step 1: Create `evals/playbook/nda.yaml`** (standard positions, fallbacks, red-flags for the NDA wedge)

```yaml
# NDA review playbook. Each entry is a position the system checks a clause against.
# playbook_id is referenced by eval items' expected_flags. Severity = risk if violated.
- playbook_id: confidentiality_term
  clause_type: Term / Duration of Confidentiality
  standard_position: Confidentiality obligations last 3-5 years from disclosure.
  fallback: Up to 7 years for highly sensitive technical information.
  red_flags:
    - Perpetual or indefinite confidentiality term.
    - Term under 1 year.
  severity: high

- playbook_id: mutuality
  clause_type: Mutual vs One-Sided
  standard_position: Obligations are mutual (both parties bound) when both disclose.
  fallback: One-sided acceptable only if our party is solely the receiving party.
  red_flags:
    - One-sided obligations binding only our client while the counterparty is unbound.
  severity: medium

- playbook_id: definition_scope
  clause_type: Definition of Confidential Information
  standard_position: Confidential Information is marked or reasonably identified as confidential.
  fallback: Catch-all permitted if paired with standard exclusions.
  red_flags:
    - All information deemed confidential with no marking requirement and no exclusions.
  severity: medium

- playbook_id: exclusions
  clause_type: Standard Exclusions
  standard_position: Excludes public, already-known, independently-developed, and third-party info.
  fallback: At least the public-domain and independently-developed exclusions present.
  red_flags:
    - No exclusions from the confidentiality definition.
  severity: high

- playbook_id: return_of_materials
  clause_type: Return or Destruction
  standard_position: On request or termination, materials are returned or destroyed.
  fallback: Destruction-only with written certification.
  red_flags:
    - No return or destruction obligation.
  severity: low

- playbook_id: governing_law
  clause_type: Governing Law
  standard_position: A named, neutral US jurisdiction (e.g. Delaware, New York).
  fallback: Counterparty's home US state.
  red_flags:
    - Foreign governing law inconsistent with the parties.
    - Governing law unspecified.
  severity: low

- playbook_id: remedies
  clause_type: Remedies / Injunctive Relief
  standard_position: Injunctive relief available; does not waive damages.
  fallback: Injunctive relief without an automatic fee-shifting clause.
  red_flags:
    - Liquidated-damages or penalty clause for disclosure.
  severity: medium
```

- [ ] **Step 2: Write the failing test — `core/test/playbook.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { loadPlaybook, playbookIds } from "../src/eval/playbook.js";

const path = fileURLToPath(new URL("../../evals/playbook/nda.yaml", import.meta.url));

describe("nda playbook", () => {
  it("loads and validates every entry", () => {
    const entries = loadPlaybook(path);
    expect(entries.length).toBeGreaterThanOrEqual(7);
    for (const e of entries) {
      expect(e.red_flags.length).toBeGreaterThan(0);
      expect(["low", "medium", "high"]).toContain(e.severity);
    }
  });

  it("exposes unique playbook ids including the key NDA positions", () => {
    const ids = playbookIds(loadPlaybook(path));
    expect(ids.has("confidentiality_term")).toBe(true);
    expect(ids.has("exclusions")).toBe(true);
    expect(ids.size).toBe(loadPlaybook(path).length); // ids are unique
  });
});
```

- [ ] **Step 3: Run to verify it FAILS**

Run: `cd /Users/koushik/Documents/GitHub/sift/core && npm test -- playbook`
Expected: FAIL — cannot resolve `../src/eval/playbook.js`.

- [ ] **Step 4: Create `core/src/eval/playbook.ts`**

```typescript
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

export const PlaybookEntrySchema = z.object({
  playbook_id: z.string().min(1),
  clause_type: z.string().min(1),
  standard_position: z.string().min(1),
  fallback: z.string(),
  red_flags: z.array(z.string()).min(1),
  severity: z.enum(["low", "medium", "high"]),
}).strict();

export type PlaybookEntry = z.infer<typeof PlaybookEntrySchema>;

export function loadPlaybook(path: string): PlaybookEntry[] {
  const raw = parse(readFileSync(path, "utf-8"));
  const entries = z.array(PlaybookEntrySchema).parse(raw);
  const ids = new Set<string>();
  for (const e of entries) {
    if (ids.has(e.playbook_id)) throw new Error(`duplicate playbook_id: ${e.playbook_id}`);
    ids.add(e.playbook_id);
  }
  return entries;
}

export function playbookIds(entries: PlaybookEntry[]): Set<string> {
  return new Set(entries.map((e) => e.playbook_id));
}
```

- [ ] **Step 5: Run to verify it PASSES**

Run: `cd /Users/koushik/Documents/GitHub/sift/core && npm test -- playbook`
Expected: PASS (2 passed).

- [ ] **Step 6: Commit**

```bash
git add evals/playbook/nda.yaml core/src/eval/playbook.ts core/test/playbook.test.ts
git commit -m "feat(eval): NDA playbook (standard positions, fallbacks, red-flags) + loader"
```

---

## Task 13: Eval item schema + candidate derivation

**Files:**
- Create: `core/src/eval/evalItem.ts`, `core/src/eval/derive.ts`
- Test: `core/test/derive.test.ts`

**Interfaces:**
- Consumes: `GoldLabelSchema` (Task 4), `PlaybookEntry` / `playbookIds` (Task 12).
- Produces: `EvalItemSchema`, `type EvalItem`; `deriveCandidates(golds, playbook) -> EvalItem[]` — turns CUAD clause spans into `span_match` items and ContractNLI NLI labels into `flag_match`/`span_match` items, mapping clause types to playbook ids where known. Task 14 curates these into the final 50.

- [ ] **Step 1: Create `core/src/eval/evalItem.ts`**

```typescript
import { z } from "zod";

export const EvalItemSchema = z.object({
  id: z.string().min(1),
  doc_id: z.string().min(1),
  source: z.enum(["cuad", "contractnli"]),
  contract_type: z.string(),
  category: z.enum(["clean", "deviated", "missing"]),
  objective: z.string().min(1),
  expected_fields: z.array(z.object({ name: z.string(), value: z.string().nullable() }).strict()),
  expected_flags: z.array(z.object({
    playbook_id: z.string(), severity: z.enum(["low", "medium", "high"]),
  }).strict()),
  gold_spans: z.array(z.object({
    doc_id: z.string(), char_start: z.number().int().nonnegative(),
    char_end: z.number().int().nonnegative(), quote: z.string(),
  }).strict()),
  grader: z.enum(["span_match", "field_match", "flag_match", "refusal"]),
  notes: z.string(),
}).strict();

export type EvalItem = z.infer<typeof EvalItemSchema>;
```

- [ ] **Step 2: Write the failing test — `core/test/derive.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { deriveCandidates, CLAUSE_TYPE_TO_PLAYBOOK } from "../src/eval/derive.js";
import type { GoldLabel } from "../src/schemas/goldLabel.js";

const cuadGold: GoldLabel = {
  label_id: "cuad_x::clause::governing-law::0", doc_id: "cuad_x", source: "cuad",
  kind: "clause_span", clause_type: "Governing Law", hypothesis: null, nli_label: null,
  spans: [{ char_start: 10, char_end: 27, quote: "State of Delaware" }],
};
const nliGold: GoldLabel = {
  label_id: "contractnli_y::nli::nda-11", doc_id: "contractnli_y", source: "contractnli",
  kind: "nli", clause_type: null,
  hypothesis: "Confidentiality survives in perpetuity.", nli_label: "entailment",
  spans: [{ char_start: 0, char_end: 20, quote: "Term is perpetual..." }],
};

describe("deriveCandidates", () => {
  it("turns a CUAD clause span into a span_match item carrying its gold span", () => {
    const items = deriveCandidates([cuadGold], new Set(Object.values(CLAUSE_TYPE_TO_PLAYBOOK)));
    expect(items).toHaveLength(1);
    const it0 = items[0];
    expect(it0.grader).toBe("span_match");
    expect(it0.source).toBe("cuad");
    expect(it0.gold_spans[0].quote).toBe("State of Delaware");
    // Governing Law maps to the governing_law playbook id.
    expect(it0.expected_flags.map((f) => f.playbook_id)).toContain("governing_law");
  });

  it("turns an NLI entailment into a flag_match item", () => {
    const items = deriveCandidates([nliGold], new Set());
    expect(items).toHaveLength(1);
    expect(items[0].grader).toBe("flag_match");
    expect(items[0].source).toBe("contractnli");
    expect(items[0].objective).toContain("perpetuity");
  });

  it("emits unique, schema-valid ids", () => {
    const items = deriveCandidates([cuadGold, nliGold], new Set());
    const ids = new Set(items.map((i) => i.id));
    expect(ids.size).toBe(items.length);
  });
});
```

- [ ] **Step 3: Run to verify it FAILS**

Run: `cd /Users/koushik/Documents/GitHub/sift/core && npm test -- derive`
Expected: FAIL — cannot resolve `../src/eval/derive.js`.

- [ ] **Step 4: Create `core/src/eval/derive.ts`**

```typescript
import type { GoldLabel } from "../schemas/goldLabel.js";
import { EvalItemSchema, type EvalItem } from "./evalItem.js";

/** Best-effort map from CUAD clause-type strings to NDA playbook ids. */
export const CLAUSE_TYPE_TO_PLAYBOOK: Record<string, string> = {
  "Governing Law": "governing_law",
  "Expiration Date": "confidentiality_term",
  "Post-Termination Services": "return_of_materials",
};

const SEVERITY_DEFAULT = "medium" as const;

export function deriveCandidates(golds: GoldLabel[], playbookIds: Set<string>): EvalItem[] {
  const items: EvalItem[] = [];
  golds.forEach((g, i) => {
    const gold_spans = g.spans.map((s) => ({
      doc_id: g.doc_id, char_start: s.char_start, char_end: s.char_end, quote: s.quote,
    }));

    if (g.kind === "clause_span") {
      const pid = g.clause_type ? CLAUSE_TYPE_TO_PLAYBOOK[g.clause_type] : undefined;
      const expected_flags = pid && playbookIds.has(pid)
        ? [{ playbook_id: pid, severity: SEVERITY_DEFAULT }]
        : [];
      items.push(EvalItemSchema.parse({
        id: `cand_${i}_${g.label_id}`,
        doc_id: g.doc_id, source: g.source, contract_type: "unknown",
        category: "clean",
        objective: `Locate and extract the "${g.clause_type ?? "clause"}" clause.`,
        expected_fields: [{ name: g.clause_type ?? "clause", value: null }],
        expected_flags,
        gold_spans,
        grader: "span_match",
        notes: "auto-derived from CUAD; curate before inclusion in v1",
      }));
      return;
    }

    // NLI label -> risk-flag item. Contradiction/entailment of a risky hypothesis => deviated.
    items.push(EvalItemSchema.parse({
      id: `cand_${i}_${g.label_id}`,
      doc_id: g.doc_id, source: g.source, contract_type: "nda",
      category: g.nli_label === "not_mentioned" ? "missing" : "deviated",
      objective: `Assess the hypothesis: ${g.hypothesis ?? "(none)"}`,
      expected_fields: [],
      expected_flags: [],
      gold_spans,
      grader: "flag_match",
      notes: `auto-derived from ContractNLI (${g.nli_label}); curate before inclusion in v1`,
    }));
  });
  return items;
}
```

- [ ] **Step 5: Run to verify it PASSES**

Run: `cd /Users/koushik/Documents/GitHub/sift/core && npm test -- derive`
Expected: PASS (3 passed).

- [ ] **Step 6: Commit**

```bash
git add core/src/eval/evalItem.ts core/src/eval/derive.ts core/test/derive.test.ts
git commit -m "feat(eval): EvalItem schema + candidate derivation from CUAD/ContractNLI gold"
```

---

## Task 14: Eval curation + validation (50-item gate)

**Files:**
- Create: `core/src/eval/validate.ts`, `core/src/eval/cli.ts`
- Create: `evals/data/eval-set-v1.json` (the curated 50)
- Test: `core/test/validate.test.ts`

**Interfaces:**
- Consumes: `EvalItemSchema` (Task 13), `withClient` + the loaded `documents` table (Tasks 5, 11), `deriveCandidates` (Task 13).
- Produces: `validateEvalSet(items, opts) -> {ok, errors, stats}` (schema-valid; each gold span resolves to its quote against the **loaded corpus**; ≥50 items; clean/deviated/missing all present; ≥1 `refusal` item); the `make eval-validate` gate. Task 15 calls it.

- [ ] **Step 1: Write the failing test — `core/test/validate.test.ts`**

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { withClient } from "../src/db/client.js";
import { validateEvalSet } from "../src/eval/validate.js";
import type { EvalItem } from "../src/eval/evalItem.js";

const raw = "Governing law: State of Delaware. Term is perpetual.";

function item(over: Partial<EvalItem>): EvalItem {
  return {
    id: "i1", doc_id: "evaltest_1", source: "cuad", contract_type: "unknown",
    category: "clean", objective: "x", expected_fields: [], expected_flags: [],
    gold_spans: [], grader: "span_match", notes: "", ...over,
  };
}

describe("validateEvalSet", () => {
  beforeAll(async () => {
    await migrate();
    await withClient(async (c) => {
      await c.query("DELETE FROM documents WHERE doc_id='evaltest_1'");
      await c.query(
        `INSERT INTO documents (doc_id, source, title, contract_type, raw_text, char_length, raw_sha256)
         VALUES ('evaltest_1','cuad','T','unknown',$1,$2,$3)`,
        [raw, raw.length, "a".repeat(64)],
      );
    });
  });

  it("flags a gold span whose quote does not match the loaded document", async () => {
    const bad = item({
      gold_spans: [{ doc_id: "evaltest_1", char_start: 0, char_end: 5, quote: "WRONG" }],
    });
    const r = await validateEvalSet([bad], { minItems: 1, requireRefusal: false });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/does not match/i);
  });

  it("flags a gold span pointing at an unknown document", async () => {
    const bad = item({
      doc_id: "ghost", gold_spans: [{ doc_id: "ghost", char_start: 0, char_end: 1, quote: "G" }],
    });
    const r = await validateEvalSet([bad], { minItems: 1, requireRefusal: false });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/unknown document/i);
  });

  it("passes a correct span and reports category stats", async () => {
    const good = item({
      gold_spans: [{ doc_id: "evaltest_1", char_start: 15, char_end: 32, quote: "State of Delaware" }],
    });
    const r = await validateEvalSet([good], { minItems: 1, requireRefusal: false });
    expect(r.ok).toBe(true);
    expect(r.stats.byCategory.clean).toBe(1);
  });

  it("fails when below the minimum item count", async () => {
    const good = item({ gold_spans: [] });
    const r = await validateEvalSet([good], { minItems: 50, requireRefusal: false });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/at least 50/i);
  });
});
```

- [ ] **Step 2: Run to verify it FAILS**

Run: `cd /Users/koushik/Documents/GitHub/sift/core && npm test -- validate`
Expected: FAIL — cannot resolve `../src/eval/validate.js`.

- [ ] **Step 3: Create `core/src/eval/validate.ts`**

```typescript
import { withClient } from "../db/client.js";
import { EvalItemSchema, type EvalItem } from "./evalItem.js";

export interface ValidateOptions {
  minItems?: number;       // default 50
  requireRefusal?: boolean; // default true
}

export interface ValidateResult {
  ok: boolean;
  errors: string[];
  stats: { total: number; byCategory: Record<string, number>; byGrader: Record<string, number> };
}

export async function validateEvalSet(
  rawItems: unknown[],
  opts: ValidateOptions = {},
): Promise<ValidateResult> {
  const minItems = opts.minItems ?? 50;
  const requireRefusal = opts.requireRefusal ?? true;
  const errors: string[] = [];

  // 1) Schema validity.
  const items: EvalItem[] = [];
  rawItems.forEach((r, i) => {
    const parsed = EvalItemSchema.safeParse(r);
    if (!parsed.success) errors.push(`item ${i}: schema invalid: ${parsed.error.message}`);
    else items.push(parsed.data);
  });

  // 2) Every gold span resolves against the loaded corpus (the grounding gate).
  const rawTextCache = new Map<string, string | null>();
  async function rawText(docId: string): Promise<string | null> {
    if (!rawTextCache.has(docId)) {
      const row = await withClient((c) =>
        c.query("SELECT raw_text FROM documents WHERE doc_id=$1", [docId]),
      );
      rawTextCache.set(docId, row.rowCount ? row.rows[0].raw_text : null);
    }
    return rawTextCache.get(docId)!;
  }
  for (const item of items) {
    for (const s of item.gold_spans) {
      const text = await rawText(s.doc_id);
      if (text === null) {
        errors.push(`item ${item.id}: unknown document ${s.doc_id} (load the corpus first)`);
        continue;
      }
      if (text.slice(s.char_start, s.char_end) !== s.quote) {
        errors.push(`item ${item.id}: gold span [${s.char_start},${s.char_end}) does not match ${s.doc_id}`);
      }
    }
  }

  // 3) Composition gates.
  const byCategory: Record<string, number> = { clean: 0, deviated: 0, missing: 0 };
  const byGrader: Record<string, number> = {};
  for (const item of items) {
    byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;
    byGrader[item.grader] = (byGrader[item.grader] ?? 0) + 1;
  }
  if (items.length < minItems) errors.push(`need at least ${minItems} items, have ${items.length}`);
  for (const cat of ["clean", "deviated", "missing"]) {
    if (!byCategory[cat]) errors.push(`category "${cat}" has no items (need a clean/deviated/missing mix)`);
  }
  if (requireRefusal && !byGrader["refusal"]) {
    errors.push("no refusal items (need at least one 'insufficient context' item)");
  }

  return { ok: errors.length === 0, errors, stats: { total: items.length, byCategory, byGrader } };
}
```

- [ ] **Step 4: Run to verify it PASSES**

Run: `cd /Users/koushik/Documents/GitHub/sift/core && npm test -- validate`
Expected: PASS (4 passed).

- [ ] **Step 5: Create `core/src/eval/cli.ts`** (derive + validate commands)

```typescript
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createReadStream, existsSync } from "node:fs";
import { GoldLabelSchema, type GoldLabel } from "../schemas/goldLabel.js";
import { loadPlaybook, playbookIds } from "./playbook.js";
import { deriveCandidates } from "./derive.js";
import { validateEvalSet } from "./validate.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cmd = process.argv[2];

async function readGold(): Promise<GoldLabel[]> {
  const out: GoldLabel[] = [];
  for (const s of ["cuad", "contractnli"]) {
    const p = `${root}data/processed/${s}/gold.jsonl`;
    if (!existsSync(p)) continue;
    const rl = createInterface({ input: createReadStream(p, "utf-8"), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.trim()) out.push(GoldLabelSchema.parse(JSON.parse(line)));
    }
  }
  return out;
}

if (cmd === "derive") {
  const pb = playbookIds(loadPlaybook(`${root}evals/playbook/nda.yaml`));
  const candidates = deriveCandidates(await readGold(), pb);
  const out = `${root}evals/data/candidates.jsonl`;
  writeFileSync(out, candidates.map((c) => JSON.stringify(c)).join("\n") + "\n");
  console.log(`wrote ${candidates.length} candidates -> ${out}`);
  process.exit(0);
} else if (cmd === "validate") {
  const items = JSON.parse(readFileSync(`${root}evals/data/eval-set-v1.json`, "utf-8"));
  const r = await validateEvalSet(items);
  console.log(JSON.stringify(r.stats, null, 2));
  if (!r.ok) {
    console.error("VALIDATION FAILED:\n" + r.errors.map((e) => " - " + e).join("\n"));
    process.exit(1);
  }
  console.log("eval set v1 OK");
  process.exit(0);
} else {
  console.error("usage: tsx src/eval/cli.ts <derive|validate>");
  process.exit(2);
}
```

- [ ] **Step 6: Add eval targets to `Makefile`**

```makefile
.PHONY: eval-derive eval-validate
eval-derive:
	cd core && npm run eval -- derive
eval-validate:
	cd core && npm run eval -- validate
```

- [ ] **Step 7: Curate the 50-item `evals/data/eval-set-v1.json`**

Prerequisite: the corpus is loaded (`make ingest && make parse && make load`). Then:
1. Generate candidates: `cd /Users/koushik/Documents/GitHub/sift && make eval-derive` (writes `evals/data/candidates.jsonl`).
2. Build `evals/data/eval-set-v1.json` as a JSON array of ≥50 curated `EvalItem`s. Compose the mix deliberately:
   - **≥20 `clean`** items — correctly-present clauses (mostly CUAD `span_match` candidates), `expected_fields` filled with the real value where known, `gold_spans` copied verbatim from candidates (offsets already validated).
   - **≥15 `deviated`** items — clauses that violate a playbook position (e.g. a perpetual-term NDA → `expected_flags: [{playbook_id: confidentiality_term, severity: high}]`), sourced from ContractNLI `flag_match` candidates plus hand-checks.
   - **≥10 `missing`** items — a required clause absent (e.g. no `exclusions`); `gold_spans: []`, `expected_flags` naming the missing `playbook_id`, `grader: flag_match`.
   - **≥3 `refusal`** items — questions out of scope for the document (`grader: refusal`, `gold_spans: []`, objective phrased as an unanswerable-from-this-contract question). These exercise the refuse-when-ungrounded invariant.
   Every `playbook_id` used must exist in `nda.yaml` (Task 12). Every `doc_id` must be a loaded document. Keep each item's `notes` describing why it was chosen.
3. Hand-verify a sample: open 5 items, confirm the `gold_spans` quotes read correctly in the source and the `expected_flags` match the playbook intent.

- [ ] **Step 8: Run the validator against the real 50 to verify the gate PASSES**

Run: `cd /Users/koushik/Documents/GitHub/sift && make eval-validate`
Expected: prints stats with `total >= 50`, all three categories non-zero, a `refusal` count ≥1, then `eval set v1 OK` (exit 0). If it fails, fix the offending items per the printed errors and re-run.

- [ ] **Step 9: Commit**

```bash
git add core/src/eval/validate.ts core/src/eval/cli.ts core/test/validate.test.ts evals/data/eval-set-v1.json Makefile
git commit -m "feat(eval): eval-set validator + curated eval set v1 (50 graded items)"
```

---

## Task 15: Phase 0 acceptance harness + eval report

**Files:**
- Modify: `Makefile` (add `ingest`, `parse`, `verify-p0`)
- Create: `pipeline/pipeline/cli.py` (ingest + parse driver)
- Create: `docs/eval-reports/P0.md`

**Interfaces:**
- Consumes: every prior task (ingest, parse, load, validate).
- Produces: `make verify-p0` — the single command that proves the Phase 0 gate; the P0 eval report.

- [ ] **Step 1: Create `pipeline/pipeline/cli.py`** (downloads + normalizes + parses to `data/processed/`)

```python
"""Phase 0 pipeline CLI: `ingest` (download+normalize) and `parse` (add hierarchy nodes)."""
from __future__ import annotations

import sys
from pathlib import Path

from pipeline.ingest.contractnli import load_contractnli, normalize_contractnli
from pipeline.ingest.cuad import load_cuad_qa, normalize_cuad
from pipeline.parse_docs import parse_raw_file

ROOT = Path(__file__).resolve().parents[2]
PROCESSED = ROOT / "data" / "processed"


def _write_jsonl(path: Path, models) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        for m in models:
            fh.write(m.model_dump_json() + "\n")
    return len(models)


def ingest() -> None:
    # CUAD (HF download; cap for a fast first pass — raise/remove the limit for the full corpus).
    docs, gold = normalize_cuad(load_cuad_qa(limit=2000))
    print(f"cuad: {_write_jsonl(PROCESSED / 'cuad' / 'raw.jsonl', docs)} docs, "
          f"{_write_jsonl(PROCESSED / 'cuad' / 'gold.jsonl', gold)} gold")

    # ContractNLI (expects data/raw/contractnli/test.json downloaded per DATA.md).
    cnli_path = ROOT / "data" / "raw" / "contractnli" / "test.json"
    if cnli_path.exists():
        cdocs, cgold = normalize_contractnli(load_contractnli(str(cnli_path)))
        print(f"contractnli: {_write_jsonl(PROCESSED / 'contractnli' / 'raw.jsonl', cdocs)} docs, "
              f"{_write_jsonl(PROCESSED / 'contractnli' / 'gold.jsonl', cgold)} gold")
    else:
        print(f"contractnli: SKIP — download the split to {cnli_path} (see DATA.md)")


def parse() -> None:
    for source in ("cuad", "contractnli"):
        raw = PROCESSED / source / "raw.jsonl"
        if raw.exists():
            n = parse_raw_file(raw, PROCESSED / source / "docs.jsonl")
            print(f"{source}: parsed {n} docs -> docs.jsonl")


if __name__ == "__main__":
    {"ingest": ingest, "parse": parse}[sys.argv[1]]()
```

- [ ] **Step 2: Add `ingest`, `parse`, and `verify-p0` to `Makefile`**

```makefile
.PHONY: ingest parse verify-p0
ingest:
	cd pipeline && .venv/bin/python -m pipeline.cli ingest
parse:
	cd pipeline && .venv/bin/python -m pipeline.cli parse

# Phase 0 gate: corpus loaded + parser hierarchy on 10 contracts + eval set v1 (50 items).
verify-p0: db-up migrate
	@echo "== 1/3 parser hierarchy gate (10 contracts) =="
	cd pipeline && .venv/bin/python -m pytest tests/test_parse_gate.py -q
	@echo "== 2/3 corpus loaded =="
	cd core && npm run load
	@echo "== 3/3 eval set v1 (50 items) =="
	cd core && npm run eval -- validate
	@echo "PHASE 0 GATE PASSED"
```

- [ ] **Step 3: Run the full pipeline end-to-end**

Run:
```bash
cd /Users/koushik/Documents/GitHub/sift && \
make db-up && make migrate && make ingest && make parse && make load
```
Expected: ingest prints doc/gold counts, parse prints parsed counts, load prints `total: N docs, M clauses` with N>0. (If ContractNLI was skipped, download its split per `DATA.md` and re-run `make ingest parse load`.)

- [ ] **Step 4: Run the Phase 0 gate**

Run: `cd /Users/koushik/Documents/GitHub/sift && make verify-p0`
Expected: the three sections pass in order, ending with `PHASE 0 GATE PASSED`.

- [ ] **Step 5: Create `docs/eval-reports/P0.md`** recording the result

Fill in the bracketed values from the actual run output:

```markdown
# Phase 0 — Foundation: Eval Report

**Date:** 2026-06-24
**Gate:** corpus loaded · parser preserves hierarchy on 10 contracts · eval set v1 (50 items). **Result: PASS.**

## Corpus loaded (pgvector)
- Documents: [N]  ([n_cuad] CUAD, [n_contractnli] ContractNLI)
- Clauses (hierarchy nodes): [M]
- Source command: `make ingest && make parse && make load`

## Structure-aware parser
- 10 sample contracts in `pipeline/fixtures/contracts/`.
- Invariants enforced by `test_parse_gate.py`: exact offsets (`text == raw[start:end]`),
  no dangling parents, root depth 0, post-parse ParsedDocument validates.
- Node-count snapshot: `pipeline/fixtures/expected_hierarchy.json`.
- Hand-verified by eye: [list the doc_ids you inspected in Task 10 Step 5].

## Eval set v1
- File: `evals/data/eval-set-v1.json` — [total] items.
- Categories: clean [c], deviated [d], missing [m]; refusal items: [r].
- Graders: [span_match/flag_match/field_match/refusal counts].
- Every gold span verified to resolve against the loaded corpus (`make eval-validate`).
- Playbook: `evals/playbook/nda.yaml` ([k] positions).

## Notes / deviations
- [Anything that needed regex tuning in the parser; any datasets skipped and why.]

## Next: Phase 1 (Naive baseline)
Single-embedding top-k RAG, clause cards with source-span citations, SSE UI shell;
record baseline recall@k / NDCG@10 + groundedness.
```

- [ ] **Step 6: Commit**

```bash
git add pipeline/pipeline/cli.py docs/eval-reports/P0.md Makefile
git commit -m "feat: phase 0 acceptance harness (make verify-p0) + P0 eval report"
```

---

## Phase 0 spec-coverage map

Self-review trace from `PLAN.md` Phase 0 requirements to tasks:

| Spec requirement (PLAN.md) | Task(s) |
|---|---|
| Repo + `CLAUDE.md` (stack, conventions, citation format, eval commands, non-goals) | 1 |
| `SPEC.md`, `DECISIONS.md` (why pgvector, hybrid split, embedding deferral), `DATA.md` (licenses) | 1 |
| Public-data / no-PII invariant; license recorded before use | 1 (DATA.md), 7–8 |
| Typed, schema-validated payloads (pydantic + Zod against `schemas/`) | 1, 4 |
| Citation invariant `quote === raw_text.slice(start,end)` enforced by tests | 4, 7–11, 14 |
| CUAD ingestion | 7 |
| ContractNLI ingestion | 8 |
| Structure-aware parser (articles/sections/subsections/defs/exhibits, preserved relationships) | 9 |
| Parser preserves hierarchy on **10 sample contracts** (gate) | 10 |
| pgvector setup (extension, schema, swappable DB boundary, smoke) | 5, 6 |
| Corpus loaded (gate) | 11, 15 |
| NDA playbook (standard positions, fallbacks, red-flags) | 12 |
| Eval set v1 = **50 items**, clean/deviated/missing mix, expected fields + flags + gold spans | 13, 14 |
| Refuse-when-ungrounded represented in the eval set | 14 |
| Per-phase eval report under `docs/` | 15 |
| `make verify-p0` single-command gate | 15 |

**Out of Phase 0 scope (deferred, per PLAN.md §6):** embeddings/embedder choice, naive RAG baseline, UI/SSE, hybrid retrieval, reranking, fine-tuning, MCP/action layer, lease expansion. Tasks here set up the schema and boundaries (e.g. the `embeddings` table, the swappable `core/src/db/` layer) so those phases slot in without rework.
