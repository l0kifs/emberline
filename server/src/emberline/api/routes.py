"""HTTP surface.

Non-streaming: the inline completion API wants one string, not a stream. That
choice has a consequence -- uvicorn does NOT cancel a plain ``async def`` handler
when the client disconnects (it only flags the connection), so we have to detect
the disconnect ourselves and race it against the generation. Streaming responses
*are* cancelled since Starlette 0.42; plain handlers are not.
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Request

from emberline.api.schemas import (
    AcceptRequest,
    CompleteRequest,
    CompleteResponse,
    HealthResponse,
)
from emberline.engine.cache import context_key
from emberline.postprocess import trim_completion

log = logging.getLogger(__name__)

router = APIRouter()

_DISCONNECT_POLL_S = 0.1


async def _watch_disconnect(request: Request) -> None:
    """Resolves when the client goes away."""
    while True:
        if await request.is_disconnected():
            return
        await asyncio.sleep(_DISCONNECT_POLL_S)


@router.post("/v1/complete", response_model=None)
async def complete(body: CompleteRequest, request: Request) -> CompleteResponse:
    ctx = request.app.state.ctx

    # Claim a generation BEFORE any awaits, so an older in-flight request sees
    # itself go stale as soon as this one arrives.
    generation = ctx.supersede.claim(body.session_id)

    infill_req, extra_digest = await ctx.assembler.build(
        prefix=body.prefix,
        suffix=body.suffix,
        language_id=body.language_id,
        path=body.path,
        open_paths=body.open_paths,
    )

    key = context_key(infill_req.prefix, infill_req.suffix, extra_digest, ctx.params_digest)
    cached = ctx.cache.get(key)
    if cached is not None:
        return CompleteResponse(completion=cached, cached=True)

    if ctx.supersede.is_stale(body.session_id, generation):
        return CompleteResponse(completion="", superseded=True)

    def should_stop() -> bool:
        return ctx.supersede.is_stale(body.session_id, generation)

    async with ctx.supersede.model_lock:
        # Re-check: the user almost certainly typed again while we queued.
        if should_stop():
            return CompleteResponse(completion="", superseded=True)

        gen_task = asyncio.create_task(ctx.infill.infill(infill_req, should_stop=should_stop))
        disc_task = asyncio.create_task(_watch_disconnect(request))
        try:
            done, _ = await asyncio.wait(
                {gen_task, disc_task}, return_when=asyncio.FIRST_COMPLETED
            )
            if gen_task not in done:
                # Client vanished. Abandon the generation rather than heating the
                # GPU for a suggestion nobody will see.
                gen_task.cancel()
                log.debug("client disconnected, abandoning generation")
                return CompleteResponse(completion="", superseded=True)
            result = gen_task.result()
        finally:
            disc_task.cancel()

    if result.superseded:
        return CompleteResponse(completion="", superseded=True)

    text = trim_completion(result.content, suffix=infill_req.suffix)
    if text:
        ctx.cache.put(key, text)
    return CompleteResponse(
        completion=text,
        stop_type=result.stop_type,
        timings={
            k: v
            for k, v in result.timings.items()
            if k in ("prompt_n", "prompt_ms", "predicted_n", "predicted_ms")
        },
    )


@router.post("/v1/accept")
async def accept(body: AcceptRequest, request: Request) -> dict[str, int]:
    ctx = request.app.state.ctx
    if ctx.examples is None:
        return {"examples": 0}
    await ctx.examples.add(
        prefix=body.prefix,
        completion=body.completion,
        language_id=body.language_id,
    )
    return {"examples": ctx.examples.count()}


@router.get("/health", response_model=None)
async def health(request: Request) -> HealthResponse:
    ctx = request.app.state.ctx
    llama_ok = await ctx.llama_healthy()
    return HealthResponse(
        status="ok" if llama_ok else "degraded",
        llama="ok" if llama_ok else "unreachable",
        cache_entries=len(ctx.cache),
        cache_hits=ctx.cache.hits,
        cache_misses=ctx.cache.misses,
    )
