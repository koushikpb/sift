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
