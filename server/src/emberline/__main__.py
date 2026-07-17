"""Console entry point: ``emberline-server``."""

from __future__ import annotations

import uvicorn

from emberline.config import get_settings


def main() -> None:
    settings = get_settings()
    uvicorn.run(
        "emberline.main:app",
        host=settings.host,
        port=settings.port,
        # One model in memory: extra workers would each load their own copy and
        # then contend for the same GPU.
        workers=1,
        # Keeps the editor's TCP connection warm between keystrokes.
        timeout_keep_alive=120,
        log_level="info",
    )


if __name__ == "__main__":
    main()
