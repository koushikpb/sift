"""Batch LoRA-classifier inference CLI: JSONL {"text": ...} on stdin -> JSONL
{"text","label","score"} on stdout. Loads the adapter exactly as evaluate.py.
Pure framing helpers (parse_input_line, format_prediction) are unit-tested; the model
path (default_classify) is exercised at the P4 gate."""
from __future__ import annotations

import json
import os
import sys
from collections.abc import Callable, Iterable
from pathlib import Path

from pipeline.classify.models import load_label_map

_REPO_ROOT = Path(__file__).parents[3]
CLF_DATA_DIR = _REPO_ROOT / "data" / "processed" / "cuad_clf"
MODEL_DIR = _REPO_ROOT / "models" / "cuad_clf"
BASE_MODEL = os.environ.get("CLF_BASE_MODEL", "microsoft/deberta-v3-base")
MAX_LEN = int(os.environ.get("CLF_MAX_LEN", "128"))


def parse_input_line(line: str) -> str | None:
    """Return the `text` field of a JSONL line, or None for a blank line."""
    if not line.strip():
        return None
    return json.loads(line)["text"]


def format_prediction(text: str, label: str, score: float) -> str:
    """One JSON object per prediction (no trailing newline; the caller adds it)."""
    return json.dumps({"text": text, "label": label, "score": score})


def default_classify(texts: list[str]) -> list[tuple[str, float]]:
    """Load the LoRA adapter and return (label, softmax_score) per text. Heavy; imported lazily."""
    import torch
    from peft import PeftModel
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    labels = load_label_map(CLF_DATA_DIR / "label_map.json")
    id2label = dict(enumerate(labels))
    tok = AutoTokenizer.from_pretrained(str(MODEL_DIR))
    cfg_path = MODEL_DIR / "adapter_config.json"
    base_name = BASE_MODEL
    if cfg_path.exists():
        base_name = json.loads(cfg_path.read_text()).get("base_model_name_or_path") or BASE_MODEL
    base = AutoModelForSequenceClassification.from_pretrained(
        base_name, num_labels=len(labels), id2label=id2label,
        label2id={lbl: i for i, lbl in enumerate(labels)},
    )
    model = PeftModel.from_pretrained(base, str(MODEL_DIR))
    model.eval()

    out: list[tuple[str, float]] = []
    with torch.no_grad():
        for text in texts:
            enc = tok(text, truncation=True, max_length=MAX_LEN, return_tensors="pt")
            logits = model(**enc).logits[0]
            probs = torch.softmax(logits, dim=-1)
            idx = int(probs.argmax())
            out.append((id2label[idx], float(probs[idx])))
    return out


def run_predict(
    reader: Iterable[str],
    writer: Callable[[str], None],
    classify: Callable[[list[str]], list[tuple[str, float]]] = default_classify,
) -> None:
    """Read JSONL text lines, classify in one batch, write JSONL predictions."""
    texts = [t for t in (parse_input_line(line) for line in reader) if t is not None]
    if not texts:
        return
    preds = classify(texts)
    for text, (label, score) in zip(texts, preds):
        writer(format_prediction(text, label, score) + "\n")


if __name__ == "__main__":
    run_predict(sys.stdin, sys.stdout.write)
