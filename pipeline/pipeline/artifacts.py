"""Pydantic models mirroring schemas/*.json — the canonical artifact types."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

NodeType = Literal[
    "preamble", "recital", "article", "section",
    "subsection", "definition", "exhibit", "clause",
]
Source = Literal["cuad", "contractnli"]


class Span(BaseModel):
    model_config = ConfigDict(extra="forbid")
    char_start: int
    char_end: int
    quote: str


class Node(BaseModel):
    model_config = ConfigDict(extra="forbid")
    node_id: str
    parent_id: Optional[str] = None
    type: NodeType
    number: Optional[str] = None
    heading: Optional[str] = None
    text: str
    char_start: int
    char_end: int
    depth: int


class ParsedDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")
    doc_id: str
    source: Source
    title: Optional[str] = None
    contract_type: str
    raw_text: str
    char_length: int
    raw_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    nodes: list[Node] = []


class GoldLabel(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label_id: str
    doc_id: str
    source: Source
    kind: Literal["clause_span", "nli"]
    clause_type: Optional[str] = None
    hypothesis: Optional[str] = None
    nli_label: Optional[Literal["entailment", "contradiction", "not_mentioned"]] = None
    spans: list[Span] = []
