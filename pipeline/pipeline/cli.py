"""Phase 0 pipeline CLI: `ingest` (download+normalize) and `parse` (add hierarchy nodes)."""
from __future__ import annotations

import sys
from pathlib import Path

from pipeline.ingest.contractnli import load_contractnli, normalize_contractnli
from pipeline.ingest.cuad import load_cuad_qa, normalize_cuad
from pipeline.parse_docs import parse_raw_file

ROOT = Path(__file__).resolve().parents[2]
PROCESSED = ROOT / "data" / "processed"


def _write_jsonl(path: Path, models) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        for m in models:
            fh.write(m.model_dump_json() + "\n")
    return len(models)


def ingest() -> None:
    # CUAD (HF download; cap for a fast first pass — raise/remove the limit for the full corpus).
    docs, gold = normalize_cuad(load_cuad_qa(limit=2000))
    print(f"cuad: {_write_jsonl(PROCESSED / 'cuad' / 'raw.jsonl', docs)} docs, "
          f"{_write_jsonl(PROCESSED / 'cuad' / 'gold.jsonl', gold)} gold")

    # ContractNLI (expects data/raw/contractnli/test.json downloaded per DATA.md).
    cnli_path = ROOT / "data" / "raw" / "contractnli" / "test.json"
    if cnli_path.exists():
        cdocs, cgold = normalize_contractnli(load_contractnli(str(cnli_path)))
        print(f"contractnli: {_write_jsonl(PROCESSED / 'contractnli' / 'raw.jsonl', cdocs)} docs, "
              f"{_write_jsonl(PROCESSED / 'contractnli' / 'gold.jsonl', cgold)} gold")
    else:
        print(f"contractnli: SKIP — download the split to {cnli_path} (see DATA.md)")


def parse() -> None:
    for source in ("cuad", "contractnli"):
        raw = PROCESSED / source / "raw.jsonl"
        if raw.exists():
            n = parse_raw_file(raw, PROCESSED / source / "docs.jsonl")
            print(f"{source}: parsed {n} docs -> docs.jsonl")


if __name__ == "__main__":
    {"ingest": ingest, "parse": parse}[sys.argv[1]]()
