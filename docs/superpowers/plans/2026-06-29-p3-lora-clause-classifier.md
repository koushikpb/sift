# P3 — LoRA clause classifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Train a LoRA clause-type classifier and prove (or disprove) it beats a fair prompted-LLM baseline on a document-disjoint CUAD test split, primary metric macro-F1, decision recorded in `DECISIONS.md`.

**Architecture:** New Python package `pipeline/pipeline/classify/`. Pure, fully-tested foundations (pydantic models, metrics, CUAD extraction with a document-grouped split, the prompted baseline's prompt/parse) ship as TDD subagent tasks; the heavy torch training + evaluation + the full before/after run is a controller-run gate (like the P2 eval gates). The classifier is standalone — it is NOT wired into the live retrieve/generate path (that is Layer 3).

**Tech Stack:** Python 3.11, pydantic (validation), `transformers` + `peft` + `torch` (LoRA training, behind an `[ml]` optional extra), `requests` (existing — the prompted baseline calls NIM's OpenAI-compatible endpoint), pytest.

## Global Constraints

(Copied from the spec; every task's requirements implicitly include these.)

- **Label source = CUAD `clause_type`**, closed-set, **count-floored (default 50)** to the well-represented types. No "Other"/reject class.
- **Classify the annotated span's text** (the CUAD answer `quote`).
- **Document-grouped split**: no `doc_id` appears in two splits; every kept class appears in train AND test. Seeded (`SEED = 42`), ≈70/15/15 of documents.
- **Primary metric `macro-F1`** (stated in advance). Secondary: accuracy, per-class F1. **Decision rule: the LoRA classifier wins iff `tuned_macro_f1 >= prompted_macro_f1 + 0.05`** — else Prompt wins and the adapter is not shipped.
- **Typed payloads validated with pydantic** (the clf artifacts are Python-only, so JSON Schema in `schemas/` — reserved for cross-language artifacts — is intentionally NOT added; pydantic is the validation boundary here).
- **Fair prompted baseline**: each clause type gets a one-line definition + in-context examples — a genuine effort, not a strawman.
- **Free/local**: training is PyTorch/PEFT on CPU/MPS. Heavy deps live behind `pipeline[ml]` so the ingestion path stays light.
- **Python tests** run with `cd pipeline && .venv/bin/python -m pytest -q`; a single file: `.venv/bin/python -m pytest tests/<f>.py -q`. Lint: `.venv/bin/python -m ruff check .`.
- **Evals/decision are the merge gate** — no task is done until its test/gate passes; the before/after table + the document-split verification is the final gate, recorded in `DECISIONS.md`.

## Shared constants & artifact shapes (used across tasks)

- `CLF_DATA_DIR = data/processed/cuad_clf/` → `train.jsonl`, `val.jsonl`, `test.jsonl`, `label_map.json`.
- `label_map.json` = `{"labels": ["Affiliate License-Licensee", "Agreement Date", ...]}` (sorted, unique). Index in the list = the integer class id. `id2label = dict(enumerate(labels))`, `label2id = {l: i for i, l in enumerate(labels)}`.
- `ClfExample` (pydantic): `{ text: str (min_length 1), clause_type: str (min_length 1), doc_id: str (min_length 1) }`.
- `ClfReport` (pydantic): `{ name: str, model: str, macro_f1: float, accuracy: float, per_class_f1: dict[str, float], n_test: int }`.
- Reports: `evals/reports/clf_baseline.json`, `evals/reports/clf_lora.json`. Adapter: `models/cuad_clf/`.
- `SEED = 42`, `FLOOR = 50`, split ratios `0.70 / 0.15 / 0.15`, `CLF_BASE_MODEL = "microsoft/deberta-v3-base"` (env-overridable), `MAX_LEN = 256`.

---

## File Structure

**New (Python, `pipeline/pipeline/classify/`):**
- `__init__.py` — package marker.
- `models.py` — pydantic `ClfExample`, `ClfReport`; `load_label_map` / `save_label_map`; `load_examples(path)`.
- `metrics.py` — pure `per_class_f1`, `macro_f1`, `accuracy`, `compute_clf_metrics(logits, label_ids, labels)`.
- `extract.py` — full-CUAD extraction, count floor, document-grouped split, writes the splits + label map.
- `baseline.py` — few-shot prompt builder, answer→label parser, the NIM run loop.
- `train.py` — LoRA training (torch/peft). *(Controller-run gate.)*
- `evaluate.py` — load adapter, predict, before/after table. *(Controller-run gate.)*

**New (tests, `pipeline/tests/`):** `test_clf_models.py`, `test_clf_metrics.py`, `test_clf_extract.py`, `test_clf_baseline.py`.

**Modified:** `pipeline/pyproject.toml` (add `[ml]` extra), `Makefile` (add `clf-extract|clf-baseline|clf-train|clf-eval`), `DECISIONS.md` (the gate verdict).

---

## Task 1: Pure foundations — pydantic models + metrics

**Files:**
- Create: `pipeline/pipeline/classify/__init__.py`, `pipeline/pipeline/classify/models.py`, `pipeline/pipeline/classify/metrics.py`
- Test: `pipeline/tests/test_clf_models.py`, `pipeline/tests/test_clf_metrics.py`

**Interfaces:**
- Produces:
  - `ClfExample(text, clause_type, doc_id)`, `ClfReport(name, model, macro_f1, accuracy, per_class_f1, n_test)` (pydantic `BaseModel`s).
  - `save_label_map(path, labels: list[str]) -> None`, `load_label_map(path) -> list[str]`.
  - `load_examples(path) -> list[ClfExample]`, `save_examples(path, examples) -> None` (one JSON object per line).
  - `per_class_f1(y_true, y_pred, labels) -> dict[str, float]`, `macro_f1(...) -> float`, `accuracy(y_true, y_pred) -> float`, `compute_clf_metrics(logits, label_ids, labels) -> dict` (`{"macro_f1","accuracy"}`; `logits` = list of per-class score lists).

- [ ] **Step 1: Write the failing tests**

Create `pipeline/tests/test_clf_metrics.py`:

```python
from pipeline.classify.metrics import per_class_f1, macro_f1, accuracy, compute_clf_metrics

LABELS = ["A", "B", "C"]


def test_perfect_prediction_scores_1():
    yt = ["A", "B", "C", "A"]
    assert macro_f1(yt, yt, LABELS) == 1.0
    assert accuracy(yt, yt) == 1.0


def test_all_wrong_scores_0():
    yt = ["A", "A", "A"]
    yp = ["B", "B", "B"]
    assert accuracy(yt, yp) == 0.0
    # A: no tp -> f1 0; B: tp=0 (no true B) -> f1 0; C: 0 -> macro 0
    assert macro_f1(yt, yp, LABELS) == 0.0


def test_macro_f1_weights_classes_equally():
    # 3 A's all correct, 1 B predicted A (B recall 0). Micro would look better than macro.
    yt = ["A", "A", "A", "B"]
    yp = ["A", "A", "A", "A"]
    pc = per_class_f1(yt, yp, LABELS)
    assert pc["A"] > 0 and pc["B"] == 0.0 and pc["C"] == 0.0
    # macro = (f1_A + 0 + 0) / 3, strictly between 0 and f1_A
    assert 0 < macro_f1(yt, yp, LABELS) < pc["A"]


def test_per_class_f1_known_value():
    # A: tp=1, fp=1, fn=0 -> prec .5 rec 1 -> f1 = 2*.5/(1.5)=.6667
    yt = ["A", "B"]
    yp = ["A", "A"]
    pc = per_class_f1(yt, yp, ["A", "B"])
    assert round(pc["A"], 4) == 0.6667
    assert pc["B"] == 0.0


def test_compute_clf_metrics_argmaxes_logits():
    labels = ["A", "B"]
    logits = [[2.0, 0.1], [0.0, 1.0], [3.0, 1.0]]  # -> A, B, A
    label_ids = [0, 1, 1]  # A, B, B  -> 2/3 correct
    out = compute_clf_metrics(logits, label_ids, labels)
    assert round(out["accuracy"], 4) == round(2 / 3, 4)
    assert "macro_f1" in out


def test_empty_inputs_are_zero():
    assert accuracy([], []) == 0.0
    assert macro_f1([], [], LABELS) == 0.0
```

Create `pipeline/tests/test_clf_models.py`:

```python
import json
import pytest
from pydantic import ValidationError
from pipeline.classify.models import (
    ClfExample, ClfReport, save_label_map, load_label_map, load_examples, save_examples,
)


def test_clf_example_requires_nonempty_fields():
    ClfExample(text="t", clause_type="Governing Law", doc_id="cuad_x")
    with pytest.raises(ValidationError):
        ClfExample(text="", clause_type="X", doc_id="d")


def test_label_map_roundtrip(tmp_path):
    p = tmp_path / "label_map.json"
    save_label_map(p, ["B", "A"])  # saved sorted+unique
    assert load_label_map(p) == ["A", "B"]
    assert json.loads(p.read_text())["labels"] == ["A", "B"]


def test_examples_roundtrip(tmp_path):
    p = tmp_path / "train.jsonl"
    ex = [ClfExample(text="x", clause_type="A", doc_id="d1"),
          ClfExample(text="y", clause_type="B", doc_id="d2")]
    save_examples(p, ex)
    back = load_examples(p)
    assert [e.text for e in back] == ["x", "y"]
    assert [e.clause_type for e in back] == ["A", "B"]


def test_clf_report_fields():
    r = ClfReport(name="lora", model="deberta", macro_f1=0.5, accuracy=0.6,
                  per_class_f1={"A": 0.5}, n_test=10)
    assert r.macro_f1 == 0.5 and r.n_test == 10
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd pipeline && .venv/bin/python -m pytest tests/test_clf_metrics.py tests/test_clf_models.py -q`
Expected: FAIL — `ModuleNotFoundError: pipeline.classify`.

- [ ] **Step 3: Create the package + metrics**

Create `pipeline/pipeline/classify/__init__.py` (empty file).

Create `pipeline/pipeline/classify/metrics.py`:

```python
"""Pure classification metrics — no model, no torch, no I/O."""
from __future__ import annotations


def per_class_f1(y_true: list[str], y_pred: list[str], labels: list[str]) -> dict[str, float]:
    out: dict[str, float] = {}
    for lab in labels:
        tp = sum(1 for t, p in zip(y_true, y_pred) if t == lab and p == lab)
        fp = sum(1 for t, p in zip(y_true, y_pred) if t != lab and p == lab)
        fn = sum(1 for t, p in zip(y_true, y_pred) if t == lab and p != lab)
        prec = tp / (tp + fp) if (tp + fp) else 0.0
        rec = tp / (tp + fn) if (tp + fn) else 0.0
        out[lab] = 2 * prec * rec / (prec + rec) if (prec + rec) else 0.0
    return out


def macro_f1(y_true: list[str], y_pred: list[str], labels: list[str]) -> float:
    if not labels:
        return 0.0
    f1s = per_class_f1(y_true, y_pred, labels)
    return sum(f1s.values()) / len(labels)


def accuracy(y_true: list[str], y_pred: list[str]) -> float:
    if not y_true:
        return 0.0
    return sum(1 for t, p in zip(y_true, y_pred) if t == p) / len(y_true)


def compute_clf_metrics(logits: list[list[float]], label_ids: list[int], labels: list[str]) -> dict:
    """For HF Trainer: argmax the logits, map ids->labels, return macro_f1 + accuracy."""
    id2label = dict(enumerate(labels))
    y_pred = [id2label[max(range(len(row)), key=lambda i: row[i])] for row in logits]
    y_true = [id2label[i] for i in label_ids]
    return {"macro_f1": macro_f1(y_true, y_pred, labels), "accuracy": accuracy(y_true, y_pred)}
```

Create `pipeline/pipeline/classify/models.py`:

```python
"""Typed clf artifacts (pydantic) + jsonl/label-map I/O. Python-only payloads."""
from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel, Field


class ClfExample(BaseModel):
    text: str = Field(min_length=1)
    clause_type: str = Field(min_length=1)
    doc_id: str = Field(min_length=1)


class ClfReport(BaseModel):
    name: str
    model: str
    macro_f1: float
    accuracy: float
    per_class_f1: dict[str, float]
    n_test: int


def save_label_map(path: str | Path, labels: list[str]) -> None:
    ordered = sorted(set(labels))
    Path(path).write_text(json.dumps({"labels": ordered}, indent=2) + "\n", encoding="utf-8")


def load_label_map(path: str | Path) -> list[str]:
    return json.loads(Path(path).read_text(encoding="utf-8"))["labels"]


def save_examples(path: str | Path, examples: list[ClfExample]) -> None:
    with Path(path).open("w", encoding="utf-8") as fh:
        for e in examples:
            fh.write(e.model_dump_json() + "\n")


def load_examples(path: str | Path) -> list[ClfExample]:
    out: list[ClfExample] = []
    with Path(path).open(encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                out.append(ClfExample.model_validate_json(line))
    return out
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd pipeline && .venv/bin/python -m pytest tests/test_clf_metrics.py tests/test_clf_models.py -q`
Expected: PASS (10 tests).

- [ ] **Step 5: Lint + commit**

Run: `cd pipeline && .venv/bin/python -m ruff check pipeline/classify tests/test_clf_metrics.py tests/test_clf_models.py`
Expected: no errors.

```bash
git add pipeline/pipeline/classify/__init__.py pipeline/pipeline/classify/models.py pipeline/pipeline/classify/metrics.py pipeline/tests/test_clf_metrics.py pipeline/tests/test_clf_models.py
git commit -m "feat(clf): pure classification foundations (pydantic models + metrics)"
```

---

## Task 2: CUAD extraction + document-grouped split

**Files:**
- Create: `pipeline/pipeline/classify/extract.py`
- Test: `pipeline/tests/test_clf_extract.py`
- Modify: `Makefile` (add `clf-extract`)

**Interfaces:**
- Consumes: `ClfExample`, `save_examples`, `save_label_map` from `classify/models.py`; `load_cuad_qa`, `_clause_type`, `_doc_id` from `pipeline/ingest/cuad.py`.
- Produces:
  - `records_to_examples(records) -> list[ClfExample]` — flat CUAD records → one `ClfExample` per non-empty answer span.
  - `apply_floor(examples, floor) -> tuple[list[ClfExample], list[str]]` — drop classes with `< floor` examples; return kept examples + sorted kept labels.
  - `split_by_doc(examples, seed, ratios) -> dict[str, list[ClfExample]]` — keys `train`/`val`/`test`; partitions DOCUMENTS (not spans), every kept class present in train and test.
  - `run_extract(floor=FLOOR, seed=SEED, out_dir=CLF_DATA_DIR) -> None` — full pipeline: load CUAD → examples → floor → split → write the three jsonl + label_map.

- [ ] **Step 1: Write the failing test**

Create `pipeline/tests/test_clf_extract.py`:

```python
from pipeline.classify.extract import records_to_examples, apply_floor, split_by_doc
from pipeline.classify.models import ClfExample


def _rec(title, clause, text):
    return {
        "title": title,
        "context": f"... {text} ...",
        "question": f'Highlight the parts related to "{clause}" in the contract.',
        "answers": {"text": [text] if text else [], "answer_start": [4] if text else []},
    }


def test_records_to_examples_one_per_answer_span_skips_empty():
    recs = [_rec("ACME NDA", "Governing Law", "State of Delaware"),
            _rec("ACME NDA", "Uncapped Liability", "")]  # empty -> skipped
    ex = records_to_examples(recs)
    assert len(ex) == 1
    assert ex[0].clause_type == "Governing Law"
    assert ex[0].text == "State of Delaware"
    assert ex[0].doc_id == "cuad_acme-nda"


def test_apply_floor_drops_rare_classes():
    ex = ([ClfExample(text="t", clause_type="Common", doc_id=f"d{i}") for i in range(3)]
          + [ClfExample(text="t", clause_type="Rare", doc_id="dR")])
    kept, labels = apply_floor(ex, floor=2)
    assert labels == ["Common"]
    assert all(e.clause_type == "Common" for e in kept)


def test_split_by_doc_has_no_doc_leakage_and_covers_classes():
    # 10 docs, each with both classes A and B -> floor met, split must keep both in train+test
    ex = []
    for i in range(10):
        ex.append(ClfExample(text="a", clause_type="A", doc_id=f"d{i}"))
        ex.append(ClfExample(text="b", clause_type="B", doc_id=f"d{i}"))
    splits = split_by_doc(ex, seed=42, ratios=(0.7, 0.15, 0.15))
    docs = {k: {e.doc_id for e in v} for k, v in splits.items()}
    # no doc in two splits
    assert docs["train"].isdisjoint(docs["val"])
    assert docs["train"].isdisjoint(docs["test"])
    assert docs["val"].isdisjoint(docs["test"])
    # every kept class present in train AND test
    for split in ("train", "test"):
        assert {e.clause_type for e in splits[split]} == {"A", "B"}


def test_split_is_deterministic():
    ex = [ClfExample(text="a", clause_type="A", doc_id=f"d{i}") for i in range(20)]
    s1 = split_by_doc(ex, seed=42, ratios=(0.7, 0.15, 0.15))
    s2 = split_by_doc(ex, seed=42, ratios=(0.7, 0.15, 0.15))
    assert {k: [e.doc_id for e in v] for k, v in s1.items()} == \
           {k: [e.doc_id for e in v] for k, v in s2.items()}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline && .venv/bin/python -m pytest tests/test_clf_extract.py -q`
Expected: FAIL — cannot import `pipeline.classify.extract`.

- [ ] **Step 3: Implement extract.py**

Create `pipeline/pipeline/classify/extract.py`:

```python
"""Extract CUAD clause spans into a document-grouped train/val/test classification set."""
from __future__ import annotations

import random
from collections import Counter, defaultdict
from pathlib import Path

from pipeline.ingest.cuad import _clause_type, _doc_id, load_cuad_qa
from pipeline.classify.models import ClfExample, save_examples, save_label_map

FLOOR = 50
SEED = 42
RATIOS = (0.70, 0.15, 0.15)
CLF_DATA_DIR = Path(__file__).parents[3] / "data" / "processed" / "cuad_clf"


def records_to_examples(records: list[dict]) -> list[ClfExample]:
    out: list[ClfExample] = []
    for rec in records:
        clause_type = _clause_type(rec["question"])
        if clause_type is None:
            continue
        doc_id = _doc_id(rec["title"])
        for text in (rec.get("answers", {}) or {}).get("text", []) or []:
            t = text.strip()
            if t:
                out.append(ClfExample(text=t, clause_type=clause_type, doc_id=doc_id))
    return out


def apply_floor(examples: list[ClfExample], floor: int) -> tuple[list[ClfExample], list[str]]:
    counts = Counter(e.clause_type for e in examples)
    kept_labels = sorted(c for c, n in counts.items() if n >= floor)
    kept_set = set(kept_labels)
    kept = [e for e in examples if e.clause_type in kept_set]
    return kept, kept_labels


def split_by_doc(
    examples: list[ClfExample], seed: int, ratios: tuple[float, float, float]
) -> dict[str, list[ClfExample]]:
    """Partition DOCUMENTS into train/val/test (no doc in two splits). Greedy assignment
    in shuffled doc order toward the target ratios; then a coverage pass moves one doc so
    every class present in the data appears in both train and test."""
    by_doc: dict[str, list[ClfExample]] = defaultdict(list)
    for e in examples:
        by_doc[e.doc_id].append(e)
    docs = sorted(by_doc)  # deterministic base order
    rng = random.Random(seed)
    rng.shuffle(docs)

    n = len(docs)
    n_train = int(round(ratios[0] * n))
    n_val = int(round(ratios[1] * n))
    assign = {d: ("train" if i < n_train else "val" if i < n_train + n_val else "test")
              for i, d in enumerate(docs)}

    def classes_in(split: str) -> set[str]:
        return {e.clause_type for d, s in assign.items() if s == split for e in by_doc[d]}

    all_classes = {e.clause_type for e in examples}
    # Coverage pass: ensure every class appears in train AND test by re-homing a donor doc.
    for split in ("train", "test"):
        missing = all_classes - classes_in(split)
        for cls in sorted(missing):
            donor = next(
                (d for d in docs
                 if assign[d] != split and any(e.clause_type == cls for e in by_doc[d])
                 and sum(1 for x in docs if assign[x] == assign[d]) > 1),
                None,
            )
            if donor is not None:
                assign[donor] = split

    out: dict[str, list[ClfExample]] = {"train": [], "val": [], "test": []}
    for d in docs:
        out[assign[d]].extend(by_doc[d])
    return out


def run_extract(floor: int = FLOOR, seed: int = SEED, out_dir: Path = CLF_DATA_DIR) -> None:
    examples = records_to_examples(load_cuad_qa())
    kept, labels = apply_floor(examples, floor)
    splits = split_by_doc(kept, seed, RATIOS)
    out_dir.mkdir(parents=True, exist_ok=True)
    for name in ("train", "val", "test"):
        save_examples(out_dir / f"{name}.jsonl", splits[name])
    save_label_map(out_dir / "label_map.json", labels)
    print(f"clf-extract: {len(kept)} examples, {len(labels)} classes; "
          f"train/val/test = {len(splits['train'])}/{len(splits['val'])}/{len(splits['test'])}")


if __name__ == "__main__":
    run_extract()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline && .venv/bin/python -m pytest tests/test_clf_extract.py -q`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the Makefile target**

In `Makefile`, after the `ingest`/`parse` block, add:

```makefile
.PHONY: clf-extract clf-baseline clf-train clf-eval
clf-extract:
	cd pipeline && .venv/bin/python -m pipeline.classify.extract
```

(The `clf-baseline`/`clf-train`/`clf-eval` recipes are added in later tasks under this same `.PHONY` line — add the line now; Tasks 3 and 4 append their recipes.)

- [ ] **Step 6: Lint + commit**

Run: `cd pipeline && .venv/bin/python -m ruff check pipeline/classify/extract.py tests/test_clf_extract.py`
Expected: no errors.

```bash
git add pipeline/pipeline/classify/extract.py pipeline/tests/test_clf_extract.py Makefile
git commit -m "feat(clf): CUAD extraction + document-grouped split (leakage guard)"
```

---

## Task 3: Prompted-LLM baseline

**Files:**
- Create: `pipeline/pipeline/classify/baseline.py`
- Test: `pipeline/tests/test_clf_baseline.py`
- Modify: `Makefile` (append `clf-baseline` recipe)

**Interfaces:**
- Consumes: `ClfExample`, `ClfReport`, `load_examples`, `load_label_map` from `classify/models.py`; `macro_f1`, `accuracy`, `per_class_f1` from `classify/metrics.py`.
- Produces:
  - `build_prompt(text, labels, fewshot) -> tuple[str, str]` — `(system, user)`; lists the labels and asks for exactly one label name.
  - `parse_label(answer, labels) -> str` — map a free-text model answer to one of `labels` (exact, then case-insensitive substring); unmatched → `labels[0]` is WRONG, so return a sentinel `"__unmatched__"` that is never a valid label (counts as a miss).
  - `run_baseline(...) -> ClfReport` — classify the test split via NIM (paced by `LLM_RPM`), write `evals/reports/clf_baseline.json`.

- [ ] **Step 1: Write the failing test**

Create `pipeline/tests/test_clf_baseline.py`:

```python
from pipeline.classify.baseline import build_prompt, parse_label

LABELS = ["Governing Law", "Cap On Liability", "Non-Compete"]


def test_build_prompt_lists_labels_and_text():
    system, user = build_prompt("This is governed by Delaware law.", LABELS, fewshot=[])
    assert "Governing Law" in system and "Cap On Liability" in system
    assert "Delaware law" in user
    # asks for exactly one label
    assert "exactly one" in system.lower() or "one of" in system.lower()


def test_parse_label_exact_match():
    assert parse_label("Governing Law", LABELS) == "Governing Law"


def test_parse_label_case_insensitive_and_embedded():
    assert parse_label("The answer is: governing law.", LABELS) == "Governing Law"


def test_parse_label_unmatched_returns_sentinel():
    out = parse_label("Some Other Category", LABELS)
    assert out not in LABELS  # a miss, never silently a valid label
    assert out == "__unmatched__"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline && .venv/bin/python -m pytest tests/test_clf_baseline.py -q`
Expected: FAIL — cannot import `pipeline.classify.baseline`.

- [ ] **Step 3: Implement baseline.py**

Create `pipeline/pipeline/classify/baseline.py`:

```python
"""Few-shot prompted-LLM clause classifier — the 'before' baseline. Calls NIM's
OpenAI-compatible chat endpoint via requests, paced under LLM_RPM."""
from __future__ import annotations

import os
import time
from pathlib import Path

import requests

from pipeline.classify.metrics import accuracy, macro_f1, per_class_f1
from pipeline.classify.models import ClfReport, load_examples, load_label_map

UNMATCHED = "__unmatched__"
_REPO_ROOT = Path(__file__).parents[3]
_BASE_URL = os.environ.get("LLM_BASE_URL", "https://integrate.api.nvidia.com/v1")
_MODEL = os.environ.get("LLM_MODEL", "meta/llama-3.3-70b-instruct")


def build_prompt(text: str, labels: list[str], fewshot: list[tuple[str, str]]) -> tuple[str, str]:
    labels_block = "\n".join(f"- {lab}" for lab in labels)
    shots = "".join(f"\nText: {t}\nLabel: {lab}\n" for t, lab in fewshot)
    system = (
        "You are a contract clause classifier. Given a clause excerpt, reply with EXACTLY ONE "
        "label name from this list, copied verbatim, and nothing else:\n"
        f"{labels_block}\n"
        "Reply with only the label text — no punctuation, no explanation."
        + (f"\n\nExamples:{shots}" if shots else "")
    )
    user = f"Text: {text}\nLabel:"
    return system, user


def parse_label(answer: str, labels: list[str]) -> str:
    a = answer.strip()
    for lab in labels:  # exact
        if a == lab:
            return lab
    low = a.lower()
    for lab in labels:  # case-insensitive substring (model may add punctuation/prefix)
        if lab.lower() in low:
            return lab
    return UNMATCHED


def _min_interval_ms() -> float:
    rpm = os.environ.get("LLM_RPM")
    if rpm:
        try:
            n = float(rpm)
            if n > 0:
                return 60000.0 / n
        except ValueError:
            pass
    return 0.0


def _classify_one(system: str, user: str) -> str:
    resp = requests.post(
        f"{_BASE_URL}/chat/completions",
        headers={"Authorization": f"Bearer {os.environ.get('LLM_API_KEY', '')}"},
        json={"model": _MODEL, "temperature": 0,
              "messages": [{"role": "system", "content": system},
                           {"role": "user", "content": user}]},
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"] or ""


def run_baseline(
    data_dir: Path | None = None, fewshot_n: int = 2, out: Path | None = None
) -> ClfReport:
    data_dir = data_dir or (_REPO_ROOT / "data" / "processed" / "cuad_clf")
    labels = load_label_map(data_dir / "label_map.json")
    train = load_examples(data_dir / "train.jsonl")
    test = load_examples(data_dir / "test.jsonl")

    # Fair baseline: a few in-context examples per class (drawn from TRAIN, never TEST).
    by_cls: dict[str, list[str]] = {}
    for e in train:
        by_cls.setdefault(e.clause_type, []).append(e.text)
    fewshot = [(by_cls[lab][i], lab) for lab in labels
               for i in range(min(fewshot_n, len(by_cls.get(lab, []))))]

    interval = _min_interval_ms() / 1000.0
    y_true, y_pred = [], []
    next_at = 0.0
    for i, e in enumerate(test):
        if interval:
            wait = next_at - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            next_at = time.monotonic() + interval
        system, user = build_prompt(e.text, labels, fewshot)
        try:
            pred = parse_label(_classify_one(system, user), labels)
        except Exception as exc:  # network/5xx -> recorded as a miss, never aborts the run
            print(f"  baseline item {i} error: {exc}")
            pred = UNMATCHED
        y_true.append(e.clause_type)
        y_pred.append(pred)
        if (i + 1) % 25 == 0:
            print(f"  baseline {i + 1}/{len(test)}")

    report = ClfReport(
        name="prompted_baseline", model=_MODEL,
        macro_f1=macro_f1(y_true, y_pred, labels), accuracy=accuracy(y_true, y_pred),
        per_class_f1=per_class_f1(y_true, y_pred, labels), n_test=len(test),
    )
    out = out or (_REPO_ROOT / "evals" / "reports" / "clf_baseline.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(report.model_dump_json(indent=2) + "\n", encoding="utf-8")
    print(f"clf-baseline: macro_f1={report.macro_f1:.4f} accuracy={report.accuracy:.4f}")
    return report


if __name__ == "__main__":
    run_baseline()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline && .venv/bin/python -m pytest tests/test_clf_baseline.py -q`
Expected: PASS (4 tests).

- [ ] **Step 5: Append the Makefile recipe**

Under the `.PHONY: clf-extract clf-baseline clf-train clf-eval` line from Task 2, add:

```makefile
clf-baseline:
	cd pipeline && .venv/bin/python -m pipeline.classify.baseline
```

- [ ] **Step 6: Lint + commit**

Run: `cd pipeline && .venv/bin/python -m ruff check pipeline/classify/baseline.py tests/test_clf_baseline.py`
Expected: no errors (drop any unused import it flags).

```bash
git add pipeline/pipeline/classify/baseline.py pipeline/tests/test_clf_baseline.py Makefile
git commit -m "feat(clf): few-shot prompted-LLM baseline (prompt + tolerant parse)"
```

---

## Task 4: LoRA training + evaluation scripts + `[ml]` extra

> **Note for the executor:** `train.py`/`evaluate.py` import torch/transformers/peft, which are NOT installed in the default env. Do NOT install them or run a training pass here — that is the Task 5 controller gate. This task **writes the scripts faithfully, byte-checks they parse, and unit-tests the one pure helper (the before/after table formatter)**. The runtime correctness is verified at the gate.

**Files:**
- Create: `pipeline/pipeline/classify/train.py`, `pipeline/pipeline/classify/evaluate.py`
- Test: `pipeline/tests/test_clf_table.py`
- Modify: `pipeline/pyproject.toml` (add `[ml]` extra), `Makefile` (append `clf-train`/`clf-eval`)

**Interfaces:**
- Consumes: `load_examples`, `load_label_map`, `ClfReport` from `models.py`; `compute_clf_metrics`, `macro_f1`, `accuracy`, `per_class_f1` from `metrics.py`.
- Produces: `format_delta_table(baseline: ClfReport, lora: ClfReport) -> str` (pure, in `evaluate.py`); `models/cuad_clf/` adapter (at the gate).

- [ ] **Step 1: Write the failing test (pure helper only)**

Create `pipeline/tests/test_clf_table.py`:

```python
from pipeline.classify.evaluate import format_delta_table
from pipeline.classify.models import ClfReport


def test_delta_table_shows_both_and_signed_delta():
    base = ClfReport(name="prompted_baseline", model="llama", macro_f1=0.50, accuracy=0.60,
                     per_class_f1={}, n_test=40)
    lora = ClfReport(name="lora", model="deberta", macro_f1=0.58, accuracy=0.61,
                     per_class_f1={}, n_test=40)
    out = format_delta_table(base, lora)
    assert "macro_f1" in out and "accuracy" in out
    assert "0.5000" in out and "0.5800" in out
    assert "+0.0800" in out  # signed delta, 4dp
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline && .venv/bin/python -m pytest tests/test_clf_table.py -q`
Expected: FAIL — cannot import `pipeline.classify.evaluate` (or `format_delta_table`).

> The test imports only `format_delta_table` + `ClfReport`. Keep `format_delta_table` and all torch/transformers imports such that importing the symbol does not require torch — i.e. put the heavy imports INSIDE the functions that need them (lazy import), so module import stays light. The steps below do exactly that.

- [ ] **Step 3: Write `train.py`**

Create `pipeline/pipeline/classify/train.py`:

```python
"""LoRA fine-tune an encoder for CUAD clause-type classification. Controller-run (heavy).
Heavy deps (torch/transformers/peft/datasets) are imported at call time."""
from __future__ import annotations

import os
from pathlib import Path

from pipeline.classify.metrics import compute_clf_metrics
from pipeline.classify.models import load_examples, load_label_map

_REPO_ROOT = Path(__file__).parents[3]
CLF_DATA_DIR = _REPO_ROOT / "data" / "processed" / "cuad_clf"
MODEL_DIR = _REPO_ROOT / "models" / "cuad_clf"
BASE_MODEL = os.environ.get("CLF_BASE_MODEL", "microsoft/deberta-v3-base")
MAX_LEN = 256
SEED = 42


def run_train(data_dir: Path = CLF_DATA_DIR, out_dir: Path = MODEL_DIR) -> None:
    import torch
    from datasets import Dataset
    from peft import LoraConfig, TaskType, get_peft_model
    from transformers import (
        AutoModelForSequenceClassification, AutoTokenizer,
        DataCollatorWithPadding, Trainer, TrainingArguments,
    )

    labels = load_label_map(data_dir / "label_map.json")
    label2id = {l: i for i, l in enumerate(labels)}
    id2label = dict(enumerate(labels))

    def to_ds(split: str) -> "Dataset":
        ex = load_examples(data_dir / f"{split}.jsonl")
        return Dataset.from_list([{"text": e.text, "label": label2id[e.clause_type]} for e in ex])

    tok = AutoTokenizer.from_pretrained(BASE_MODEL)
    train_ds, val_ds = to_ds("train"), to_ds("val")

    def tok_fn(batch):
        return tok(batch["text"], truncation=True, max_length=MAX_LEN)

    train_ds = train_ds.map(tok_fn, batched=True)
    val_ds = val_ds.map(tok_fn, batched=True)

    model = AutoModelForSequenceClassification.from_pretrained(
        BASE_MODEL, num_labels=len(labels), id2label=id2label, label2id=label2id,
    )
    # DeBERTa attention proj names; for roberta/bert use ["query","value"].
    target = os.environ.get("CLF_LORA_TARGETS", "query_proj,value_proj").split(",")
    peft_model = get_peft_model(
        model,
        LoraConfig(task_type=TaskType.SEQ_CLS, r=16, lora_alpha=32, lora_dropout=0.1,
                   target_modules=target),
    )
    peft_model.print_trainable_parameters()

    args = TrainingArguments(
        output_dir=str(out_dir / "_checkpoints"),
        learning_rate=2e-4, per_device_train_batch_size=16, per_device_eval_batch_size=32,
        num_train_epochs=10, weight_decay=0.01, eval_strategy="epoch", save_strategy="epoch",
        load_best_model_at_end=True, metric_for_best_model="macro_f1", greater_is_better=True,
        seed=SEED, report_to="none", logging_steps=20,
    )
    trainer = Trainer(
        model=peft_model, args=args, train_dataset=train_ds, eval_dataset=val_ds,
        data_collator=DataCollatorWithPadding(tok),
        compute_metrics=lambda ep: compute_clf_metrics(
            ep.predictions.tolist(), ep.label_ids.tolist(), labels),
    )
    torch.manual_seed(SEED)
    trainer.train()
    out_dir.mkdir(parents=True, exist_ok=True)
    peft_model.save_pretrained(str(out_dir))
    tok.save_pretrained(str(out_dir))
    print(f"clf-train: adapter saved -> {out_dir}")


if __name__ == "__main__":
    run_train()
```

- [ ] **Step 4: Write `evaluate.py` (with the pure `format_delta_table`)**

Create `pipeline/pipeline/classify/evaluate.py`:

```python
"""Score the LoRA classifier on the test split and print the before/after table.
Controller-run (heavy). Heavy deps imported at call time; format_delta_table is pure."""
from __future__ import annotations

import json
import os
from pathlib import Path

from pipeline.classify.metrics import accuracy, macro_f1, per_class_f1
from pipeline.classify.models import ClfReport, load_examples, load_label_map

_REPO_ROOT = Path(__file__).parents[3]
CLF_DATA_DIR = _REPO_ROOT / "data" / "processed" / "cuad_clf"
MODEL_DIR = _REPO_ROOT / "models" / "cuad_clf"
BASE_MODEL = os.environ.get("CLF_BASE_MODEL", "microsoft/deberta-v3-base")
MAX_LEN = 256


def format_delta_table(baseline: ClfReport, lora: ClfReport) -> str:
    rows = [("macro_f1", baseline.macro_f1, lora.macro_f1),
            ("accuracy", baseline.accuracy, lora.accuracy)]
    lines = [f"{'metric':<12} {'baseline':>10} {'lora':>10} {'delta':>10}"]
    for name, b, l in rows:
        lines.append(f"{name:<12} {b:>10.4f} {l:>10.4f} {l - b:>+10.4f}")
    return "\n".join(lines)


def run_eval(data_dir: Path = CLF_DATA_DIR, model_dir: Path = MODEL_DIR) -> ClfReport:
    import torch
    from peft import PeftModel
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    labels = load_label_map(data_dir / "label_map.json")
    id2label = dict(enumerate(labels))
    test = load_examples(data_dir / "test.jsonl")

    tok = AutoTokenizer.from_pretrained(str(model_dir))
    base = AutoModelForSequenceClassification.from_pretrained(
        BASE_MODEL, num_labels=len(labels), id2label=id2label,
        label2id={l: i for i, l in enumerate(labels)},
    )
    model = PeftModel.from_pretrained(base, str(model_dir))
    model.eval()

    y_true, y_pred = [], []
    with torch.no_grad():
        for e in test:
            enc = tok(e.text, truncation=True, max_length=MAX_LEN, return_tensors="pt")
            logits = model(**enc).logits[0]
            y_pred.append(id2label[int(logits.argmax())])
            y_true.append(e.clause_type)

    report = ClfReport(
        name="lora", model=BASE_MODEL,
        macro_f1=macro_f1(y_true, y_pred, labels), accuracy=accuracy(y_true, y_pred),
        per_class_f1=per_class_f1(y_true, y_pred, labels), n_test=len(test),
    )
    out = _REPO_ROOT / "evals" / "reports" / "clf_lora.json"
    out.write_text(report.model_dump_json(indent=2) + "\n", encoding="utf-8")

    baseline_path = _REPO_ROOT / "evals" / "reports" / "clf_baseline.json"
    if baseline_path.exists():
        baseline = ClfReport.model_validate(json.loads(baseline_path.read_text()))
        print(format_delta_table(baseline, report))
    print(f"clf-eval: macro_f1={report.macro_f1:.4f} accuracy={report.accuracy:.4f}")
    return report


if __name__ == "__main__":
    run_eval()
```

- [ ] **Step 5: Run the pure test + a parse check**

Run: `cd pipeline && .venv/bin/python -m pytest tests/test_clf_table.py -q`
Expected: PASS (1 test) — confirms `format_delta_table` works and the module imports without torch (heavy imports are inside `run_*`).

Run: `cd pipeline && .venv/bin/python -m py_compile pipeline/classify/train.py pipeline/classify/evaluate.py`
Expected: no output (both files are syntactically valid).

- [ ] **Step 6: Add the `[ml]` extra + Makefile recipes**

In `pipeline/pyproject.toml`, under `[project.optional-dependencies]`, add an `ml` extra alongside the existing `dev`:

```toml
[project.optional-dependencies]
dev = ["pytest>=8.0", "ruff>=0.4"]
ml = [
  "torch>=2.2",
  "transformers>=4.44",
  "peft>=0.12",
  "datasets>=2.18",
  "sentencepiece>=0.2",
  "protobuf>=4.25",
]
```

In `Makefile`, append under the `.PHONY: clf-extract clf-baseline clf-train clf-eval` line:

```makefile
clf-train:
	cd pipeline && .venv/bin/python -m pipeline.classify.train
clf-eval:
	cd pipeline && .venv/bin/python -m pipeline.classify.evaluate
```

- [ ] **Step 7: Lint + commit**

Run: `cd pipeline && .venv/bin/python -m ruff check pipeline/classify/train.py pipeline/classify/evaluate.py tests/test_clf_table.py`
Expected: no errors.

```bash
git add pipeline/pipeline/classify/train.py pipeline/pipeline/classify/evaluate.py pipeline/tests/test_clf_table.py pipeline/pyproject.toml Makefile
git commit -m "feat(clf): LoRA train + eval scripts + [ml] extra (gate-run)"
```

---

## Task 5: The gate — train, evaluate, decide, record (controller-run)

The merge gate. Requires the `[ml]` extra installed, the extracted splits, and a NIM key. **The controller runs this directly** (heavy compute + credentials); it is not a sandboxed implementer task. Produces the before/after table, the document-split verification, and the recorded decision.

**Files:**
- Modify: `DECISIONS.md` (the Prompt→Fine-tune verdict), `docs/superpowers/specs/2026-06-29-p3-lora-clause-classifier-design.md` (Results section)

**Preconditions:** `pip install -e 'pipeline[ml]'` in the pipeline venv; `.env` (or env) has `LLM_API_KEY`; use `LLM_MODEL=meta/llama-3.3-70b-instruct LLM_RPM=36`.

- [ ] **Step 1: Extract the dataset**

Run: `make clf-extract`
Expected: prints `clf-extract: <N> examples, <K> classes; train/val/test = …`. Confirm `data/processed/cuad_clf/{train,val,test}.jsonl` + `label_map.json` exist and `K` is a sane count (~15–20 at floor 50).

- [ ] **Step 2: Verify the split is leakage-free (the methodological gate)**

Run:
```bash
cd pipeline && .venv/bin/python -c "
from pipeline.classify.models import load_examples
import pathlib
d = pathlib.Path('../data/processed/cuad_clf')
S = {s: load_examples(d/f'{s}.jsonl') for s in ('train','val','test')}
docs = {s: {e.doc_id for e in v} for s,v in S.items()}
assert docs['train'].isdisjoint(docs['test']) and docs['train'].isdisjoint(docs['val']) and docs['val'].isdisjoint(docs['test']), 'DOC LEAKAGE'
cl = {s: {e.clause_type for e in v} for s,v in S.items()}
assert cl['train'] == cl['test'], f'class mismatch train/test: {cl[\"train\"] ^ cl[\"test\"]}'
print('split OK: doc-disjoint; classes train==test =', len(cl['train']))
"
```
Expected: `split OK: …`. A failure here blocks the gate (fix `split_by_doc` before proceeding).

- [ ] **Step 3: Install ML deps + run the prompted baseline**

Run: `cd pipeline && .venv/bin/pip install -e '.[ml]'` (one-time; heavy).
Run: `LLM_MODEL=meta/llama-3.3-70b-instruct LLM_RPM=36 make clf-baseline`
Expected: `clf-baseline: macro_f1=… accuracy=…`; `evals/reports/clf_baseline.json` written.

- [ ] **Step 4: Train the LoRA classifier**

Run: `make clf-train`
Expected: `print_trainable_parameters` shows a small % trainable; training runs (minutes on MPS/CPU); `models/cuad_clf/` adapter saved. If the DeBERTa tokenizer or LoRA target modules error, set `CLF_BASE_MODEL=roberta-base CLF_LORA_TARGETS=query,value` and re-run (the base is a single knob).

- [ ] **Step 5: Evaluate + before/after table**

Run: `make clf-eval`
Expected: the delta table (macro_f1, accuracy) prints; `evals/reports/clf_lora.json` written.

- [ ] **Step 6: Decide against the pre-stated rule + record**

Apply the rule: **adopt the LoRA classifier iff `clf_lora.macro_f1 >= clf_baseline.macro_f1 + 0.05`**; otherwise Prompt wins (don't ship the adapter). Write to **`DECISIONS.md`** (newest first) a "P3 — Prompt→Fine-tune" entry: the before/after table, per-class highlights, the document-split verification, the decision, and the rationale. Fill the spec's "Results (P3) — TBD" section with the same table + decision.

- [ ] **Step 7: Commit the reports + decision**

```bash
git add evals/reports/clf_baseline.json evals/reports/clf_lora.json DECISIONS.md docs/superpowers/specs/2026-06-29-p3-lora-clause-classifier-design.md
git commit -m "eval(p3): LoRA-vs-prompt before/after + Prompt→Fine-tune decision"
```

(Do NOT commit `models/cuad_clf/` adapter weights or `data/processed/cuad_clf/` splits unless they are small and intended for the repo — otherwise add them to `.gitignore`. Decide at the gate based on size.)

---

## Notes for the executor

- **Tasks 1–3 are pure and fully unit-tested** (no torch, no network) — standard TDD subagent tasks.
- **Task 4 writes the heavy scripts but does NOT run them** — its verification is the pure table-formatter test + `py_compile`. Lazy (in-function) torch imports keep the modules importable without the `[ml]` stack so the pure test runs.
- **Task 5 is the controller gate** — install `[ml]`, run the four `make clf-*` steps, fix any runtime/API drift (transformers `eval_strategy` vs `evaluation_strategy`; LoRA target-module names per base), and record the decision. A measured null (Prompt wins) is a valid, recorded outcome.
- **Reproducibility:** `SEED = 42` for the split and training; the frozen `test.jsonl` scores both baseline and tuned model.
- **Branch:** `phase-3-lora-clause-classifier` (off `main`). The spec is already committed (`57a3f92`).
