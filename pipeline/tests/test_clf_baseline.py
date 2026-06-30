from pipeline.classify.baseline import build_prompt, parse_label

LABELS = ["Governing Law", "Cap On Liability", "Non-Compete"]


def test_build_prompt_lists_labels_and_text():
    system, user = build_prompt("This is governed by Delaware law.", LABELS, fewshot=[])
    assert "Governing Law" in system and "Cap On Liability" in system
    assert "Delaware law" in user
    # asks for exactly one label
    assert "exactly one" in system.lower() or "one of" in system.lower()


def test_parse_label_exact_match():
    assert parse_label("Governing Law", LABELS) == "Governing Law"


def test_parse_label_case_insensitive_and_embedded():
    assert parse_label("The answer is: governing law.", LABELS) == "Governing Law"


def test_parse_label_unmatched_returns_sentinel():
    out = parse_label("Some Other Category", LABELS)
    assert out not in LABELS  # a miss, never silently a valid label
    assert out == "__unmatched__"
