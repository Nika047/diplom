"""
Операции движка без HTTP: чтение лога и файла отметок, прогон трассы целиком, сессии реального времени.

Каждая операция берёт diplom.LOCK на время работы кода диплома. Метки времени для панели задержек - Unix,
мс (time.time), длительности - по time.perf_counter.
"""

import csv
import json
import logging
import tempfile
import time
import uuid
from pathlib import Path

import numpy as np

from radar_engine import settings
from radar_engine.convert import from_track, jnum, jpoints, jvalues, latlon, to_track
from radar_engine.diplom import (CASES, DEVICE, LOCK, PHASE_RU, OnlinePredictor, Track, bundle_dir, clean_log, config,
                                 config_override, converted_cov, members_of, metrics, observe, phases, polar_to_enu,
                                 predict, predictor, read_log, source_of)

log = logging.getLogger("radar_engine")


class NotFound(Exception):
    """Нет запрошенного объекта (сессии) - ответ 404."""


def now_ms() -> float:
    return time.time() * 1e3


# ============================================================================
# Справка
# ============================================================================

# вид модели пакета (config.json["model"]): hybrid - IMM + поправка сети, e2e - сеть без IMM,
# classic - CV или KF без сети, ensemble - жадный ансамбль из частей; у classic и ensemble участники не выбираются
WITH_MEMBERS = ("hybrid", "e2e")


def _bundle_summary(p) -> dict:
    members = p.cfg.get("members", [])
    return {"case": p.case, "model": p.name, "model_type": p.cfg.get("model", "hybrid"), "label": p.cfg["label"],
            "corrector": p.cfg.get("corrector"), "parts": len(p.cfg.get("parts", [])),
            "window": p.window, "members": len(members), "seeds": [m.get("seed") for m in members],
            "doppler": p.case != "nodop", "has_variants": p.multi is not None, "gate": p.gate,
            "response_ms": p.cfg.get("response_ms"), "run": p.cfg.get("run"), "method": p.cfg.get("method"),
            "title": p.cfg.get("title"), "note": p.cfg.get("note")}


def info() -> dict:
    cases = []
    for case in CASES:
        try:
            p = predictor(case, False)
        except ValueError as e:
            cases.append({"case": case, "error": str(e)})
            continue
        cases.append({**_bundle_summary(p), "case": case, "bundle": str(bundle_dir(case))})
    return {"run": settings.RUN_NAME, "bundles_dir": str(settings.BUNDLES_DIR),
            "diplom_project": str(settings.DIPLOM_PROJECT), "period_s": config.SCAN_PERIOD,
            "horizon": config.HORIZON_SCANS, "default_pd": config.RADAR_PD,
            "phases": [{"code": i, "name": n, "title": PHASE_RU.get(n, n)} for i, n in enumerate(config.PHASES)],
            "cases": cases}


def describe_bundle(bundle: str) -> dict:
    """Сводка пакета модели по пути: загружаются config.json и веса всех участников (проверка пакета)."""
    cfg = json.loads((bundle_dir(None, bundle) / "config.json").read_text(encoding="utf-8"))
    p = predictor(None, cfg.get("model", "hybrid") in WITH_MEMBERS, bundle)
    return {**_bundle_summary(p), "bundle": str(bundle_dir(None, bundle))}


# ============================================================================
# Трассы
# ============================================================================

def _with_file(name: str, text: str, fn):
    """Код диплома читает файл по пути: имя сохраняется - от него зависит шум отметок (flight_id)."""
    with tempfile.TemporaryDirectory(prefix="radar_engine_") as tmp:
        path = Path(tmp) / (Path(name).name or "track.csv")
        path.write_text(text, encoding="utf-8")
        return fn(path)


