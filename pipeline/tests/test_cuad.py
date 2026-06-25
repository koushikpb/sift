from pipeline.ingest.cuad import _flatten_squad, normalize_cuad


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


def test_flatten_squad_produces_normalizable_records():
    context = "This contract is governed by the laws of the State of California."
    answer_text = "State of California"
    answer_start = context.index(answer_text)

    squad = {
        "data": [
            {
                "title": "ACME NDA",
                "paragraphs": [
                    {
                        "context": context,
                        "qas": [
                            {
                                "question": 'Highlight the parts related to "Governing Law" ...',
                                "id": "qa-1",
                                "is_impossible": False,
                                "answers": [
                                    {"text": answer_text, "answer_start": answer_start}
                                ],
                            },
                            {
                                "question": (
                                    'Highlight the parts related to "Uncapped Liability" ...'
                                ),
                                "id": "qa-2",
                                "is_impossible": True,
                                "answers": [],
                            },
                        ],
                    }
                ],
            }
        ]
    }

    records = _flatten_squad(squad)

    # Must produce exactly 2 flat records
    assert len(records) == 2
    for rec in records:
        assert set(rec.keys()) >= {"title", "context", "question", "answers"}
        assert isinstance(rec["answers"], dict)
        assert "text" in rec["answers"]
        assert "answer_start" in rec["answers"]

    # Pipe through normalize_cuad: 1 doc, 1 gold label (impossible/empty skipped)
    docs, gold = normalize_cuad(records)
    assert len(docs) == 1
    assert len(gold) == 1

    # Citation invariant: raw_text[start:end] == quote
    raw = docs[0].raw_text
    sp = gold[0].spans[0]
    assert raw[sp.char_start:sp.char_end] == sp.quote
