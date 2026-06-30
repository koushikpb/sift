from pipeline.classify.evaluate import format_delta_table
from pipeline.classify.models import ClfReport


def test_delta_table_shows_both_and_signed_delta():
    base = ClfReport(name="prompted_baseline", model="llama", macro_f1=0.50, accuracy=0.60,
                     per_class_f1={}, n_test=40)
    lora = ClfReport(name="lora", model="deberta", macro_f1=0.58, accuracy=0.61,
                     per_class_f1={}, n_test=40)
    out = format_delta_table(base, lora)
    assert "macro_f1" in out and "accuracy" in out
    assert "0.5000" in out and "0.5800" in out
    assert "+0.0800" in out  # signed delta, 4dp
