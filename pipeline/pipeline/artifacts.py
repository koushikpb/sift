"""Pydantic models mirroring schemas/*.json — the canonical artifact types."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

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
    parent_id: str | None = None
    type: NodeType
    number: str | None = None
    heading: str | None = None
    text: str
    char_start: int
    char_end: int
    depth: int


class ParsedDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")
    doc_id: str
    source: Source
    title: str | None = None
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
    clause_type: str | None = None
    hypothesis: str | None = None
    nli_label: Literal["entailment", "contradiction", "not_mentioned"] | None = None
    spans: list[Span] = []


class ClauseLabel(BaseModel):
    """Mirrors schemas/clause-label.schema.json.

    char_end > char_start is enforced here (JSON Schema cannot express it).
    """

    model_config = ConfigDict(extra="forbid")
    doc_id: str = Field(min_length=1)
    char_start: int = Field(ge=0)
    char_end: int = Field(ge=1)
    label: str = Field(min_length=1)
    score: float = Field(ge=0.0, le=1.0)

    @model_validator(mode="after")
    def _char_end_gt_start(self) -> ClauseLabel:
        if self.char_end <= self.char_start:
            raise ValueError(
                f"char_end ({self.char_end}) must be > char_start ({self.char_start})"
            )
        return self
