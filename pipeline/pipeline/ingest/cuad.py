"""Normalize CUAD (CUAD_v1.json, SQuAD format) into ParsedDocument + GoldLabel.

`theatticusproject/cuad-qa` is a script-based HF dataset rejected by datasets>=3.
We download the plain CUAD_v1.json file directly and flatten it to the flat-record
shape that normalize_cuad expects.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import requests

from pipeline.artifacts import GoldLabel, ParsedDocument, Span

_CLAUSE_TYPE = re.compile(r'related to [""]([^""]+)[""]')

_CUAD_URL = (
    "https://huggingface.co/datasets/theatticusproject/cuad"
    "/resolve/main/CUAD_v1/CUAD_v1.json"
)
_REPO_ROOT = Path(__file__).parents[3]
_CUAD_PATH = _REPO_ROOT / "data" / "raw" / "cuad" / "CUAD_v1.json"


def _doc_id(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-") or "untitled"
    return f"cuad_{slug}"


def _clause_type(question: str) -> str | None:
    m = _CLAUSE_TYPE.search(question)
    return m.group(1).strip() if m else None


def _flatten_squad(squad: dict) -> list[dict]:
    """Flatten CUAD SQuAD-format JSON into the flat records normalize_cuad expects."""
    records: list[dict] = []
    for entry in squad["data"]:
        for para in entry["paragraphs"]:
            context = para["context"]
            for qa in para["qas"]:
                answers = qa.get("answers", []) or []
                records.append({
                    "title": entry["title"],
                    "context": context,
                    "question": qa["question"],
                    "answers": {
                        "text": [a["text"] for a in answers],
                        "answer_start": [a["answer_start"] for a in answers],
                    },
                })
    return records


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


def load_cuad_qa(limit: int | None = None) -> list[dict]:
    """Load CUAD from CUAD_v1.json (SQuAD format) and return flat records.

    The file is read from data/raw/cuad/CUAD_v1.json (relative to repo root).
    If missing, it is downloaded from the theatticusproject/cuad HF dataset.
    theatticusproject/cuad-qa is script-based and rejected by datasets>=3, so
    we use the plain JSON file instead.
    """
    if not _CUAD_PATH.exists():
        _CUAD_PATH.parent.mkdir(parents=True, exist_ok=True)
        with requests.get(_CUAD_URL, stream=True, timeout=120) as resp:
            resp.raise_for_status()
            with _CUAD_PATH.open("wb") as fh:
                for chunk in resp.iter_content(chunk_size=1 << 20):
                    fh.write(chunk)

    with _CUAD_PATH.open(encoding="utf-8") as fh:
        squad = json.load(fh)

    records = _flatten_squad(squad)
    return records[:limit] if limit else records
