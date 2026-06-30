"""Pure classification metrics — no model, no torch, no I/O."""
from __future__ import annotations


def per_class_f1(y_true: list[str], y_pred: list[str], labels: list[str]) -> dict[str, float]:
    out: dict[str, float] = {}
    for lab in labels:
        tp = sum(1 for t, p in zip(y_true, y_pred) if t == lab and p == lab)
        fp = sum(1 for t, p in zip(y_true, y_pred) if t != lab and p == lab)
        fn = sum(1 for t, p in zip(y_true, y_pred) if t == lab and p != lab)
        prec = tp / (tp + fp) if (tp + fp) else 0.0
        rec = tp / (tp + fn) if (tp + fn) else 0.0
        out[lab] = 2 * prec * rec / (prec + rec) if (prec + rec) else 0.0
    return out


def macro_f1(y_true: list[str], y_pred: list[str], labels: list[str]) -> float:
    if not labels:
        return 0.0
    f1s = per_class_f1(y_true, y_pred, labels)
    return sum(f1s.values()) / len(labels)


def accuracy(y_true: list[str], y_pred: list[str]) -> float:
    if not y_true:
        return 0.0
    return sum(1 for t, p in zip(y_true, y_pred) if t == p) / len(y_true)


def compute_clf_metrics(logits: list[list[float]], label_ids: list[int], labels: list[str]) -> dict:
    """For HF Trainer: argmax the logits, map ids->labels, return macro_f1 + accuracy."""
    id2label = dict(enumerate(labels))
    y_pred = [id2label[max(range(len(row)), key=lambda i: row[i])] for row in logits]
    y_true = [id2label[i] for i in label_ids]
    return {"macro_f1": macro_f1(y_true, y_pred, labels), "accuracy": accuracy(y_true, y_pred)}
