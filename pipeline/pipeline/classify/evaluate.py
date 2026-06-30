"""Score the LoRA classifier on the test split and print the before/after table.
Controller-run (heavy). Heavy deps imported at call time; format_delta_table is pure."""
from __future__ import annotations

import json
import os
from pathlib import Path

from pipeline.classify.metrics import accuracy, macro_f1, per_class_f1
from pipeline.classify.models import ClfReport, load_examples, load_label_map

_REPO_ROOT = Path(__file__).parents[3]
CLF_DATA_DIR = _REPO_ROOT / "data" / "processed" / "cuad_clf"
MODEL_DIR = _REPO_ROOT / "models" / "cuad_clf"
BASE_MODEL = os.environ.get("CLF_BASE_MODEL", "microsoft/deberta-v3-base")
MAX_LEN = 256


def format_delta_table(baseline: ClfReport, lora: ClfReport) -> str:
    rows = [("macro_f1", baseline.macro_f1, lora.macro_f1),
            ("accuracy", baseline.accuracy, lora.accuracy)]
    lines = [f"{'metric':<12} {'baseline':>10} {'lora':>10} {'delta':>10}"]
    for name, b, lv in rows:
        lines.append(f"{name:<12} {b:>10.4f} {lv:>10.4f} {lv - b:>+10.4f}")
    return "\n".join(lines)


def run_eval(data_dir: Path = CLF_DATA_DIR, model_dir: Path = MODEL_DIR) -> ClfReport:
    import torch
    from peft import PeftModel
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    labels = load_label_map(data_dir / "label_map.json")
    id2label = dict(enumerate(labels))
    test = load_examples(data_dir / "test.jsonl")

    tok = AutoTokenizer.from_pretrained(str(model_dir))
    cfg_path = model_dir / "adapter_config.json"
    base_name = BASE_MODEL
    if cfg_path.exists():
        base_name = json.loads(cfg_path.read_text()).get("base_model_name_or_path") or BASE_MODEL
    base = AutoModelForSequenceClassification.from_pretrained(
        base_name, num_labels=len(labels), id2label=id2label,
        label2id={lbl: i for i, lbl in enumerate(labels)},
    )
    model = PeftModel.from_pretrained(base, str(model_dir))
    model.eval()

    y_true, y_pred = [], []
    with torch.no_grad():
        for e in test:
            enc = tok(e.text, truncation=True, max_length=MAX_LEN, return_tensors="pt")
            logits = model(**enc).logits[0]
            y_pred.append(id2label[int(logits.argmax())])
            y_true.append(e.clause_type)

    report = ClfReport(
        name="lora", model=BASE_MODEL,
        macro_f1=macro_f1(y_true, y_pred, labels), accuracy=accuracy(y_true, y_pred),
        per_class_f1=per_class_f1(y_true, y_pred, labels), n_test=len(test),
    )
    out = _REPO_ROOT / "evals" / "reports" / "clf_lora.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(report.model_dump_json(indent=2) + "\n", encoding="utf-8")

    baseline_path = _REPO_ROOT / "evals" / "reports" / "clf_baseline.json"
    if baseline_path.exists():
        baseline = ClfReport.model_validate(json.loads(baseline_path.read_text()))
        print(format_delta_table(baseline, report))
    print(f"clf-eval: macro_f1={report.macro_f1:.4f} accuracy={report.accuracy:.4f}")
    return report


if __name__ == "__main__":
    run_eval()
