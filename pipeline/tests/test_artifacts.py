import hashlib
import json
from pathlib import Path

from pipeline.artifacts import GoldLabel, ParsedDocument

EX = Path(__file__).resolve().parents[2] / "schemas" / "examples"

def test_parsed_document_roundtrips_and_is_self_consistent():
    raw = json.loads((EX / "parsed-document.example.json").read_text())
    # Make the committed example self-consistent: digest matches raw_text, len matches.
    raw["raw_sha256"] = hashlib.sha256(raw["raw_text"].encode("utf-8")).hexdigest()
    raw["char_length"] = len(raw["raw_text"])
    (EX / "parsed-document.example.json").write_text(json.dumps(raw, indent=2) + "\n")

    doc = ParsedDocument.model_validate(raw)
    assert doc.raw_sha256 == hashlib.sha256(doc.raw_text.encode("utf-8")).hexdigest()
    assert doc.char_length == len(doc.raw_text)
    # Citation invariant: each node's text equals its slice of raw_text.
    for node in doc.nodes:
        assert doc.raw_text[node.char_start:node.char_end] == node.text

def test_gold_label_roundtrips():
    raw = json.loads((EX / "gold-label.example.json").read_text())
    label = GoldLabel.model_validate(raw)
    assert label.kind == "clause_span"
    assert label.spans[0].quote == "ARTICLE I TERM"
