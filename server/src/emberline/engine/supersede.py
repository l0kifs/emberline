"""Newest-wins request arbitration.

One model, one GPU: requests must serialize. But while a request waits its turn
the user has usually typed again, making it garbage on arrival -- GitHub reports
roughly half of issued completion requests are "typed through" this way. So we
serialize on a lock *and* drop anything that went stale while queued.

Scoped per session (one editor document), not global: kei's equivalent used a
single global counter, which is correct for one desktop user but means a second
client's keystroke would abort the first client's generation.
"""

from __future__ import annotations

import asyncio
import logging

log = logging.getLogger(__name__)


class Supersede:
    """Generation counters, scoped per session.

    Pair with :attr:`model_lock`, which is global on purpose: llama-server runs
    with a single slot (``-np 1``), so there is exactly one KV cache. Letting two
    documents generate concurrently would make them evict each other's cached
    prefix and turn every request into a full recompute -- measured at ~1.24s
    versus ~67ms for a cache hit.
    """

    def __init__(self) -> None:
        self._generations: dict[str, int] = {}
        self.model_lock = asyncio.Lock()

    def claim(self, session_id: str) -> int:
        """Register a new request, invalidating older ones in the same session."""
        gen = self._generations.get(session_id, 0) + 1
        self._generations[session_id] = gen
        return gen

    def is_stale(self, session_id: str, generation: int) -> bool:
        return self._generations.get(session_id, 0) != generation

    def forget(self, session_id: str) -> None:
        self._generations.pop(session_id, None)
