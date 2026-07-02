import json

from pipeline.classify.predict import parse_input_line, format_prediction, run_predict


def test_parse_input_line_reads_text_field_and_skips_blank():
    assert parse_input_line(json.dumps({"text": "hello"})) == "hello"
    assert parse_input_line("   ") is None


def test_format_prediction_is_valid_jsonl():
    line = format_prediction("a clause", "Governing Law", 0.97)
    obj = json.loads(line)
    assert obj == {"text": "a clause", "label": "Governing Law", "score": 0.97}
    assert "\n" not in line  # caller adds the newline


def test_run_predict_streams_one_prediction_per_input_line():
    # Inject a fake classifier so no model loads.
    def fake_classify(texts):
        return [(f"LABEL_{i}", 0.5) for i, _ in enumerate(texts)]

    src = [json.dumps({"text": "x"}), "", json.dumps({"text": "y"})]
    out = []
    run_predict(iter(src), out.append, classify=fake_classify)
    parsed = [json.loads(o) for o in out]
    assert [p["text"] for p in parsed] == ["x", "y"]
    assert [p["label"] for p in parsed] == ["LABEL_0", "LABEL_1"]
