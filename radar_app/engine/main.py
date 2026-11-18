"""
Запуск движка прогноза: engine\\.venv\\Scripts\\python.exe engine\\main.py

Адрес и пути - radar_engine/settings.py (переменные окружения). Журнал - в консоль и в
engine/log/engine_<ГГГГММДД-ЧЧММСС>.log.
"""

import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import uvicorn  # noqa: E402

from radar_engine import settings  # noqa: E402


def setup_logging() -> None:
    settings.LOG_DIR.mkdir(parents=True, exist_ok=True)
    path = settings.LOG_DIR / f"engine_{time.strftime('%Y%m%d-%H%M%S')}.log"
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s",
                        handlers=[logging.StreamHandler(), logging.FileHandler(path, encoding="utf-8")])


if __name__ == "__main__":
    setup_logging()
    logging.getLogger("radar_engine").info("Проект диплома %s, пакеты %s", settings.DIPLOM_PROJECT, settings.BUNDLES_DIR)
    # журнал каждого запроса не пишется: в реальном времени это до 25 строк в секунду
    uvicorn.run("radar_engine.api:app", host=settings.HOST, port=settings.PORT, log_config=None, access_log=False)
