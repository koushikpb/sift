"""Normalize CUAD (HF `theatticusproject/cuad-qa`) into ParsedDocument + GoldLabel."""
from __future__ import annotations

import hashlib
import re

from pipeline.artifacts import GoldLabel, ParsedDocument, Span

_CLAUSE_TYPE = re.compile(r'related to [""]([^""]+)[""]')


def _doc_id(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-") or "untitled"
    return f"cuad_{slug}"


def _clause_type(question: str) -> str | None:
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


def load_cuad_qa(limit: int | None = None) -> list[dict]:
    """Download the CUAD-QA validation split from Hugging Face. Network-bound; not unit-tested."""
    from datasets import load_dataset  # imported lazily so tests don't require the network

    ds = load_dataset("theatticusproject/cuad-qa", split="test")
    rows = ds.select(range(limit)) if limit else ds
    return [dict(r) for r in rows]
