"""Bounded LRU for completion results.

Keyed on a hash of the context that actually reaches the model, so arrowing
around and returning to a position is free. Deliberately not ``functools.lru_cache``:
that is sync-only and cannot be invalidated selectively.
"""

from __future__ import annotations

import hashlib
from collections import OrderedDict


def context_key(prefix: str, suffix: str, extra_digest: str, params_digest: str) -> str:
    h = hashlib.sha256()
    for part in (prefix, "\x00", suffix, "\x00", extra_digest, "\x00", params_digest):
        h.update(part.encode("utf-8", "surrogatepass"))
    return h.hexdigest()


class CompletionCache:
    def __init__(self, max_entries: int = 250) -> None:
        self._max = max_entries
        self._data: OrderedDict[str, str] = OrderedDict()
        self.hits = 0
        self.misses = 0

    def get(self, key: str) -> str | None:
        try:
            value = self._data.pop(key)
        except KeyError:
            self.misses += 1
            return None
        self._data[key] = value
        self.hits += 1
        return value

    def put(self, key: str, value: str) -> None:
        if key in self._data:
            self._data.pop(key)
        elif len(self._data) >= self._max:
            self._data.popitem(last=False)
        self._data[key] = value

    def clear(self) -> None:
        self._data.clear()

    def __len__(self) -> int:
        return len(self._data)
