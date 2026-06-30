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


def apply_floor(examples: list[ClfExample], floor: int) -> tuple[list[ClfExample], list[str]]:
    counts = Counter(e.clause_type for e in examples)
    kept_labels = sorted(c for c, n in counts.items() if n >= floor)
    kept_set = set(kept_labels)
    kept = [e for e in examples if e.clause_type in kept_set]
    return kept, kept_labels


def split_by_doc(
    examples: list[ClfExample], seed: int, ratios: tuple[float, float, float]
) -> dict[str, list[ClfExample]]:
    """Partition DOCUMENTS into train/val/test (no doc in two splits). Greedy assignment
    in shuffled doc order toward the target ratios; then a coverage pass moves one doc so
    every class present in the data appears in both train and test."""
    by_doc: dict[str, list[ClfExample]] = defaultdict(list)
    for e in examples:
        by_doc[e.doc_id].append(e)
    docs = sorted(by_doc)  # deterministic base order
    rng = random.Random(seed)
    rng.shuffle(docs)

    n = len(docs)
    n_train = int(round(ratios[0] * n))
    n_val = int(round(ratios[1] * n))
    assign = {d: ("train" if i < n_train else "val" if i < n_train + n_val else "test")
              for i, d in enumerate(docs)}

    def classes_in(split: str) -> set[str]:
        return {e.clause_type for d, s in assign.items() if s == split for e in by_doc[d]}

    all_classes = {e.clause_type for e in examples}
    # Coverage pass: ensure every class appears in train AND test by re-homing a donor doc.
    for split in ("train", "test"):
        missing = all_classes - classes_in(split)
        for cls in sorted(missing):
            donor = next(
                (d for d in docs
                 if assign[d] != split and any(e.clause_type == cls for e in by_doc[d])
                 and sum(1 for x in docs if assign[x] == assign[d]) > 1),
                None,
            )
            if donor is not None:
                assign[donor] = split

    out: dict[str, list[ClfExample]] = {"train": [], "val": [], "test": []}
    for d in docs:
        out[assign[d]].extend(by_doc[d])
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
