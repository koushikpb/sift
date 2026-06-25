"""Heuristic structure-aware parser: contract text -> hierarchy of Nodes.

Detects ARTICLE / Section N.M / (a) subsections / "Term" means definitions / EXHIBIT.
Each structural node spans from its heading line to the next heading of the same-or-higher
level, so a parent's text contains its children's text. Definitions are inline leaves.
Every node satisfies: text == source[char_start:char_end].
"""
from __future__ import annotations

import re

from pipeline.artifacts import Node

_ROMAN = r"[IVXLCDM]+"
_ARTICLE = re.compile(rf"^[ \t]*ARTICLE\s+({_ROMAN}|\d+)\b[.:\-]?[ \t]*(.*)$")
_EXHIBIT = re.compile(r"^[ \t]*(?:EXHIBIT|SCHEDULE|ANNEX|APPENDIX)\s+([A-Z0-9]+)\b[.:\-]?[ \t]*(.*)$")  # noqa: E501
_SECTION_KW = re.compile(r"^[ \t]*Section\s+(\d+(?:\.\d+)*)\b[.:\-]?[ \t]*(.*)$")
_SECTION_NUM = re.compile(r"^[ \t]*(\d+(?:\.\d+)+)[.)]?\s+(\S.*)$")
_SECTION_TOP = re.compile(r"^[ \t]*(\d+)\.\s+(\S.*)$")
_SUBSEC = re.compile(r"^[ \t]*\(([a-z]{1,3}|[ivxlc]+)\)\s+(\S.*)$")
_DEFINITION = re.compile(r'["\u201c\u201d]([^"\u201c\u201d]{1,80})["\u201c\u201d]\s+means\b', re.IGNORECASE)  # noqa: E501


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")


def _classify(line: str):
    """Return (type, level_or_None, number, heading) for a heading line, else None."""
    m = _ARTICLE.match(line)
    if m:
        return ("article", 0, m.group(1), m.group(2).strip())
    m = _EXHIBIT.match(line)
    if m:
        return ("exhibit", 0, m.group(1), m.group(2).strip())
    m = _SECTION_KW.match(line)
    if m:
        return ("section", m.group(1).count(".") + 1, m.group(1), m.group(2).strip())
    m = _SECTION_NUM.match(line)
    if m:
        return ("section", m.group(1).count(".") + 1, m.group(1), m.group(2).strip())
    m = _SECTION_TOP.match(line)
    if m:
        return ("section", 1, m.group(1), m.group(2).strip())
    m = _SUBSEC.match(line)
    if m:
        return ("subsection", None, f"({m.group(1)})", m.group(2).strip())
    return None


def parse_structure(doc_id: str, text: str) -> list[Node]:
    # 1) Collect heading lines with their char offsets and resolved levels.
    heads: list[dict] = []
    offset = 0
    last_section_level = 0
    for raw_line in text.splitlines(keepends=True):
        c = _classify(raw_line)
        if c:
            typ, level, number, heading = c
            if typ == "subsection":
                level = last_section_level + 1
            else:
                last_section_level = level
            heads.append({"start": offset, "type": typ, "level": level,
                          "number": number, "heading": heading})
        offset += len(raw_line)

    # 2) Segment + nest structural headings with a level-stack.
    nodes: list[Node] = []
    stack: list[tuple[int, str]] = []  # (level, node_id)
    used: dict[str, int] = {}
    n = len(heads)
    for i, h in enumerate(heads):
        end = len(text)
        for j in range(i + 1, n):
            if heads[j]["level"] <= h["level"]:
                end = heads[j]["start"]
                break
        while stack and stack[-1][0] >= h["level"]:
            stack.pop()
        parent_id = stack[-1][1] if stack else None
        depth = len(stack)
        base = f"{doc_id}/{h['type']}-{_slug(h['number'] or h['heading'] or str(i))}"
        k = used.get(base, 0)
        used[base] = k + 1
        node_id = base if k == 0 else f"{base}-{k}"
        nodes.append(Node(
            node_id=node_id, parent_id=parent_id, type=h["type"],
            number=h["number"], heading=h["heading"] or None,
            text=text[h["start"]:end], char_start=h["start"], char_end=end, depth=depth,
        ))
        stack.append((h["level"], node_id))

    # 3) Definitions: inline leaves attached to the deepest containing structural node.
    #    Only structural nodes (not other definitions) are eligible as containers so that
    #    sibling definitions in the same section are not incorrectly nested into each other.
    structural_nodes = nodes[:]  # snapshot before we start appending definitions
    for dm in _DEFINITION.finditer(text):
        ds, de = dm.start(), dm.end()
        dot = text.find(".", de)
        dend = dot + 1 if dot != -1 else de
        container = None
        for node in structural_nodes:
            if node.char_start <= ds < node.char_end and (
                container is None or node.depth >= container.depth
            ):
                container = node
        term = dm.group(1)
        def_base = f"{doc_id}/definition-{_slug(term)}"
        k = used.get(def_base, 0)
        used[def_base] = k + 1
        def_node_id = def_base if k == 0 else f"{def_base}-{k}"
        nodes.append(Node(
            node_id=def_node_id,
            parent_id=container.node_id if container else None,
            type="definition", number=None, heading=term,
            text=text[ds:dend], char_start=ds, char_end=dend,
            depth=(container.depth + 1 if container else 0),
        ))

    nodes.sort(key=lambda x: (x.char_start, x.depth))
    return nodes
