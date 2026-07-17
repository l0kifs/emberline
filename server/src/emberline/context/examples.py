"""Accepted-completion store with semantic retrieval.

The concept comes from kei, but the implementation is a rewrite rather than a
port. kei's version loaded every row on every query, JSON-decoded each embedding,
and scored with a pure-Python cosine loop; it also had no similarity floor, so
top-k always returned k rows however irrelevant they were. Here: embeddings are
stored as float32 blobs, scored as one numpy matmul against a resident matrix,
and filtered by a threshold.

Embedding happens off the event loop -- kei called fastembed synchronously inside
an ``async def``, which blocks every other request including health checks, and
the first call also pays the model load.
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
from dataclasses import dataclass
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS examples (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    prefix      TEXT NOT NULL,
    completion  TEXT NOT NULL,
    language_id TEXT NOT NULL DEFAULT '',
    embedding   BLOB NOT NULL,
    created_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_examples_language ON examples(language_id);
"""

_QUERY_TAIL_CHARS = 512
"""Only the text right at the cursor carries retrieval signal."""


@dataclass(slots=True)
class Example:
    prefix: str
    completion: str
    language_id: str


class ExampleStore:
    def __init__(
        self,
        *,
        db_path: Path,
        model_name: str,
        cache_dir: Path,
        dims: int,
        top_k: int,
        min_similarity: float,
    ) -> None:
        self._db_path = db_path
        self._model_name = model_name
        self._cache_dir = cache_dir
        self._dims = dims
        self._top_k = top_k
        self._min_similarity = min_similarity
        self._model = None
        self._conn: sqlite3.Connection | None = None
        # Resident, L2-normalised. Retrieval is then a single matmul.
        self._matrix: np.ndarray = np.zeros((0, dims), dtype=np.float32)
        self._rows: list[Example] = []
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._cache_dir.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self._db_path, check_same_thread=False)
        self._conn.executescript(_SCHEMA)
        self._conn.commit()
        await asyncio.to_thread(self._load_model)
        self._reload_matrix()
        log.info("example store ready: %d examples", len(self._rows))

    def _load_model(self) -> None:
        from fastembed import TextEmbedding

        self._model = TextEmbedding(model_name=self._model_name, cache_dir=str(self._cache_dir))
        # Warm up: the first embed pays ONNX graph init, and we want that cost at
        # startup rather than on a keystroke.
        list(self._model.embed(["warmup"]))

    async def aclose(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    async def _embed(self, text: str) -> np.ndarray:
        def run() -> np.ndarray:
            assert self._model is not None
            [vec] = self._model.embed([text])
            arr = np.asarray(vec, dtype=np.float32)
            norm = np.linalg.norm(arr)
            return arr / norm if norm else arr

        return await asyncio.to_thread(run)

    def _reload_matrix(self) -> None:
        assert self._conn is not None
        cur = self._conn.execute(
            "SELECT prefix, completion, language_id, embedding FROM examples ORDER BY id"
        )
        rows: list[Example] = []
        vecs: list[np.ndarray] = []
        for prefix, completion, language_id, blob in cur:
            rows.append(Example(prefix, completion, language_id))
            vecs.append(np.frombuffer(blob, dtype=np.float32))
        self._rows = rows
        self._matrix = (
            np.vstack(vecs).astype(np.float32)
            if vecs
            else np.zeros((0, self._dims), dtype=np.float32)
        )

    async def add(self, *, prefix: str, completion: str, language_id: str) -> None:
        if not completion.strip():
            return
        query = prefix[-_QUERY_TAIL_CHARS:]
        vec = await self._embed(query)
        async with self._lock:
            assert self._conn is not None
            self._conn.execute(
                "INSERT INTO examples (prefix, completion, language_id, embedding, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (
                    query,
                    completion,
                    language_id,
                    vec.tobytes(),
                    asyncio.get_running_loop().time(),
                ),
            )
            self._conn.commit()
            self._reload_matrix()

    async def search(self, *, prefix: str, language_id: str) -> list[Example]:
        if not self._rows:
            return []
        query = await self._embed(prefix[-_QUERY_TAIL_CHARS:])
        async with self._lock:
            matrix = self._matrix
            rows = self._rows
        if matrix.shape[0] == 0:
            return []

        scores = matrix @ query  # both sides are L2-normalised, so this is cosine
        order = np.argsort(-scores)[: self._top_k]
        hits: list[Example] = []
        for idx in order:
            if scores[idx] < self._min_similarity:
                break
            row = rows[int(idx)]
            if language_id and row.language_id and row.language_id != language_id:
                continue
            hits.append(row)
        return hits

    def count(self) -> int:
        return len(self._rows)
