"""Typed clf artifacts (pydantic) + jsonl/label-map I/O. Python-only payloads."""
from __future__ import annotations

import json
import random
from collections import defaultdict
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


def subsample_stratified(
    examples: list[ClfExample], limit: int | None, seed: int = 42
) -> list[ClfExample]:
    """Deterministic stratified subsample to ~`limit` items, >= 1 per class. The same
    (examples, limit, seed) always yields the same subset, so the baseline and the tuned
    model can be scored on an identical reduced test set. limit None / >= len -> all."""
    if not limit or limit >= len(examples):
        return list(examples)
    by_cls: dict[str, list[ClfExample]] = defaultdict(list)
    for e in examples:
        by_cls[e.clause_type].append(e)
    n = len(examples)
    rng = random.Random(seed)
    picked: list[ClfExample] = []
    for c in sorted(by_cls):
        pool = sorted(by_cls[c], key=lambda e: (e.doc_id, e.text))
        rng.shuffle(pool)
        take = max(1, round(limit * len(by_cls[c]) / n))
        picked.extend(pool[:take])
    picked.sort(key=lambda e: (e.clause_type, e.doc_id, e.text))
    return picked
