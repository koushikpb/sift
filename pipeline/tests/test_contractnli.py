from pipeline.ingest.contractnli import normalize_contractnli


def _data():
    text = "Confidential Information excludes public data. Term is three years."
    span_a = [0, 45]   # "Confidential Information excludes public data."
    span_b = [46, len(text)]  # "Term is three years."
    return {
        "documents": [
            {
                "id": "nda_1",
                "file_name": "nda_1.pdf",
                "text": text,
                "spans": [span_a, span_b],
                "annotation_sets": [
                    {
                        "annotations": {
                            "nda-1": {"choice": "Entailment", "spans": [0]},
                            "nda-2": {"choice": "NotMentioned", "spans": []},
                        }
                    }
                ],
            }
        ],
        "labels": {
            "nda-1": {"hypothesis": "Some information is excluded from confidentiality."},
            "nda-2": {"hypothesis": "The receiving party may not reverse-engineer."},
        },
    }


def test_one_document_typed_nda():
    docs, _ = normalize_contractnli(_data())
    assert len(docs) == 1
    assert docs[0].source == "contractnli"
    assert docs[0].contract_type == "nda"
    assert docs[0].doc_id == "contractnli_nda_1"


def test_gold_only_for_decided_hypotheses_with_exact_spans():
    docs, gold = normalize_contractnli(_data())
    raw = docs[0].raw_text
    # NotMentioned without evidence is dropped; only the Entailment remains.
    assert len(gold) == 1
    g = gold[0]
    assert g.kind == "nli"
    assert g.nli_label == "entailment"
    assert g.hypothesis.startswith("Some information is excluded")
    sp = g.spans[0]
    assert raw[sp.char_start:sp.char_end] == sp.quote
