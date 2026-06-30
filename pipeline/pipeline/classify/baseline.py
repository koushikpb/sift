"""Few-shot prompted-LLM clause classifier — the 'before' baseline. Calls NIM's
OpenAI-compatible chat endpoint via requests, paced under LLM_RPM."""
from __future__ import annotations

import os
import time
from pathlib import Path

import requests

from pipeline.classify.metrics import accuracy, macro_f1, per_class_f1
from pipeline.classify.models import ClfReport, load_examples, load_label_map

UNMATCHED = "__unmatched__"
_REPO_ROOT = Path(__file__).parents[3]


def error_guard(errors: int, n: int, threshold: float = 0.03) -> None:
    """Raise if transport errors exceed the threshold — a high error rate deflates the
    baseline's macro-F1 and invalidates the LoRA-vs-prompt comparison."""
    rate = errors / n if n else 0.0
    if rate > threshold:
        raise RuntimeError(
            f"baseline: {errors}/{n} ({rate:.1%}) items failed in transport (> {threshold:.0%}) — "
            "the baseline macro-F1 would be deflated and the comparison invalid. "
            "Lower LLM_RPM or check the provider, then re-run."
        )
_BASE_URL = os.environ.get("LLM_BASE_URL", "https://integrate.api.nvidia.com/v1")
_MODEL = os.environ.get("LLM_MODEL", "meta/llama-3.3-70b-instruct")


def build_prompt(text: str, labels: list[str], fewshot: list[tuple[str, str]]) -> tuple[str, str]:
    labels_block = "\n".join(f"- {lab}" for lab in labels)
    shots = "".join(f"\nText: {t}\nLabel: {lab}\n" for t, lab in fewshot)
    system = (
        "You are a contract clause classifier. Given a clause excerpt, reply with EXACTLY ONE "
        "label name from this list, copied verbatim, and nothing else:\n"
        f"{labels_block}\n"
        "Reply with only the label text — no punctuation, no explanation."
        + (f"\n\nExamples:{shots}" if shots else "")
    )
    user = f"Text: {text}\nLabel:"
    return system, user


def parse_label(answer: str, labels: list[str]) -> str:
    a = answer.strip()
    for lab in labels:  # exact
        if a == lab:
            return lab
    low = a.lower()
    for lab in labels:  # case-insensitive substring (model may add punctuation/prefix)
        if lab.lower() in low:
            return lab
    return UNMATCHED


def _min_interval_ms() -> float:
    rpm = os.environ.get("LLM_RPM")
    if rpm:
        try:
            n = float(rpm)
            if n > 0:
                return 60000.0 / n
        except ValueError:
            pass
    return 0.0


def _classify_one(system: str, user: str) -> str:
    resp = requests.post(
        f"{_BASE_URL}/chat/completions",
        headers={"Authorization": f"Bearer {os.environ.get('LLM_API_KEY', '')}"},
        json={"model": _MODEL, "temperature": 0,
              "messages": [{"role": "system", "content": system},
                           {"role": "user", "content": user}]},
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"] or ""


def run_baseline(
    data_dir: Path | None = None, fewshot_n: int = 2, out: Path | None = None
) -> ClfReport:
    data_dir = data_dir or (_REPO_ROOT / "data" / "processed" / "cuad_clf")
    labels = load_label_map(data_dir / "label_map.json")
    train = load_examples(data_dir / "train.jsonl")
    test = load_examples(data_dir / "test.jsonl")

    # Fair baseline: a few in-context examples per class (drawn from TRAIN, never TEST).
    by_cls: dict[str, list[str]] = {}
    for e in train:
        by_cls.setdefault(e.clause_type, []).append(e.text)
    fewshot = [(by_cls[lab][i], lab) for lab in labels
               for i in range(min(fewshot_n, len(by_cls.get(lab, []))))]

    interval = _min_interval_ms() / 1000.0
    y_true, y_pred = [], []
    next_at = 0.0
    errors = 0
    for i, e in enumerate(test):
        if interval:
            wait = next_at - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            next_at = time.monotonic() + interval
        system, user = build_prompt(e.text, labels, fewshot)
        try:
            pred = parse_label(_classify_one(system, user), labels)
        except Exception as exc:  # network/5xx -> recorded as a miss, never aborts the run
            print(f"  baseline item {i} transport error: {exc}")
            errors += 1
            pred = UNMATCHED
        y_true.append(e.clause_type)
        y_pred.append(pred)
        if (i + 1) % 25 == 0:
            print(f"  baseline {i + 1}/{len(test)}")

    error_guard(errors, len(test))

    report = ClfReport(
        name="prompted_baseline", model=_MODEL,
        macro_f1=macro_f1(y_true, y_pred, labels), accuracy=accuracy(y_true, y_pred),
        per_class_f1=per_class_f1(y_true, y_pred, labels), n_test=len(test),
    )
    out = out or (_REPO_ROOT / "evals" / "reports" / "clf_baseline.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(report.model_dump_json(indent=2) + "\n", encoding="utf-8")
    print(f"clf-baseline: macro_f1={report.macro_f1:.4f} accuracy={report.accuracy:.4f} "
          f"(transport_errors={errors})")
    return report


if __name__ == "__main__":
    run_baseline()
