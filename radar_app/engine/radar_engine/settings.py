"""
Настройки движка. Значения по умолчанию переопределяются переменными окружения:

  DIPLOM_PROJECT              - папка проекта диплома (по умолчанию ..\\..\\diplom_project от папки engine);
  RADAR_ENGINE_RUN            - прогон диплома, пакеты которого берутся (merged_x1);
  RADAR_ENGINE_BUNDLES        - папка пакетов (по умолчанию <DIPLOM_PROJECT>\\bundles\\<прогон>);
  RADAR_ENGINE_BUNDLES_ROOT   - папка всех прогонов (по умолчанию <DIPLOM_PROJECT>\\bundles): splits.json и tracks/;
  RADAR_ENGINE_HOST, _PORT    - адрес сервиса (127.0.0.1:8765, только локальный);
  RADAR_ENGINE_TORCH_THREADS  - число потоков torch (0 - как решит torch);
  RADAR_ENGINE_SESSION_TTL_S  - через сколько секунд простоя сессия реального времени удаляется.
"""

import os
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parent.parent
DIPLOM_PROJECT = Path(os.environ.get("DIPLOM_PROJECT", ENGINE_DIR.parent.parent / "diplom_project")).resolve()
RUN_NAME = os.environ.get("RADAR_ENGINE_RUN", "merged_x1")
BUNDLES_DIR = Path(os.environ.get("RADAR_ENGINE_BUNDLES", DIPLOM_PROJECT / "bundles" / RUN_NAME)).resolve()
BUNDLES_ROOT = Path(os.environ.get("RADAR_ENGINE_BUNDLES_ROOT", DIPLOM_PROJECT / "bundles")).resolve()
HOST = os.environ.get("RADAR_ENGINE_HOST", "127.0.0.1")
PORT = int(os.environ.get("RADAR_ENGINE_PORT", "8765"))
TORCH_THREADS = int(os.environ.get("RADAR_ENGINE_TORCH_THREADS", "0"))
SESSION_TTL_S = float(os.environ.get("RADAR_ENGINE_SESSION_TTL_S", "3600"))
LOG_DIR = ENGINE_DIR / "log"
