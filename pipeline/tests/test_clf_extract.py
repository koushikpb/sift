import pytest

from pipeline.classify.extract import apply_floor, records_to_examples, split_by_doc
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


def test_apply_floor_drops_single_doc_classes():
    ex = [ClfExample(text="t", clause_type="Multi", doc_id=f"d{i}") for i in range(3)]
    ex += [ClfExample(text="t", clause_type="Single", doc_id="dX") for _ in range(5)]
    kept, labels = apply_floor(ex, floor=2, min_docs=2)
    assert labels == ["Multi"]  # Single dropped: 5 examples but only 1 document


def test_split_covers_class_confined_to_two_docs():
    # B lives in exactly 2 docs; naive ratio-splitting could co-locate them. Anchoring must
    # place B in BOTH train and test.
    ex = [ClfExample(text="a", clause_type="A", doc_id=f"dA{i}") for i in range(8)]
    ex += [ClfExample(text="b", clause_type="B", doc_id="dB0"),
           ClfExample(text="b", clause_type="B", doc_id="dB1")]
    splits = split_by_doc(ex, seed=1, ratios=(0.7, 0.15, 0.15))
    tr = {e.clause_type for e in splits["train"]}
    te = {e.clause_type for e in splits["test"]}
    assert "B" in tr and "B" in te
    docs = {k: {e.doc_id for e in v} for k, v in splits.items()}
    assert docs["train"].isdisjoint(docs["test"])


def test_split_raises_when_class_cannot_be_covered():
    # B exists in only ONE document -> cannot be in both train and test -> hard error.
    ex = [ClfExample(text="a", clause_type="A", doc_id="d0"),
          ClfExample(text="b", clause_type="B", doc_id="d0")]
    with pytest.raises(ValueError):
        split_by_doc(ex, seed=1, ratios=(0.7, 0.15, 0.15))
