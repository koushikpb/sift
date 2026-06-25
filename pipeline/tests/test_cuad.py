from pipeline.ingest.cuad import normalize_cuad


def _records():
    context = 'This Agreement is dated January 1, 2020. Governing law: State of Delaware.'
    date_at = context.index("January 1, 2020")
    law_at = context.index("State of Delaware")
    return [
        {
            "title": "ACME Mutual NDA",
            "context": context,
            "question": 'Highlight the parts related to "Agreement Date" ...',
            "answers": {"text": ["January 1, 2020"], "answer_start": [date_at]},
        },
        {
            "title": "ACME Mutual NDA",
            "context": context,
            "question": 'Highlight the parts related to "Governing Law" ...',
            "answers": {"text": ["State of Delaware"], "answer_start": [law_at]},
        },
        {  # a question with no answer span -> produces no gold label
            "title": "ACME Mutual NDA",
            "context": context,
            "question": 'Highlight the parts related to "Uncapped Liability" ...',
            "answers": {"text": [], "answer_start": []},
        },
    ]


def test_normalize_groups_by_title_into_one_document():
    docs, _ = normalize_cuad(_records())
    assert len(docs) == 1
    doc = docs[0]
    assert doc.source == "cuad"
    assert doc.contract_type == "unknown"
    assert doc.title == "ACME Mutual NDA"
    assert doc.char_length == len(doc.raw_text)
    assert doc.nodes == []  # parsing happens later


def test_gold_labels_carry_clause_type_and_exact_spans():
    docs, gold = normalize_cuad(_records())
    raw = docs[0].raw_text
    assert len(gold) == 2  # the empty-answer question yields nothing
    by_type = {g.clause_type: g for g in gold}
    assert set(by_type) == {"Agreement Date", "Governing Law"}
    for g in gold:
        assert g.kind == "clause_span"
        sp = g.spans[0]
        # Citation invariant: quote equals the raw_text slice.
        assert raw[sp.char_start:sp.char_end] == sp.quote
