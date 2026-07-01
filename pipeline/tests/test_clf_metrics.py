from pipeline.classify.metrics import accuracy, compute_clf_metrics, macro_f1, per_class_f1

LABELS = ["A", "B", "C"]


def test_perfect_prediction_scores_1():
    yt = ["A", "B", "C", "A"]
    assert macro_f1(yt, yt, LABELS) == 1.0
    assert accuracy(yt, yt) == 1.0


def test_all_wrong_scores_0():
    yt = ["A", "A", "A"]
    yp = ["B", "B", "B"]
    assert accuracy(yt, yp) == 0.0
    # A: no tp -> f1 0; B: tp=0 (no true B) -> f1 0; C: 0 -> macro 0
    assert macro_f1(yt, yp, LABELS) == 0.0


def test_macro_f1_weights_classes_equally():
    # 3 A's all correct, 1 B predicted A (B recall 0). Micro would look better than macro.
    yt = ["A", "A", "A", "B"]
    yp = ["A", "A", "A", "A"]
    pc = per_class_f1(yt, yp, LABELS)
    assert pc["A"] > 0 and pc["B"] == 0.0 and pc["C"] == 0.0
    # macro = (f1_A + 0 + 0) / 3, strictly between 0 and f1_A
    assert 0 < macro_f1(yt, yp, LABELS) < pc["A"]


def test_per_class_f1_known_value():
    # A: tp=1, fp=1, fn=0 -> prec .5 rec 1 -> f1 = 2*.5/(1.5)=.6667
    yt = ["A", "B"]
    yp = ["A", "A"]
    pc = per_class_f1(yt, yp, ["A", "B"])
    assert round(pc["A"], 4) == 0.6667
    assert pc["B"] == 0.0


def test_compute_clf_metrics_argmaxes_logits():
    labels = ["A", "B"]
    logits = [[2.0, 0.1], [0.0, 1.0], [3.0, 1.0]]  # -> A, B, A
    label_ids = [0, 1, 1]  # A, B, B  -> 2/3 correct
    out = compute_clf_metrics(logits, label_ids, labels)
    assert round(out["accuracy"], 4) == round(2 / 3, 4)
    assert "macro_f1" in out


def test_empty_inputs_are_zero():
    assert accuracy([], []) == 0.0
    assert macro_f1([], [], LABELS) == 0.0
