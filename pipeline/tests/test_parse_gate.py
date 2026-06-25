import json
from pathlib import Path

from pipeline.artifacts import ParsedDocument
from pipeline.parser.structure import parse_structure

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
CONTRACTS = sorted((FIXTURES / "contracts").glob("*.txt"))


def _parse(path: Path):
    text = path.read_text(encoding="utf-8")
    return text, parse_structure(path.stem, text)


def test_we_have_ten_sample_contracts():
    assert len(CONTRACTS) == 10


def test_invariants_hold_on_every_contract():
    for path in CONTRACTS:
        text, nodes = _parse(path)
        assert nodes, f"{path.name}: parser found no structure"
        by_id = {n.node_id: n for n in nodes}
        for n in nodes:
            # Citation invariant.
            assert text[n.char_start:n.char_end] == n.text, f"{path.name}:{n.node_id} offset drift"
            # Depth is consistent with the parent chain.
            if n.parent_id is None:
                assert n.depth == 0, f"{path.name}:{n.node_id} root depth != 0"
            else:
                # Every parent reference resolves, and depth steps by exactly one.
                assert n.parent_id in by_id, f"{path.name}:{n.node_id} dangling parent"
                parent = by_id[n.parent_id]
                assert n.depth == parent.depth + 1, f"{path.name}:{n.node_id} depth drift"
        # Each ParsedDocument validates against the schema after parsing.
        ParsedDocument(
            doc_id=path.stem, source="contractnli", contract_type="nda",
            raw_text=text, char_length=len(text),
            raw_sha256="0" * 64, nodes=nodes,
        )


def test_node_count_snapshot():
    snapshot = json.loads((FIXTURES / "expected_hierarchy.json").read_text())
    actual = {p.stem: len(_parse(p)[1]) for p in CONTRACTS}
    assert actual == snapshot
