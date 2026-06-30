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
