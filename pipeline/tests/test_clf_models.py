import json

import pytest
from pydantic import ValidationError

from pipeline.classify.models import (
    ClfExample,
    ClfReport,
    load_examples,
    load_label_map,
    save_examples,
    save_label_map,
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


def test_subsample_stratified_deterministic_and_covers_classes():
    from pipeline.classify.models import subsample_stratified
    ex = []
    for c in ("A", "B", "C"):
        for i in range(20):
            ex.append(ClfExample(text=f"{c}{i}", clause_type=c, doc_id=f"d{c}{i % 5}"))
    s1 = subsample_stratified(ex, limit=12, seed=42)
    s2 = subsample_stratified(ex, limit=12, seed=42)
    assert [e.text for e in s1] == [e.text for e in s2]  # deterministic
    assert {e.clause_type for e in s1} == {"A", "B", "C"}  # every class represented
    assert 9 <= len(s1) <= 15  # ~limit, rounding tolerance


def test_subsample_none_or_large_returns_all():
    from pipeline.classify.models import subsample_stratified
    ex = [ClfExample(text="x", clause_type="A", doc_id="d1")]
    assert len(subsample_stratified(ex, None)) == 1
    assert len(subsample_stratified(ex, 100)) == 1