def tracks_from_log(name: str, text: str, case: str | None, pd: float, bundle: str | None = None) -> dict:
    """Лог полёта -> куски с истиной и отметками РЛС модели этапа 1 (как predict.py --log); датчик - как у пакета."""
    if not 0.0 < pd <= 1.0:
        raise ValueError("Вероятность обнаружения должна быть в (0; 1]")
    p = predictor(case, False, bundle)
    with LOCK:
        items = _with_file(name, text, lambda path: predict.from_log(path, pd, log, p.sensor_override))
        tracks = [to_track(rt, f"кусок {i}", "log", p.case, origin, ge) for i, (rt, origin, ge) in enumerate(items)]
    if not tracks:
        raise ValueError("В логе не осталось кусков после очистки")
    return {"tracks": tracks}


def tracks_from_radar(name: str, text: str, case: str | None, lat=None, lon=None, alt: float = 0.0,
                      bundle: str | None = None) -> dict:
    """Файл отметок РЛС (формат predict.py --radar) -> одна трасса без истины; РЛС в начале координат."""
    case = predictor(case, False, bundle).case
    origin = (lat, lon, alt) if lat is not None and lon is not None else None
    with LOCK:
        rt = _with_file(name, text, lambda path: predict.from_radar(path, lat, lon, alt, case != "nodop"))
        track = to_track(rt, Path(name).stem, "radar", case, origin)
    return {"tracks": [track]}


def radar_csv(track: dict) -> dict:
    """Отметки трассы из лога в формате файла РЛС (predict.save_radar) и положение РЛС."""
    if not track.get("origin"):
        raise ValueError("У трассы нет точки отсчёта - пересчитать отметки в систему РЛС нельзя")
    rt = from_track(track)
    with LOCK, tempfile.TemporaryDirectory(prefix="radar_engine_") as tmp:
        path = Path(tmp) / "radar.csv"
        radar = predict.save_radar(rt, tuple(track["origin"]), path)
        text = path.read_text(encoding="utf-8")
    return {"text": text, "radar": {"lat": radar[0], "lon": radar[1], "alt": radar[2]}}


# ============================================================================
# Сводка по логам: справочник полётов
# ============================================================================

_catalog: list | None = None


def _log_summary(path: Path) -> dict:
    """Строк в логе, кусков после очистки и их длительность - очисткой диплома (data.flight_logs)."""
    raw = read_log(path)
    tracks, _ = clean_log(raw)
    return {"rows": raw.n_rows, "pieces": len(tracks), "duration_s": float(sum(tr.duration_s for tr in tracks)),
            "aircraft": raw.aircraft, "source": source_of(raw.aircraft)}


def runs() -> list:
    """Прогоны диплома с данными для приложения: папки bundles/<прогон>/ с splits.json (export_app_data.py)."""
    if not settings.BUNDLES_ROOT.is_dir():
        return []
    return sorted(p.name for p in settings.BUNDLES_ROOT.iterdir() if (p / "splits.json").exists())


def _run_dir(run_name: str) -> Path:
    if run_name not in runs():
        raise ValueError(f"Нет прогона {run_name!r} с данными для приложения; есть: {', '.join(runs()) or 'нет'}")
    return settings.BUNDLES_ROOT / run_name


def _splits() -> dict:
    """Разбиение логов диплома на выборки по прогонам: {прогон: {файл лога: выборка}}."""
    return {r: json.loads((settings.BUNDLES_ROOT / r / "splits.json").read_text(encoding="utf-8")) for r in runs()}


def logs_catalog() -> dict:
    """
    Логи flight_logs диплома со сводкой и выборкой в каждом прогоне (splits - {прогон: выборка}); сводка считается
    один раз на процесс (150 логов - несколько секунд).
    """
    global _catalog
    with LOCK:
        if _catalog is None:
            _catalog = [{"name": path.name, **_log_summary(path)}
                        for path in sorted((settings.DIPLOM_PROJECT / "flight_logs").glob("*.csv"))]
    splits = _splits()
    return {"runs": list(splits), "logs": [{**x, "splits": {r: s.get(x["name"]) for r, s in splits.items()}}
                                           for x in _catalog]}


# ============================================================================
# Траектории генератора и расширения из пакета прогона: справочник полётов
# ============================================================================

