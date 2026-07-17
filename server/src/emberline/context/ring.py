"""Cross-file context: a ring buffer of chunks from other open files.

Modelled on llama.vim's ring buffer, which ranks chunks by plain line-set overlap
rather than embeddings. That choice is deliberate and worth preserving: ranking
runs on every keystroke, so it has to be effectively free. Embeddings are reserved
for the accepted-example store, where lookups are rarer and the text is short.

Chunks land in ``/infill``'s ``input_extra``, which llama.cpp inserts ahead of the
FIM prefix.
"""

from __future__ import annotations

import logging
import re
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

_TOKEN_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{2,}")
_MAX_FILE_BYTES = 512 * 1024
"""Skip anything bigger; it is a bundle, a lockfile, or generated."""


def _tokens(text: str) -> set[str]:
    return set(_TOKEN_RE.findall(text))


def _similarity(a: set[str], b: set[str]) -> float:
    """Jaccard over identifier-ish tokens."""
    if not a or not b:
        return 0.0
    inter = len(a & b)
    if inter == 0:
        return 0.0
    return inter / len(a | b)


@dataclass(slots=True)
class Chunk:
    filename: str
    text: str
    tokens: set[str]


class RingContext:
    def __init__(self, *, max_chunks: int = 16, chunk_lines: int = 64) -> None:
        self._max_chunks = max_chunks
        self._chunk_lines = chunk_lines
        # path -> (mtime_ns, chunks). Keeps us off the disk on every keystroke.
        self._files: OrderedDict[str, tuple[int, list[Chunk]]] = OrderedDict()
        self._max_files = 32

    def _chunks_for(self, path: str) -> list[Chunk]:
        p = Path(path)
        try:
            stat = p.stat()
        except OSError:
            self._files.pop(path, None)
            return []
        if stat.st_size > _MAX_FILE_BYTES:
            return []

        cached = self._files.get(path)
        if cached is not None and cached[0] == stat.st_mtime_ns:
            self._files.move_to_end(path)
            return cached[1]

        try:
            text = p.read_text(encoding="utf-8", errors="strict")
        except (OSError, UnicodeDecodeError):
            # Binary or unreadable; remember nothing rather than retrying each keystroke.
            self._files[path] = (stat.st_mtime_ns, [])
            return []

        lines = text.splitlines()
        chunks: list[Chunk] = []
        for start in range(0, len(lines), self._chunk_lines):
            body = "\n".join(lines[start : start + self._chunk_lines])
            if not body.strip():
                continue
            chunks.append(Chunk(filename=p.name, text=body, tokens=_tokens(body)))

        self._files[path] = (stat.st_mtime_ns, chunks)
        self._files.move_to_end(path)
        while len(self._files) > self._max_files:
            self._files.popitem(last=False)
        return chunks

    def build(
        self,
        *,
        prefix: str,
        current_path: str,
        open_paths: list[str],
    ) -> list[dict[str, str]]:
        """Rank chunks from other open files against the cursor context."""
        query = _tokens(prefix[-4000:])
        if not query:
            return []

        scored: list[tuple[float, Chunk]] = []
        for path in open_paths:
            if path == current_path:
                continue
            for chunk in self._chunks_for(path):
                score = _similarity(query, chunk.tokens)
                if score > 0.0:
                    scored.append((score, chunk))

        scored.sort(key=lambda pair: pair[0], reverse=True)
        top = scored[: self._max_chunks]
        return [{"filename": c.filename, "text": c.text} for _, c in top]
