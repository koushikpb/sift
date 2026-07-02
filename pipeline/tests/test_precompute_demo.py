"""Unit tests for pipeline.classify.precompute_demo.

The framing helpers (collect_clause_spans, precompute_rows) are pure and
tested without loading the LoRA model — a stub classifier is injected.
"""

import json

from pipeline.classify.precompute_demo import collect_clause_spans, precompute_rows

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

SAMPLE_DOC = {
    "doc_id": "contractnli_4",
    "contract_type": "nda",
    "raw_text": "This is preamble. " + "x" * 200,
    "nodes": [
        {
            "node_id": "contractnli_4/s1",
            "type": "section",
            "text": "Section 1 clause text.",
            "char_start": 18,
            "char_end": 40,
        },
        {
            "node_id": "contractnli_4/s2",
            "type": "subsection",
            "text": "Subsection 2 text.",
            "char_start": 40,
            "char_end": 58,
        },
        {
            "node_id": "contractnli_4/preamble",
            "type": "exhibit",  # filtered out
            "text": "Preamble text.",
            "char_start": 0,
            "char_end": 18,
        },
    ],
}


def _make_docs_jsonl(tmp_path, docs):
    p = tmp_path / "docs.jsonl"
    p.write_text("\n".join(json.dumps(d) for d in docs))
    return str(p)


# ---------------------------------------------------------------------------
# collect_clause_spans
# ---------------------------------------------------------------------------


def test_collect_clause_spans_filters_by_doc_id(tmp_path):
    """Only the curated doc_ids' spans are returned; others are ignored."""
    other_doc = dict(SAMPLE_DOC, doc_id="contractnli_99")
    path = _make_docs_jsonl(tmp_path, [SAMPLE_DOC, other_doc])
    spans = collect_clause_spans(path, {"contractnli_4"}, {"section", "subsection"})
    assert all(s["doc_id"] == "contractnli_4" for s in spans)


def test_collect_clause_spans_filters_by_node_type(tmp_path):
    """Only the requested node types are included."""
    path = _make_docs_jsonl(tmp_path, [SAMPLE_DOC])
    spans = collect_clause_spans(path, {"contractnli_4"}, {"section", "subsection"})
    # exhibit node must be excluded
    assert "exhibit" not in (s.get("node_type") for s in spans)
    assert len(spans) == 2


def test_collect_clause_spans_row_shape(tmp_path):
    """Each span has the required fields."""
    path = _make_docs_jsonl(tmp_path, [SAMPLE_DOC])
    spans = collect_clause_spans(path, {"contractnli_4"}, {"section", "subsection"})
    for s in spans:
        assert {"doc_id", "char_start", "char_end", "text"} <= set(s.keys())
        assert isinstance(s["char_start"], int)
        assert isinstance(s["char_end"], int)
        assert isinstance(s["text"], str) and s["text"]


# ---------------------------------------------------------------------------
# precompute_rows
# ---------------------------------------------------------------------------


def _stub_classify(texts):
    return [(f"Label_{i}", 0.9 - i * 0.05) for i in range(len(texts))]


def test_precompute_rows_output_shape():
    """Each output row carries doc_id, char_start, char_end, label, score."""
    spans = [
        {"doc_id": "contractnli_4", "char_start": 18, "char_end": 40, "text": "a clause"},
        {"doc_id": "contractnli_4", "char_start": 40, "char_end": 58, "text": "another"},
    ]
    rows = precompute_rows(spans, _stub_classify)
    assert len(rows) == 2
    for row in rows:
        assert set(row.keys()) == {"doc_id", "char_start", "char_end", "label", "score"}
        assert isinstance(row["score"], float)
        assert isinstance(row["label"], str) and row["label"]


def test_precompute_rows_maps_predictions_to_spans():
    spans = [
        {"doc_id": "contractnli_1", "char_start": 0, "char_end": 100, "text": "span one"},
    ]
    rows = precompute_rows(spans, lambda texts: [("Governing Law", 0.97)])
    assert rows[0] == {
        "doc_id": "contractnli_1",
        "char_start": 0,
        "char_end": 100,
        "label": "Governing Law",
        "score": 0.97,
    }


def test_precompute_rows_preserves_span_identity():
    """Each row's doc_id/char_start/char_end match the originating span."""
    spans = [
        {"doc_id": "d_a", "char_start": 10, "char_end": 50, "text": "alpha"},
        {"doc_id": "d_b", "char_start": 20, "char_end": 80, "text": "beta"},
    ]
    rows = precompute_rows(spans, _stub_classify)
    assert rows[0]["doc_id"] == "d_a" and rows[0]["char_start"] == 10
    assert rows[1]["doc_id"] == "d_b" and rows[1]["char_start"] == 20


def test_precompute_rows_empty_input():
    assert precompute_rows([], _stub_classify) == []
