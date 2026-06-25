from pipeline.parser.structure import parse_structure

TEXT = (
    "ARTICLE I DEFINITIONS\n"                              # article I
    '"Confidential Information" means non-public data.\n'  # definition
    "Section 1.1 Purpose\n"                                # section 1.1
    "The parties wish to exchange information.\n"
    "Section 1.2 Obligations\n"                            # section 1.2
    "(a) The Receiving Party shall protect it.\n"          # subsection (a)
    "(b) The Receiving Party shall not disclose it.\n"     # subsection (b)
    "ARTICLE II TERM\n"                                    # article II
    "This Agreement lasts three years.\n"
    "EXHIBIT A FORM OF NOTICE\n"                           # exhibit A
    "Notice template here.\n"
)


def _by(nodes, typ):
    return [n for n in nodes if n.type == typ]


def test_offsets_are_exact_for_every_node():
    nodes = parse_structure("doc1", TEXT)
    for n in nodes:
        assert TEXT[n.char_start:n.char_end] == n.text


def test_articles_sections_subsections_definitions_exhibits_detected():
    nodes = parse_structure("doc1", TEXT)
    assert {n.number for n in _by(nodes, "article")} == {"I", "II"}
    assert {n.number for n in _by(nodes, "section")} == {"1.1", "1.2"}
    assert {n.number for n in _by(nodes, "subsection")} == {"(a)", "(b)"}
    assert {n.heading for n in _by(nodes, "definition")} == {"Confidential Information"}
    assert {n.number for n in _by(nodes, "exhibit")} == {"A"}


def test_hierarchy_parents_are_correct():
    nodes = parse_structure("doc1", TEXT)
    by_id = {n.node_id: n for n in nodes}
    art1 = next(n for n in nodes if n.type == "article" and n.number == "I")
    sec12 = next(n for n in nodes if n.number == "1.2")
    sub_a = next(n for n in nodes if n.number == "(a)")
    assert by_id[sec12.parent_id] is art1            # 1.2 sits under Article I
    assert by_id[sub_a.parent_id] is sec12           # (a) sits under 1.2
    assert sub_a.depth == sec12.depth + 1
