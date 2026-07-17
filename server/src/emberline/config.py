"""Settings for the Emberline inference server.

Env-only, prefix ``EMBERLINE__``. Unlike the kei project this is deliberately
*not* backed by a JSON file that overrides the environment -- for a server,
env > file is the precedence people expect.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="EMBERLINE__",
        env_nested_delimiter="__",
        env_file=".env",
        extra="ignore",
    )

    # --- emberline's own HTTP surface ---
    host: str = "127.0.0.1"
    port: int = 8011

    # --- llama-server subprocess ---
    llama_binary: str = Field(
        default="llama-server",
        description="Path to the llama-server executable, or a bare name on PATH.",
    )
    llama_host: str = "127.0.0.1"
    llama_port: int = 8012
    llama_preset: str = Field(
        default="--fim-qwen-1.5b-default",
        description=(
            "llama.cpp FIM preset. Sets model, n_batch=1024, n_ubatch=1024, "
            "n_cache_reuse=256. Base M1 with 16GB should stay at 1.5b."
        ),
    )
    llama_extra_args: list[str] = Field(default_factory=list)
    llama_managed: bool = Field(
        default=True,
        description="If false, assume llama-server is already running at llama_host:llama_port.",
    )
    llama_startup_timeout_s: float = 300.0
    """Cold start includes a model download on first run, so this is generous."""

    # --- generation budget ---
    n_predict: int = 128
    t_max_predict_ms: int = 1000
    """Upstream's stated FIM target is ~1s end to end. Only bites after the
    first token AND after a newline has been generated -- it is not a hard cap."""
    temperature: float = 0.1
    top_p: float = 0.9
    top_k: int = 40

    # --- context budget ---
    max_prefix_chars: int = 8192
    max_suffix_chars: int = 2048
    """llama.cpp clamps prefix:suffix to 3:1 of n_batch regardless of what we
    send, so sending more than this is wasted serialization."""

    # --- cache ---
    cache_max_entries: int = 250
    """llama.vim ships 250; no reason to differ."""

    # --- cross-file ring buffer context ---
    ring_enabled: bool = True
    ring_max_chunks: int = 16
    ring_chunk_lines: int = 64

    # --- accepted-example retrieval ---
    examples_enabled: bool = True
    examples_top_k: int = 3
    examples_min_similarity: float = 0.65
    """kei had no threshold, so top-k always returned k rows however irrelevant."""
    embedding_model: str = "BAAI/bge-small-en-v1.5"
    embedding_dims: int = 384

    data_dir: Path = Path.home() / ".emberline"

    @property
    def llama_url(self) -> str:
        return f"http://{self.llama_host}:{self.llama_port}"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "examples.db"

    @property
    def fastembed_cache(self) -> Path:
        return self.data_dir / "cache" / "fastembed"

    @property
    def hf_home(self) -> Path:
        """Where llama-server downloads GGUF models.

        Keeps everything Emberline owns under one directory rather than mixing our
        model into the shared ``~/.cache/huggingface`` alongside unrelated ones.
        llama.cpp appends ``/hub`` to this, giving the standard HF cache layout.
        """
        return self.data_dir / "cache" / "huggingface"


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings
