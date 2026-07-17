"""Idle self-shutdown.

The editor starts this server and never stops it (the process is shared across
windows and kept warm), so the only thing bounding its lifetime is this timer.
If touch() stops pushing the deadline out, or /health is wired to touch(), a
force-quit editor leaks a ~1.6GB model forever -- the exact leak this guards.
"""

import asyncio
import os
import signal
from unittest.mock import patch

from emberline.runtime.idle import IdleShutdown


class TestIdleShutdown:
    async def test_disabled_never_fires(self):
        # timeout 0 means "do not bound lifetime"; start() must be a no-op, not a
        # zero-delay shutdown.
        idle = IdleShutdown(timeout_s=0)
        with patch("os.kill") as kill:
            idle.start()
            await asyncio.sleep(0.05)
            await idle.stop()
            kill.assert_not_called()

    async def test_fires_after_timeout(self):
        idle = IdleShutdown(timeout_s=0.1)
        with patch("os.kill") as kill:
            idle.start()
            await asyncio.sleep(0.25)
            kill.assert_called_once_with(os.getpid(), signal.SIGTERM)
        await idle.stop()

    async def test_touch_pushes_the_deadline_out(self):
        # A server under steady completion traffic must never shut down. If touch()
        # failed to reset the deadline, this would fire mid-stream.
        idle = IdleShutdown(timeout_s=0.2)
        with patch("os.kill") as kill:
            idle.start()
            for _ in range(6):
                await asyncio.sleep(0.05)
                idle.touch()
            kill.assert_not_called()
            await idle.stop()

    async def test_stop_prevents_a_pending_fire(self):
        idle = IdleShutdown(timeout_s=0.1)
        with patch("os.kill") as kill:
            idle.start()
            await idle.stop()
            await asyncio.sleep(0.2)
            kill.assert_not_called()
