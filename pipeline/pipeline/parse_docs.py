"""Parse driver: raw.jsonl (no nodes) -> docs.jsonl (with hierarchy nodes)."""
from __future__ import annotations

from pathlib import Path

from pipeline.artifacts import ParsedDocument
from pipeline.parser.structure import parse_structure


def parse_document(doc: ParsedDocument) -> ParsedDocument:
    return doc.model_copy(update={"nodes": parse_structure(doc.doc_id, doc.raw_text)})


def parse_raw_file(in_path: str | Path, out_path: str | Path) -> int:
    count = 0
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    with open(in_path, encoding="utf-8") as fin, open(out_path, "w", encoding="utf-8") as fout:
        for line in fin:
            line = line.strip()
            if not line:
                continue
            doc = parse_document(ParsedDocument.model_validate_json(line))
            fout.write(doc.model_dump_json() + "\n")
            count += 1
    return count