def tracks_catalog() -> dict:
    """Траектории bundles/<прогон>/tracks/index.json всех прогонов (export_app_data.py диплома)."""
    items = []
    for r in runs():
        path = settings.BUNDLES_ROOT / r / "tracks" / "index.json"
        if path.exists():
            items += [{**t, "run": r} for t in json.loads(path.read_text(encoding="utf-8"))["tracks"]]
    return {"tracks": items}


def _track_truth(run_name: str, track_id: str) -> Track:
    """Истина траектории из CSV пакета; участки размечаются кодом диплома (data.phases.annotate), как на этапе 0."""
    root = _run_dir(run_name) / "tracks"
    index = json.loads((root / "index.json").read_text(encoding="utf-8"))["tracks"]
    entry = next((t for t in index if t["id"] == track_id), None)
    if entry is None:
        raise ValueError(f"В прогоне {run_name} нет траектории {track_id!r}")
    t, pos = [], []
    with open(root / Path(entry["file"]).name, encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            if row["id"] == track_id:
                t.append(float(row["t"]))
                pos.append([float(row["e"]), float(row["n"]), float(row["u"])])
    if len(t) < 2:
        raise ValueError(f"У траектории {track_id!r} меньше двух точек")
    # flight_id - как в дипломе: от него зависят положение РЛС и шум отметок (make_track_rng)
    track = Track(flight_id=track_id, source=entry["kind"], aircraft=entry["kind"], t=np.array(t), pos=np.array(pos),
                  scenario=entry.get("scenario") or "")
    return phases.annotate(track)


def tracks_from_bundle(run_name: str, track_id: str, case: str | None, pd: float, bundle: str | None = None) -> dict:
    """
    Траектория генератора или расширения -> одна трасса с истиной и отметками модели РЛС диплома (radar.model.observe),
    датчик - как у пакета. Широты и долготы у траекторий нет: показываются на плоскости.
    """
    if not 0.0 < pd <= 1.0:
        raise ValueError("Вероятность обнаружения должна быть в (0; 1]")
    p = predictor(case, False, bundle)
    with LOCK:
        truth = _track_truth(run_name, track_id)
        with config_override({"RADAR_PD": pd, **p.sensor_override}):
            rt = observe(truth)
        track = to_track(rt, track_id, "track", p.case)
    return {"tracks": [track]}


def describe_file(name: str, text: str, kind: str) -> dict:
    """Сводка загруженного файла: лог - как у логов диплома, файл отметок - одна трасса по времени отметок."""
    if kind == "log":
        with LOCK:
            return _with_file(name, text, _log_summary)
    if kind != "radar":
        raise ValueError(f"Неизвестный вид файла {kind!r}, ожидается log или radar")
    with LOCK:
        rt = _with_file(name, text, lambda path: predict.from_radar(path, None, None, 0.0, False))
    return {"rows": len(rt.t), "pieces": 1 if len(rt.t) > 1 else 0,
            "duration_s": float(rt.t[-1] - rt.t[0]) if len(rt.t) > 1 else 0.0, "aircraft": None, "source": None}


def _check_doppler(rt, case: str) -> None:
    if case != "nodop" and rt.vr is None:
        raise ValueError(f"Для случая {case} у трассы нужна радиальная скорость vr")


# ============================================================================
# Прогон целиком
# ============================================================================

def _variants_xyz(variants: np.ndarray, imm: np.ndarray) -> np.ndarray:
    """Варианты (..., 3, H, 2) с высотой прогноза IMM - только для пересчёта в широту и долготу."""
    up = np.broadcast_to(imm[..., None, :, 2:3], variants.shape[:-1] + (1,))
    return np.concatenate([variants, up], axis=-1)


def run(track: dict, case: str | None, ensemble: bool, bundle: str | None = None, members=None) -> dict:
    """Прогноз по всей трассе (FinalPredictor.run) и, при истине, ошибки как у predict.py; members - seed участников."""
    rt = from_track(track)
    p = predictor(case, ensemble, bundle, members)
    case = p.case
    _check_doppler(rt, case)
    origin = track.get("origin")
    h_total = config.HORIZON_SCANS
    with LOCK:
        t0 = time.perf_counter()
        fc = p.run(rt)
        ms = (time.perf_counter() - t0) * 1e3
        has_truth = not np.isnan(rt.truth).all()
        errors = predict.errors(rt, fc) if has_truth and len(fc["ks"]) else None
        by_h = None
        if errors is not None:
            by_h = {}
            for name in ("imm", "hyb"):
                masked = np.full_like(fc[name], np.nan)
                masked[fc["ks"]] = fc[name][fc["ks"]]
                by_h[name] = jvalues(metrics.ade_by_horizon(metrics.forecast_pairs(rt, masked)), 3)
    k_total = len(rt.t)
    err = None
    if has_truth:
        # ошибка по горизонтали прогноза из обзора k на горизонте h: истина в обзоре k + h
        fut = np.full((k_total, h_total, 2), np.nan)
        for h in range(1, h_total + 1):
            fut[:k_total - h, h - 1] = rt.truth[h:, :2]
        err = {name: jvalues(np.linalg.norm(fc[name][:, :, :2] - fut, axis=2), 2) for name in ("imm", "hyb")}
    out = {
        "case": case, "ensemble": bool(ensemble), "members": members_of(members), "model": p.name,
        "model_type": p.cfg.get("model", "hybrid"), "window": p.window, "horizon": h_total,
        "ks": [int(k) for k in fc["ks"]],
        "imm": jpoints(fc["imm"], 3), "hyb": jpoints(fc["hyb"], 3),
        "imm_ll": latlon(fc["imm"], origin), "hyb_ll": latlon(fc["hyb"], origin),
        "variants": None, "variants_ll": None, "probs": None, "gate": p.gate,
        "errors": {m: {k: jnum(v) for k, v in e.items()} for m, e in errors.items()} if errors else None,
        "ade_by_horizon": by_h, "err": err,
        "ms_total": round(ms, 3), "ms_per_scan": round(ms / max(k_total, 1), 4),
    }
    # оценка фильтра IMM в момент обзора (K, 3) - от неё начинаются линии прогноза на карте
    out["imm_pos"] = jpoints(fc["imm_pos"], 3) if "imm_pos" in fc else None
    out["imm_pos_ll"] = latlon(fc["imm_pos"], origin) if "imm_pos" in fc else None
    if "variants" in fc:
        out["variants"] = jpoints(fc["variants"], 3)
        out["variants_ll"] = latlon(_variants_xyz(fc["variants"], fc["imm"]), origin)
        out["probs"] = jvalues(fc["probs"], 4)
    return out


# ============================================================================
# Реальное время
# ============================================================================

class Session:
    def __init__(self, case: str | None, ensemble: bool, radar_pos, origin, truth=None, bundle: str | None = None,
                 members=None):
        self.id = uuid.uuid4().hex
        self.bundle = bundle_dir(case, bundle)
        self.case, self.ensemble = predictor(case, False, bundle).case, bool(ensemble)
        self.members = members_of(members)
        self.radar_pos = np.asarray(radar_pos, dtype=float)
        self.origin = tuple(origin) if origin else None
        # истина трассы (лог полёта): только для ошибки прогноза в ответе, в модель не идёт
        self.truth = (np.array([[np.nan] * 3 if p is None else p for p in truth], dtype=float)
                      if truth is not None else None)
        with LOCK:
            self.pred = OnlinePredictor(self.bundle, DEVICE, ensemble=self.ensemble, radar_pos=self.radar_pos,
                                        members=self.members)
        self.created = self.used = time.time()

    def describe(self) -> dict:
        fp = self.pred.fp
        return {"id": self.id, "case": self.case, "ensemble": self.ensemble, "members": self.members, "model": fp.name,
                "model_type": fp.cfg.get("model", "hybrid"), "window": fp.window,
                "horizon": self.pred.h, "has_variants": fp.multi is not None, "gate": fp.gate,
                "scans": self.pred.n, "origin": list(self.origin) if self.origin else None}

    def scan(self, t: float, detected: bool, polar, vr) -> dict:
        """
        Один обзор: polar - (дальность, азимут, угол места) в радианах или None при пропуске; vr - радиальная
        скорость, м/с, или None (у модели РЛС диплома её нет в первом обзоре трассы).
        """
        received = now_ms()
        if detected and polar is None:
            raise ValueError("Обнаруженная отметка без polar")
        p = np.asarray(polar if detected else [np.nan] * 3, dtype=float)
        with LOCK:
            started = now_ms()
            with np.errstate(invalid="ignore"):
                meas = polar_to_enu(p[None])[0] + self.radar_pos
                cov = converted_cov(p[None])[0]
            res = self.pred.update(t, bool(detected), p, meas, cov, np.nan if vr is None else float(vr))
        done = now_ms()
        self.used = time.time()
        out = {"k": res["k"], "imm": None, "hyb": None, "imm_ll": None, "hyb_ll": None, "variants": None,
               "variants_ll": None, "probs": None, "err": None, "imm_pos": None, "imm_pos_ll": None,
               "ms": {"wait": round(started - received, 3), "imm": round(res["ms"]["imm"], 4),
                      "net": round(res["ms"]["net"], 4)},
               "received_ms": round(received, 3), "done_ms": round(done, 3)}
        if res.get("imm_pos") is not None:
            out["imm_pos"], out["imm_pos_ll"] = jpoints(res["imm_pos"], 3), latlon(res["imm_pos"], self.origin)
        if res["imm"] is not None:
            out["imm"], out["imm_ll"] = jpoints(res["imm"], 3), latlon(res["imm"], self.origin)
        if res["hyb"] is not None:
            out["hyb"], out["hyb_ll"] = jpoints(res["hyb"], 3), latlon(res["hyb"], self.origin)
        if "variants" in res:
            out["variants"] = jpoints(res["variants"], 3)
            out["variants_ll"] = latlon(_variants_xyz(res["variants"], res["imm"]), self.origin)
            out["probs"] = jvalues(res["probs"], 4)
        if self.truth is not None and res["imm"] is not None:
            out["err"] = {name: jvalues(self._errors(res[name]), 2) for name in ("imm", "hyb")}
        return out

    def _errors(self, forecast) -> np.ndarray:
        """Ошибка по горизонтали прогноза из обзора k на горизонтах 1..H, м; истины ещё нет (конец трассы) - nan."""
        k, h_total = self.pred.n - 1, self.pred.h
        err = np.full(h_total, np.nan)
        if forecast is None:
            return err
        for h in range(h_total):
            if k + h + 1 < len(self.truth):
                err[h] = np.linalg.norm(np.asarray(forecast)[h, :2] - self.truth[k + h + 1, :2])
        return err


_sessions: dict = {}


def _expire() -> None:
    limit = time.time() - settings.SESSION_TTL_S
    for sid in [sid for sid, s in _sessions.items() if s.used < limit]:
        log.info("Сессия %s удалена: простой больше %.0f с", sid, settings.SESSION_TTL_S)
        del _sessions[sid]


def create_session(case: str | None, ensemble: bool, radar_pos, origin=None, truth=None,
                   bundle: str | None = None, members=None) -> dict:
    _expire()
    s = Session(case, ensemble, radar_pos, origin, truth, bundle, members)
    _sessions[s.id] = s
    log.info("Сессия %s: %s, РЛС %s", s.id, s.pred.fp.name, s.radar_pos.round(1).tolist())
    return s.describe()


def session(sid: str) -> Session:
    s = _sessions.get(sid)
    if s is None:
        raise NotFound(f"Нет сессии {sid}")
    return s


def sessions() -> list:
    return [s.describe() for s in _sessions.values()]


def delete_session(sid: str) -> None:
    if _sessions.pop(sid, None) is None:
        raise NotFound(f"Нет сессии {sid}")
