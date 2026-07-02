"""Precompute LoRA clause labels for the curated demo corpus.

Reads clause spans from data/processed/<source>/docs.jsonl, classifies each
span's text with the existing LoRA adapter (pipeline.classify.predict.default_classify),
and emits JSONL rows to stdout:

    {"doc_id": ..., "char_start": ..., "char_end": ..., "label": ..., "score": ...}

The downstream Makefile target (clf-precompute) pipes this output into the TS
upsertClauseLabel loader so Vercel serverless can serve labels with no live Python.

Curated demo doc_ids (public ContractNLI NDAs, chosen for cleanliness + variety):
  - contractnli_4   (2 405 chars, 9 section nodes — shortest, very clean)
  - contractnli_6   (8 715 chars, 20 section+subsection nodes — medium)
  - contractnli_1   (16 632 chars, 13 section+definition nodes — standard length)
"""
from __future__ import annotations

import json
import sys
from collections.abc import Callable
from pathlib import Path

# Node types used as clause spans for classification.
CLAUSE_NODE_TYPES: frozenset[str] = frozenset({"section", "subsection", "definition"})

# Curated demo document IDs (all ContractNLI public NDAs).
DEMO_DOC_IDS: frozenset[str] = frozenset(
    {"contractnli_4", "contractnli_6", "contractnli_1"}
)

_REPO_ROOT = Path(__file__).parents[3]


# ---------------------------------------------------------------------------
# Pure framing helpers (unit-tested without loading the LoRA model)
# ---------------------------------------------------------------------------


def collect_clause_spans(
    docs_jsonl_path: str,
    doc_ids: set[str] | frozenset[str],
    node_types: set[str] | frozenset[str],
) -> list[dict]:
    """Read docs.jsonl and return clause spans for the given doc_ids + node_types.

    Each span dict: {doc_id, char_start, char_end, text, node_type}.
    Spans with empty text are skipped.
    """
    spans: list[dict] = []
    with open(docs_jsonl_path) as f:
        for line in f:
            doc = json.loads(line)
            if doc["doc_id"] not in doc_ids:
                continue
            for node in doc.get("nodes", []):
                if node.get("type") not in node_types:
                    continue
                text = (node.get("text") or "").strip()
                if not text:
                    continue
                spans.append(
                    {
                        "doc_id": doc["doc_id"],
                        "char_start": node["char_start"],
                        "char_end": node["char_end"],
                        "text": text,
                        "node_type": node["type"],
                    }
                )
    return spans


def precompute_rows(
    spans: list[dict],
    classify: Callable[[list[str]], list[tuple[str, float]]],
) -> list[dict]:
    """Classify the text of each span and return output rows.

    Each row: {doc_id, char_start, char_end, label, score}.
    The classify callable matches default_classify's signature.
    """
    if not spans:
        return []
    texts = [s["text"] for s in spans]
    predictions = classify(texts)
    rows = []
    for span, (label, score) in zip(spans, predictions):
        rows.append(
            {
                "doc_id": span["doc_id"],
                "char_start": span["char_start"],
                "char_end": span["char_end"],
                "label": label,
                "score": float(score),
            }
        )
    return rows


# ---------------------------------------------------------------------------
# CLI entry point: emit JSONL to stdout
# ---------------------------------------------------------------------------


def run_precompute(
    classify: Callable[[list[str]], list[tuple[str, float]]] | None = None,
    doc_ids: frozenset[str] = DEMO_DOC_IDS,
    node_types: frozenset[str] = CLAUSE_NODE_TYPES,
    writer: Callable[[str], None] = sys.stdout.write,
) -> int:
    """Main orchestrator. Returns the number of rows emitted."""
    if classify is None:
        from pipeline.classify.predict import default_classify  # noqa: PLC0415

        classify = default_classify

    sources = ["cuad", "contractnli"]
    all_spans: list[dict] = []
    for source in sources:
        path = _REPO_ROOT / "data" / "processed" / source / "docs.jsonl"
        if not path.exists():
            continue
        all_spans.extend(collect_clause_spans(str(path), doc_ids, node_types))

    rows = precompute_rows(all_spans, classify)
    for row in rows:
        writer(json.dumps(row) + "\n")
    return len(rows)


if __name__ == "__main__":
    n = run_precompute()
    print(f"# precompute_demo: emitted {n} rows", file=sys.stderr)
