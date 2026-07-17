"""Idle self-shutdown.

The extension starts this server and never stops it: the process is shared
across editor windows and kept warm for its KV cache, so no single window may
own its lifetime (see the extension's server/manage.ts). The cost of that policy
is that a crashed or force-quit editor would otherwise leave a ~1.6GB model
resident forever. Bounding the lifetime from inside closes that leak.

A monotonic deadline, bumped on real completion traffic and checked on a coarse
timer. Not tied to /health -- a liveness probe means someone is watching, not
that anyone is typing, and letting probes keep the process alive would defeat
the timeout for exactly the abandoned-editor case it exists for.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import signal

log = logging.getLogger(__name__)


class IdleShutdown:
    """Fires SIGTERM after `timeout_s` with no `touch()`."""

    def __init__(self, timeout_s: float) -> None:
        self._timeout_s = timeout_s
        self._deadline = 0.0
        self._task: asyncio.Task[None] | None = None

    def touch(self) -> None:
        """Record activity, pushing the deadline out. Cheap enough per request."""
        if self._timeout_s <= 0:
            return
        self._deadline = asyncio.get_running_loop().time() + self._timeout_s

    def start(self) -> None:
        if self._timeout_s <= 0:
            log.info("idle shutdown disabled")
            return
        self.touch()
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def _run(self) -> None:
        # Check at a fraction of the timeout so shutdown lands within ~1/20th of
        # the window. Clamped both ways: never looser than 30s (so the default
        # 1800s timeout still frees memory promptly once idle) and never tighter
        # than 50ms (so a misconfigured sub-second timeout cannot busy-loop).
        interval = min(30.0, max(0.05, self._timeout_s / 20))
        while True:
            await asyncio.sleep(interval)
            remaining = self._deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                log.info("idle for %.0fs, shutting down", self._timeout_s)
                # SIGTERM, not sys.exit: this runs in a task, and we want the same
                # uvicorn graceful-shutdown path a Ctrl-C takes so lifespan cleanup
                # (stopping llama-server, closing the db) still runs.
                os.kill(os.getpid(), signal.SIGTERM)
                return
