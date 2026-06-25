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
