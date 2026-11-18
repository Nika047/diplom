"""
Перевод между RadarTrack диплома и JSON трассы приложения.

Трасса в JSON (ключи - ARCHITECTURE.md, «Трасса»): координаты ENU с началом в точке отсчёта (для лога - первая
точка куска, для файла отметок - РЛС), углы в радианах, пропуск обнаружения - null в polar и meas. Отметка в ENU и
её ковариация из JSON не берутся, а пересчитываются из polar так же, как в radar.model.observe: прогноз по трассе
из JSON совпадает с прогнозом по исходной RadarTrack (проверка check.py).
"""

import numpy as np

from radar_engine.diplom import RadarTrack, config, converted_cov, polar_to_enu, predict


def jpoints(a, nd: int = None):
    """Массив точек (..., D) -> вложенные списки; точка с nan - None, координаты округлены до nd знаков (None - без)."""
    a = np.asarray(a, dtype=float)
    if nd is not None:
        a = np.round(a, nd)
    bad = np.isnan(a).any(axis=-1).reshape(-1)
    out = [None if b else p for p, b in zip(a.reshape(-1, a.shape[-1]).tolist(), bad)]
    if a.ndim == 1:
        return out[0]
    for n in reversed(a.shape[1:-1]):
        out = [out[i:i + n] for i in range(0, len(out), n)]
    return out


def jvalues(a, nd: int = None):
    """Массив чисел -> вложенные списки; nan - None, округление до nd знаков (None - без)."""
    a = np.asarray(a, dtype=float)
    if nd is not None:
        a = np.round(a, nd)
    obj = a.astype(object)
    obj[np.isnan(a)] = None
    return obj.tolist()


def jnum(v, nd: int = 3):
    return None if v is None or not np.isfinite(v) else round(float(v), nd)


def latlon(xyz, origin):
    """ENU (..., 3) -> широта, долгота (..., 2) в JSON; None без точки отсчёта."""
    if not origin:
        return None
    return jpoints(predict.to_latlon(np.asarray(xyz, dtype=float), tuple(origin)), 7)


def _arr(rows, width: int) -> np.ndarray:
    return np.array([[np.nan] * width if r is None else r for r in rows], dtype=float)


def to_track(rt: RadarTrack, name: str, source: str, case: str, origin=None, geo_err=None) -> dict:
    det = rt.detected
    polar, meas = rt.polar.copy(), rt.meas.copy()
    polar[~det], meas[~det] = np.nan, np.nan
    has_truth = not np.isnan(rt.truth).all()
    return {
        "name": name, "flight_id": rt.flight_id, "source": source, "case": case,
        "origin": list(origin) if origin else None,
        "radar_pos": jpoints(rt.radar_pos, 3), "radar_ll": latlon(rt.radar_pos, origin),
        "t": jvalues(rt.t), "detected": [bool(d) for d in det],
        # входы модели - без округления: у IMM с доплером округление vr до 1 мм/с сдвигало прогноз на 5-9 см
        "polar": jpoints(polar), "vr": jvalues(rt.vr) if rt.vr is not None else None,
        "meas": jpoints(meas, 3), "meas_ll": latlon(meas, origin),
        "truth": jpoints(rt.truth, 3) if has_truth else None,
        "truth_ll": latlon(rt.truth, origin) if has_truth else None,
        "phase": [int(p) for p in rt.phase] if has_truth else None,
        "onsets": [int(k) for k in rt.onsets],
        "geo_err_m": jnum(geo_err),
    }


def from_track(d: dict) -> RadarTrack:
    t = np.asarray(d["t"], dtype=float)
    radar_pos = np.asarray(d["radar_pos"], dtype=float)
    polar = _arr(d["polar"], 3)
    detected = np.asarray(d["detected"], dtype=bool)
    if not (len(t) == len(polar) == len(detected)):
        raise ValueError("Трасса: длины t, polar и detected не совпадают")
    truth = _arr(d["truth"], 3) if d.get("truth") else np.full((len(t), 3), np.nan)
    phase = (np.asarray(d["phase"], dtype=np.int8) if d.get("phase")
             else np.full(len(t), config.PHASES.index("straight"), dtype=np.int8))
    vr = np.array([np.nan if v is None else v for v in d["vr"]], dtype=float) if d.get("vr") is not None else None
    with np.errstate(invalid="ignore"):
        meas = polar_to_enu(polar) + radar_pos
        cov = converted_cov(polar)
    return RadarTrack(d.get("flight_id") or d["name"], t, truth, radar_pos, polar, meas, cov, detected, phase,
                      list(d.get("onsets") or []), vr)
