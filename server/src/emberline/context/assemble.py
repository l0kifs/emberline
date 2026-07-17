"""Turns raw editor state into an /infill request.

Both context mechanisms land in ``input_extra``, which llama.cpp inserts ahead of
the FIM prefix: cross-file chunks (ring buffer) and previously accepted
completions (embedding retrieval). They are different features that happen to
share a delivery slot.
"""

from __future__ import annotations

import hashlib
import logging

from emberline.config import Settings
from emberline.context.examples import ExampleStore
from emberline.context.ring import RingContext
from emberline.runtime.infill import InfillRequest

log = logging.getLogger(__name__)


def _digest(parts: list[str]) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update(p.encode("utf-8", "surrogatepass"))
        h.update(b"\x00")
    return h.hexdigest()[:16]


class Assembler:
    def __init__(
        self,
        settings: Settings,
        *,
        ring: RingContext | None,
        examples: ExampleStore | None,
    ) -> None:
        self._s = settings
        self._ring = ring
        self._examples = examples

    async def build(
        self,
        *,
        prefix: str,
        suffix: str,
        language_id: str,
        path: str,
        open_paths: list[str],
    ) -> tuple[InfillRequest, str]:
        """Returns the /infill request and a digest of its extra context.

        The digest goes into the cache key, so a cache hit cannot silently serve a
        completion built from different surrounding context.
        """
        # Keep the tail of the prefix and the head of the suffix -- the text next to
        # the cursor is what carries signal. llama.cpp clamps to 3:1 of n_batch
        # anyway, so anything beyond this is serialized for nothing.
        prefix = prefix[-self._s.max_prefix_chars :]
        suffix = suffix[: self._s.max_suffix_chars]

        extra: list[dict[str, str]] = []

        if self._examples is not None and self._s.examples_enabled:
            try:
                hits = await self._examples.search(prefix=prefix, language_id=language_id)
                for ex in hits:
                    extra.append(
                        {
                            "filename": "accepted_example",
                            "text": f"{ex.prefix}{ex.completion}",
                        }
                    )
            except Exception:
                # Retrieval is an enhancement; never fail a completion over it.
                log.exception("example retrieval failed, continuing without")

        if self._ring is not None and self._s.ring_enabled:
            try:
                extra.extend(
                    self._ring.build(prefix=prefix, current_path=path, open_paths=open_paths)
                )
            except Exception:
                log.exception("ring context failed, continuing without")

        req = InfillRequest(
            prefix=prefix,
            suffix=suffix,
            extra=extra,
            n_predict=self._s.n_predict,
            t_max_predict_ms=self._s.t_max_predict_ms,
            temperature=self._s.temperature,
            top_p=self._s.top_p,
            top_k=self._s.top_k,
        )
        return req, _digest([e["text"] for e in extra])
