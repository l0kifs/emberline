"""FastAPI app and composition root."""

from __future__ import annotations

import hashlib
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass

import anyio.to_thread
import httpx
from fastapi import FastAPI

from emberline.api.routes import router
from emberline.config import Settings, get_settings
from emberline.context.assemble import Assembler
from emberline.context.examples import ExampleStore
from emberline.context.ring import RingContext
from emberline.engine.cache import CompletionCache
from emberline.engine.supersede import Supersede
from emberline.runtime.idle import IdleShutdown
from emberline.runtime.infill import InfillClient
from emberline.runtime.llama_server import LlamaServer

log = logging.getLogger(__name__)


@dataclass
class AppContext:
    settings: Settings
    llama: LlamaServer | None
    infill: InfillClient
    cache: CompletionCache
    supersede: Supersede
    assembler: Assembler
    examples: ExampleStore | None
    params_digest: str
    idle: IdleShutdown

    async def llama_healthy(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=1.0) as client:
                resp = await client.get(f"{self.settings.llama_url}/health")
                return resp.status_code == 200
        except httpx.HTTPError:
            return False


def _params_digest(s: Settings) -> str:
    """Cache-key component: changing sampling must not serve stale completions."""
    raw = f"{s.llama_preset}|{s.n_predict}|{s.temperature}|{s.top_p}|{s.top_k}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )

    # anyio defaults to 40 threads. With one model behind one lock that is a way
    # to queue 40 callers onto the same GPU; we never want more than a couple.
    anyio.to_thread.current_default_thread_limiter().total_tokens = 2

    llama: LlamaServer | None = None
    if settings.llama_managed:
        llama = LlamaServer(
            binary=settings.llama_binary,
            host=settings.llama_host,
            port=settings.llama_port,
            preset=settings.llama_preset,
            # -np 1 is not optional. The FIM presets leave slots on auto, which
            # round-robins requests across independent KV caches: measured, that
            # made every other keystroke a full 793-token recompute (~1.24s)
            # instead of a ~67ms cache hit.
            extra_args=["-np", "1", *settings.llama_extra_args],
            startup_timeout_s=settings.llama_startup_timeout_s,
            cache_dir=settings.hf_home,
        )
        # Raising here is deliberate: FastAPI aborts startup, so a server that
        # cannot reach a model refuses to serve rather than 500ing per keystroke.
        await llama.start()
    else:
        log.info("llama_managed=false; expecting a server at %s", settings.llama_url)

    examples: ExampleStore | None = None
    if settings.examples_enabled:
        examples = ExampleStore(
            db_path=settings.db_path,
            model_name=settings.embedding_model,
            cache_dir=settings.fastembed_cache,
            dims=settings.embedding_dims,
            top_k=settings.examples_top_k,
            min_similarity=settings.examples_min_similarity,
        )
        await examples.start()

    ring = RingContext(
        max_chunks=settings.ring_max_chunks,
        chunk_lines=settings.ring_chunk_lines,
    )

    idle = IdleShutdown(settings.idle_timeout_s)

    ctx = AppContext(
        settings=settings,
        llama=llama,
        infill=InfillClient(settings.llama_url),
        cache=CompletionCache(settings.cache_max_entries),
        supersede=Supersede(),
        assembler=Assembler(settings, ring=ring, examples=examples),
        examples=examples,
        params_digest=_params_digest(settings),
        idle=idle,
    )
    app.state.ctx = ctx
    idle.start()
    log.info("emberline ready on %s:%s", settings.host, settings.port)

    try:
        yield
    finally:
        await idle.stop()
        await ctx.infill.aclose()
        if examples is not None:
            await examples.aclose()
        if llama is not None:
            await llama.stop()


def create_app() -> FastAPI:
    app = FastAPI(title="Emberline", version="0.1.0", lifespan=lifespan)
    app.include_router(router)
    return app


app = create_app()
