"""Extract CUAD clause spans into a document-grouped train/val/test classification set."""
from __future__ import annotations

import random
from collections import Counter, defaultdict
from pathlib import Path

from pipeline.classify.models import ClfExample, save_examples, save_label_map
from pipeline.ingest.cuad import _clause_type, _doc_id, load_cuad_qa

FLOOR = 50
SEED = 42
RATIOS = (0.70, 0.15, 0.15)
CLF_DATA_DIR = Path(__file__).parents[3] / "data" / "processed" / "cuad_clf"


def records_to_examples(records: list[dict]) -> list[ClfExample]:
    out: list[ClfExample] = []
    for rec in records:
        clause_type = _clause_type(rec["question"])
        if clause_type is None:
            continue
        doc_id = _doc_id(rec["title"])
        for text in (rec.get("answers", {}) or {}).get("text", []) or []:
            t = text.strip()
            if t:
                out.append(ClfExample(text=t, clause_type=clause_type, doc_id=doc_id))
    return out


def apply_floor(
    examples: list[ClfExample], floor: int, min_docs: int = 2
) -> tuple[list[ClfExample], list[str]]:
    by_class_examples: Counter[str] = Counter(e.clause_type for e in examples)
    by_class_docs: dict[str, set[str]] = defaultdict(set)
    for e in examples:
        by_class_docs[e.clause_type].add(e.doc_id)
    # A class needs >= floor examples AND spans >= min_docs documents, else it cannot
    # appear in both train and test under a document-grouped split.
    kept_labels = sorted(
        c for c in by_class_examples
        if by_class_examples[c] >= floor and len(by_class_docs[c]) >= min_docs
    )
    kept_set = set(kept_labels)
    kept = [e for e in examples if e.clause_type in kept_set]
    return kept, kept_labels


def split_by_doc(
    examples: list[ClfExample], seed: int, ratios: tuple[float, float, float]
) -> dict[str, list[ClfExample]]:
    """Partition DOCUMENTS into train/val/test (no doc in two splits). Coverage-first:
    pin one doc per class to train and a different one to test, then fill the rest toward
    the ratio targets (val absorbs the slack). Raises if any class cannot reach both
    train and test (i.e. it spans < 2 docs — guard with apply_floor's min_docs)."""
    by_doc: dict[str, list[ClfExample]] = defaultdict(list)
    for e in examples:
        by_doc[e.doc_id].append(e)
    docs = sorted(by_doc)
    rng = random.Random(seed)
    rng.shuffle(docs)

    doc_classes = {d: {e.clause_type for e in by_doc[d]} for d in docs}
    all_classes = sorted({c for cs in doc_classes.values() for c in cs})

    assign: dict[str, str] = {}
    # Coverage-first anchoring: each class gets >=1 doc in train and a different one in test.
    for cls in all_classes:
        cls_docs = [d for d in docs if cls in doc_classes[d]]
        tr = (next((d for d in cls_docs if assign.get(d) == "train"), None)
              or next((d for d in cls_docs if d not in assign), None)
              or cls_docs[0])
        assign[tr] = "train"
        te = (next((d for d in cls_docs if assign.get(d) == "test"), None)
              or next((d for d in cls_docs if d != tr and d not in assign), None)
              or next((d for d in cls_docs if d != tr), None))
        if te is not None:
            assign[te] = "test"

    # Fill the remaining docs toward ratio targets; val takes the slack.
    n = len(docs)
    want_train = round(ratios[0] * n)
    want_val = round(ratios[1] * n)
    counts = Counter(assign.values())
    for d in docs:
        if d in assign:
            continue
        if counts["train"] < want_train:
            s = "train"
        elif counts["val"] < want_val:
            s = "val"
        else:
            s = "test"
        assign[d] = s
        counts[s] += 1

    out: dict[str, list[ClfExample]] = {"train": [], "val": [], "test": []}
    for d in docs:
        out[assign[d]].extend(by_doc[d])

    tr_classes = {e.clause_type for e in out["train"]}
    te_classes = {e.clause_type for e in out["test"]}
    missing = set(all_classes) - (tr_classes & te_classes)
    if missing:
        raise ValueError(
            f"split_by_doc: classes missing from train AND test: {sorted(missing)} "
            "(each class must span >= 2 documents; raise the example/doc floor)"
        )
    return out


def run_extract(floor: int = FLOOR, seed: int = SEED, out_dir: Path = CLF_DATA_DIR) -> None:
    examples = records_to_examples(load_cuad_qa())
    kept, labels = apply_floor(examples, floor)
    splits = split_by_doc(kept, seed, RATIOS)
    out_dir.mkdir(parents=True, exist_ok=True)
    for name in ("train", "val", "test"):
        save_examples(out_dir / f"{name}.jsonl", splits[name])
    save_label_map(out_dir / "label_map.json", labels)
    print(f"clf-extract: {len(kept)} examples, {len(labels)} classes; "
          f"train/val/test = {len(splits['train'])}/{len(splits['val'])}/{len(splits['test'])}")


if __name__ == "__main__":
    run_extract()
