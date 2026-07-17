"""Lifecycle for the llama-server subprocess.

We shell out to llama.cpp's server rather than embedding llama-cpp-python so we
inherit ``/infill``: it reads the FIM token spellings out of the GGUF metadata.
That matters -- there are at least four mutually incompatible spellings in the
wild (Qwen ``<|fim_prefix|>``, StarCoder2 ``<fim_prefix>``, DeepSeek's fullwidth
``<｜fim▁begin｜>``, Seed-Coder's bracket-dash) crossed with PSM vs SPM ordering.
Hand-rolling that is the classic silent-breakage bug. We also get --cache-reuse,
the 3:1 prefix:suffix batch clamp, and crash isolation for free.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import subprocess
from pathlib import Path

import httpx

log = logging.getLogger(__name__)


class LlamaServerError(RuntimeError):
    pass


class LlamaServer:
    """Spawns llama-server and waits for it to report healthy."""

    def __init__(
        self,
        *,
        binary: str,
        host: str,
        port: int,
        preset: str,
        extra_args: list[str],
        startup_timeout_s: float,
        cache_dir: Path,
    ) -> None:
        self._binary = binary
        self._host = host
        self._port = port
        self._preset = preset
        self._extra_args = extra_args
        self._startup_timeout_s = startup_timeout_s
        self._cache_dir = cache_dir
        self._proc: subprocess.Popen[bytes] | None = None

    def _env(self) -> dict[str, str]:
        """Environment for the subprocess, pinning the model cache to our data dir.

        Both variables are set deliberately: LLAMA_CACHE takes precedence over
        HF_HOME in llama.cpp (verified empirically), so setting only HF_HOME would
        be silently overridden for anyone who already exports LLAMA_CACHE. Note the
        different levels -- HF_HOME is the parent and llama.cpp appends "/hub",
        whereas LLAMA_CACHE names the hub directory itself.
        """
        env = os.environ.copy()
        env["HF_HOME"] = str(self._cache_dir)
        env["LLAMA_CACHE"] = str(self._cache_dir / "hub")
        return env

    @property
    def url(self) -> str:
        return f"http://{self._host}:{self._port}"

    def _command(self) -> list[str]:
        cmd = [self._binary]
        if self._preset:
            cmd.append(self._preset)
        # After the preset, so these win on conflict.
        cmd += ["--host", self._host, "--port", str(self._port)]
        cmd += self._extra_args
        return cmd

    async def start(self) -> None:
        if await self._is_healthy():
            log.info("llama-server already healthy at %s, not spawning", self.url)
            return

        cmd = self._command()
        self._cache_dir.mkdir(parents=True, exist_ok=True)
        log.info("spawning: %s", " ".join(cmd))
        log.info("model cache: %s", self._cache_dir / "hub")
        try:
            self._proc = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.STDOUT,
                env=self._env(),
                # Own process group, so our SIGINT (Ctrl-C in the dev loop) does not
                # race the child's own handler; we terminate it explicitly instead.
                start_new_session=True,
            )
        except FileNotFoundError as exc:
            raise LlamaServerError(
                f"{self._binary!r} not found on PATH. Install llama.cpp "
                f"(`brew install llama.cpp`) or set EMBERLINE__LLAMA_BINARY."
            ) from exc

        await self._await_healthy()
        log.info("llama-server healthy at %s", self.url)

    async def _is_healthy(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=1.0) as client:
                resp = await client.get(f"{self.url}/health")
                return resp.status_code == 200
        except httpx.HTTPError:
            return False

    async def _await_healthy(self) -> None:
        """Poll /health until 200.

        First run downloads the model, hence the generous timeout. /health returns
        503 {"error": {"message": "Loading model"}} while warming.
        """
        deadline = asyncio.get_running_loop().time() + self._startup_timeout_s
        while asyncio.get_running_loop().time() < deadline:
            if self._proc is not None and self._proc.poll() is not None:
                raise LlamaServerError(
                    f"llama-server exited with code {self._proc.returncode} during startup"
                )
            if await self._is_healthy():
                return
            await asyncio.sleep(0.25)
        await self.stop()
        raise LlamaServerError(
            f"llama-server did not become healthy within {self._startup_timeout_s}s"
        )

    async def stop(self) -> None:
        proc = self._proc
        if proc is None or proc.poll() is not None:
            return
        log.info("stopping llama-server (pid %s)", proc.pid)
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            proc.terminate()
        try:
            await asyncio.to_thread(proc.wait, 10)
        except subprocess.TimeoutExpired:
            log.warning("llama-server ignored SIGTERM, killing")
            proc.kill()
            await asyncio.to_thread(proc.wait)
        self._proc = None
