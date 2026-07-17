"""HTTP client for llama.cpp's ``POST /infill``.

We stream even though our own API does not, for two reasons: we can abandon a
generation the moment it is superseded, and we can stop early on our own
criteria without waiting for the full n_predict budget.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from dataclasses import dataclass, field

import httpx

log = logging.getLogger(__name__)


@dataclass(slots=True)
class InfillRequest:
    prefix: str
    suffix: str
    extra: list[dict[str, str]] = field(default_factory=list)
    n_predict: int = 128
    t_max_predict_ms: int = 1000
    temperature: float = 0.1
    top_p: float = 0.9
    top_k: int = 40


@dataclass(slots=True)
class InfillResult:
    content: str
    stop_type: str | None = None
    superseded: bool = False
    timings: dict[str, float] = field(default_factory=dict)


class InfillClient:
    def __init__(self, base_url: str, *, connect_timeout: float = 2.0) -> None:
        # No read timeout: generation length is bounded by n_predict and
        # t_max_predict_ms, not by the clock. keepalive_expiry keeps the localhost
        # connection warm between keystrokes.
        self._client = httpx.AsyncClient(
            base_url=base_url,
            timeout=httpx.Timeout(None, connect=connect_timeout),
            limits=httpx.Limits(max_keepalive_connections=4, keepalive_expiry=120.0),
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def infill(
        self,
        req: InfillRequest,
        *,
        should_stop: Callable[[], bool] | None = None,
    ) -> InfillResult:
        """Run one FIM completion.

        ``should_stop`` is polled per streamed chunk; returning True abandons the
        generation and reports ``superseded=True``.
        """
        payload = {
            "input_prefix": req.prefix,
            "input_suffix": req.suffix,
            "input_extra": req.extra,
            "n_predict": req.n_predict,
            "t_max_predict_ms": req.t_max_predict_ms,
            "temperature": req.temperature,
            "top_p": req.top_p,
            "top_k": req.top_k,
            "cache_prompt": True,
            "n_cache_reuse": 256,
            "stream": True,
            "timings_per_token": True,
        }

        parts: list[str] = []
        stop_type: str | None = None
        timings: dict[str, float] = {}

        async with self._client.stream("POST", "/infill", json=payload) as resp:
            if resp.status_code != 200:
                body = (await resp.aread()).decode("utf-8", "replace")
                raise httpx.HTTPStatusError(
                    f"/infill returned {resp.status_code}: {body[:500]}",
                    request=resp.request,
                    response=resp,
                )
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                if should_stop is not None and should_stop():
                    return InfillResult("".join(parts), stop_type, superseded=True)
                try:
                    chunk = json.loads(line[5:])
                except json.JSONDecodeError:
                    log.warning("undecodable /infill chunk: %r", line[:200])
                    continue
                parts.append(chunk.get("content", ""))
                if chunk.get("stop"):
                    stop_type = chunk.get("stop_type")
                    timings = chunk.get("timings") or {}
                    break

        return InfillResult("".join(parts), stop_type, timings=timings)
