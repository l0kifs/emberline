"""Wire contract between the extension and the server.

The extension forwards cursor context and nothing else -- no prompt assembly, no
caching, no ranking. Everything here is either raw editor state or a knob the
user set.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class CompleteRequest(BaseModel):
    session_id: str = Field(
        description="Stable per-document id (the document URI). Scopes superseding, "
        "so two editors typing at once do not abort each other."
    )
    prefix: str = Field(description="Text before the cursor. Server truncates; send what you have.")
    suffix: str = Field(default="", description="Text after the cursor.")
    language_id: str = Field(default="", description="VS Code languageId, e.g. 'typescript'.")
    path: str = Field(default="", description="Absolute path of the current file.")
    open_paths: list[str] = Field(
        default_factory=list,
        description="Paths of other open documents, most-recent first. Paths only -- the "
        "server reads and chunks them itself. Used for cross-file context.",
    )


class CompleteResponse(BaseModel):
    completion: str
    cached: bool = False
    superseded: bool = False
    """True when a newer keystroke landed before this one finished. The extension
    should render nothing; a newer request is already in flight."""
    stop_type: str | None = None
    timings: dict[str, float] = Field(default_factory=dict)


class AcceptRequest(BaseModel):
    """Reports an accepted completion, to be retrieved as a few-shot example later."""

    prefix: str
    completion: str
    language_id: str = ""


class HealthResponse(BaseModel):
    status: str
    llama: str
    cache_entries: int
    cache_hits: int
    cache_misses: int
