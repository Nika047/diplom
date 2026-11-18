"""
Мост к коду диплома: путь, переменные прогона, импорт и общий замок.

Код диплома только читается: байт-код в его папку не пишется, его скрипты не запускаются. Формулы IMM, сети,
модели РЛС, очистки логов и метрик не копируются - вызываются отсюда.

Все вызовы кода диплома идут под LOCK: config_override меняет глобальный модуль config, два прогноза
одновременно смешали бы параметры разных случаев.
"""

import os
import sys
import threading
from pathlib import Path

from radar_engine import settings

sys.dont_write_bytecode = True
_data, _synth = settings.RUN_NAME.split("_x")
os.environ.setdefault("DIPLOM_DATA", _data)
os.environ.setdefault("DIPLOM_SYNTH", _synth)
if not (settings.DIPLOM_PROJECT / "pipeline" / "bundle.py").exists():
    raise RuntimeError(f"Нет проекта диплома в {settings.DIPLOM_PROJECT} - задайте DIPLOM_PROJECT")
sys.path.insert(0, str(settings.DIPLOM_PROJECT))

import torch  # noqa: E402

import config  # noqa: E402
import predict  # noqa: E402
from common.cases import CASES, config_override  # noqa: E402
from data import phases  # noqa: E402
from data.flight_logs import clean_log, read_log, source_of  # noqa: E402
from data.track import Track  # noqa: E402
from eval import metrics  # noqa: E402
from pipeline.bundle import FinalPredictor, OnlinePredictor  # noqa: E402
from radar.model import RadarTrack, converted_cov, observe, polar_to_enu  # noqa: E402
from viz.plots import PHASE_RU  # noqa: E402

__all__ = ["CASES", "FinalPredictor", "LOCK", "OnlinePredictor", "PHASE_RU", "RadarTrack", "Track", "bundle_dir",
           "clean_log", "config", "config_override", "converted_cov", "metrics", "observe", "phases", "polar_to_enu",
           "predict", "predictor", "read_log", "source_of", "torch"]

LOCK = threading.RLock()
DEVICE = torch.device("cpu")
if settings.TORCH_THREADS > 0:
    torch.set_num_threads(settings.TORCH_THREADS)

_predictors: dict = {}


def bundle_dir(case: str | None, bundle: str | None = None):
    """Папка пакета: bundle - путь к пакету (модель из справочника приложения), иначе пакет случая в BUNDLES_DIR."""
    if bundle:
        path = Path(bundle)
        if not (path / "config.json").exists():
            raise ValueError(f"Нет пакета модели {path} (нужен config.json)")
        return path
    if case not in CASES:
        raise ValueError(f"Неизвестный случай доплера {case!r}, ожидается один из {', '.join(CASES)}")
    path = settings.BUNDLES_DIR / case
    if not (path / "config.json").exists():
        raise ValueError(f"Нет пакета модели {path}")
    return path


def members_of(members) -> list | None:
    """Seed участников пакета: None - по умолчанию (все при ensemble, иначе первый)."""
    return [int(s) for s in members] if members else None


def predictor(case: str | None, ensemble: bool, bundle: str | None = None, members=None) -> FinalPredictor:
    """
    FinalPredictor пакета (один раз на процесс); ensemble - среднее поправок всех seed пакета, members - seed
    выбранных участников.
    """
    path = bundle_dir(case, bundle)
    members = members_of(members)
    key = (str(path.resolve()), bool(ensemble), tuple(members) if members else None)
    with LOCK:
        if key not in _predictors:
            try:
                _predictors[key] = FinalPredictor(path, DEVICE, ensemble=bool(ensemble), members=members)
            except (KeyError, FileNotFoundError, RuntimeError) as e:
                raise ValueError(f"Пакет {path} не загружается: {e}") from e
        return _predictors[key]
