"""
Итоговая модель случая как самостоятельный пакет (этап 11) и предсказатель по нему (predict.py).

Пакет artifacts/<прогон>/stage11/<случай>/: config.json (подмены config - параметры IMM, флаги доплера,
доверие к доплеру; окно, тип сети, гиперпараметры, сочетание гипотез, время отклика) и member_<seed>.pt
(веса и нормализатор). Пакет не зависит от реестра и хранилища моделей: по нему программа работает на
любом компьютере с проектом. Для приложения визуализации: сеть «три варианта
прогноза» этапа 6 (multi_<seed>.pt, config.json["multi"]) и радиусы строба по горизонтам (config.json["gate"]):
круг вокруг прогноза гибрида и три круга вокруг вариантов, конформные квантили ошибки на val.

FinalPredictor - прогноз по всей трассе; OnlinePredictor - тот же прогноз пошагово, по одной отметке (IMMStream и
окно последнего обзора), для режима реального времени. Совпадение с прогоном трассы - проверка этапа 11.
Для приложения: config.json["title"], ["note"] - подпись и примечание (нет - подпись по label);
members=[seed, ...] - выбрать участников пакета; в ответе imm_pos - оценка IMM положения в момент обзора (ENU), от
неё на карте начинаются линии прогноза. Пакеты любой обученной модели «IMM + сеть» пишет export_bundle.py.
config.json["model"] - вид модели пакета (нет поля - "hybrid"):
  hybrid   - IMM + поправка сети (участники - seed, среднее поправок при ensemble);
  classic  - метод этапа 1 без сети: config["classic"] = {"method": "cv", "n_points": n} (линейная экстраполяция
             по n отметкам) или {"method": "kf", "override": {...}} (фильтр Калмана, подмены config подбора);
             участников нет;
  e2e      - сеть без IMM (этап 2, «без IMM»): прогноз - последняя отметка плюс смещение, предсказанное сетью по
             окну отметок (data.windows.build_windows_e2e на тех же обзорах, что у гибрида); участники - seed;
  ensemble - жадный ансамбль этапа 8: config["parts"] - участники с разными сетями (гибриды, сочетания гипотез,
             сети без IMM), прогноз - среднее их прогнозов, как на этапе 8; members не задаются.
Во всех видах ответ тот же: hyb - прогноз модели пакета (K, H, 3), imm и imm_pos - IMM случая (config["override"]).
"""

import json
import time
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import torch

import config
from common.cases import config_override
from data.windows import apply_correction, apply_e2e, build_windows, build_windows_e2e, to_global
from filters.extrapolation import cv_extrapolate, cv_extrapolate_at
from filters.imm import IMM

MODELS = ("hybrid", "classic", "e2e", "ensemble")
KF_MODELS = (("CV",), (1.0,))           # фильтр Калмана этапа 1: IMM из одной модели CV
from models import build_corrector
from pipeline import hypotheses as hyp
from training import dataset
from training.trainer import predict


def export_member(ctx, method: str, seed: int, out: Path, prefix: str = "member") -> dict:
    """Пишет <prefix>_<seed>.pt для метода реестра (корректор или сочетание гипотез); возвращает описание."""
    stage, label = method.split("/", 1)
    ex = ctx.registry.data[method][str(seed)]["extra"]
    if ex.get("spec"):
        spec = sorted(ex["spec"])
        roles = ("recognizer", "straight", "turn") if "modular" in spec else ("main",)
        store_label = hyp.spec_store_label(ctx, method, ex)       # с подписью основы, если она сменилась
        states, norm = {}, None
        for role in roles:
            payload, _ = ctx.store.load(stage, ctx.case, f"{store_label}|{role}", seed)
            states[role], norm = payload["state_dict"], payload["normalizer"]
        torch.save({"kind": "spec", "spec": spec, "states": states, "normalizer": norm, "corrector": ex["corrector"],
                    "window": ex["window"], "hp": ex["hp"], "n_feat": len(norm["x_mean"])}, out / f"{prefix}_{seed}.pt")
    else:
        e2e = ex.get("mode") == "e2e"
        store_label = label + (" [доплер]" if e2e and ctx.case != "nodop" else "")    # как run_stage2.variant_tag
        payload, _ = ctx.store.load(stage, ctx.case, f"{store_label}, seed {seed}", seed)
        torch.save({"kind": "e2e" if e2e else "corrector", "state_dict": payload["state_dict"],
                    "normalizer": payload["normalizer"], "corrector": payload["corrector"], "window": payload["window"],
                    "model_kwargs": payload["model_kwargs"]}, out / f"{prefix}_{seed}.pt")
    return {"seed": seed, "file": f"{prefix}_{seed}.pt"}


class _Member:
    def __init__(self, path: Path, device):
        ck = torch.load(path, map_location="cpu", weights_only=False)
        self.kind, self.device = ck["kind"], device
        self.norm = dataset.Normalizer.from_dict(ck["normalizer"])
        self.window = ck["window"]
        n_feat = len(ck["normalizer"]["x_mean"])
        if self.kind in ("corrector", "e2e"):
            self.model = build_corrector(ck["corrector"], n_feat, config.HORIZON_SCANS, self.window, **ck["model_kwargs"])
            self.model.load_state_dict(ck["state_dict"])
            self.model.to(device).eval()
        else:
            bc = hyp.BaseConfig(ck["corrector"], self.window, True, ck["hp"], {})
            spec = frozenset(ck["spec"])
            nets = {}
            for role, state in ck["states"].items():
                net = hyp._builders(bc, ck["hp"], n_feat, spec)[role]()
                net.load_state_dict(state)
                nets[role] = net
            self.spec_nets = hyp.SpecNets(spec, nets, self.norm, n_feat, self.window)

    def correction(self, x: np.ndarray) -> np.ndarray:
        """Поправка к прогнозу IMM (N, H, 2) в метрах; у сети без IMM (e2e) - смещение от последней отметки."""
        xn = self.norm.x(x)
        if self.kind in ("corrector", "e2e"):
            return self.norm.y_inv(predict(self.model, xn, self.device))
        return self.spec_nets.predict(xn, self.device)[0]

    def forecast(self, rt, run, only: list = None) -> np.ndarray:
        """Прогноз участника (K, H, 3) по трассе (nan вне обзоров окна); вызывать под подменами config пакета."""
        w = build_windows(rt, run, window=self.window, with_target=False, only=only)
        out = np.full_like(run.forecast, np.nan)
        if not len(w["k"]):
            return out
        if self.kind == "e2e":
            e = build_windows_e2e(rt, w["k"], window=self.window, with_target=False)
            out[w["k"]] = apply_e2e(rt, w["k"], e["psi"], self.correction(e["x"]))[w["k"]]
        else:
            out[w["k"]] = apply_correction(run.forecast, w["k"], w["psi"], self.correction(w["x"]))[w["k"]]
        return out

    def variants(self, x: np.ndarray) -> tuple:
        """Сеть «три варианта прогноза»: (варианты поправки (N, K, H, 2) в метрах, вероятности (N, K))."""
        aux = self.spec_nets.predict(self.norm.x(x), self.device)[1]
        return aux["hyps"], aux["probs"]


def _global_variants(forecast: np.ndarray, ks: np.ndarray, psi: np.ndarray, hyps: np.ndarray) -> np.ndarray:
    """Положения вариантов по горизонтали (N, K, H, 2): прогноз IMM в обзорах ks плюс поправка варианта."""
    return forecast[ks][:, None, :, :2] + to_global(hyps.astype(float), psi[:, None, None])


class FinalPredictor:
    """IMM случая + итоговая сеть (или среднее поправок seed при ensemble=True) по пакету bundle_dir."""

    def __init__(self, bundle_dir: Path, device: torch.device, ensemble: bool = False, members: list = None):
        """members - seed участников (например [43]); None - все при ensemble, иначе первый."""
        cfg = json.loads((Path(bundle_dir) / "config.json").read_text(encoding="utf-8"))
        self.cfg, self.device = cfg, device
        self.override = cfg["override"]
        self.window = cfg["window"]
        self.case = cfg["case"]
        self.model = cfg.get("model", "hybrid")
        if self.model not in MODELS:
            raise ValueError(f"Пакет {bundle_dir}: неизвестный вид модели {self.model!r}, есть {MODELS}")
        self.classic = cfg.get("classic")
        if self.model in ("classic", "ensemble"):
            if members is not None or ensemble:
                raise ValueError(f"Пакет {bundle_dir} ({self.model}): участники не выбираются")
            files = [p["file"] for p in cfg.get("parts", [])]
            self.member_seeds = []
        else:
            by_seed = {int(m["seed"]): m["file"] for m in cfg["members"]}
            if members is not None:
                missing = [s for s in members if int(s) not in by_seed]
                if missing or not members:
                    raise ValueError(f"В пакете {bundle_dir} нет участников {missing or members}; есть {sorted(by_seed)}")
                files = [by_seed[int(s)] for s in members]
            else:
                files = list(by_seed.values()) if ensemble else [cfg["members"][0]["file"]]
            self.member_seeds = [s for s, f in by_seed.items() if f in files]
        self.members = [_Member(Path(bundle_dir) / f, device) for f in files]
        self.mean_corr = self.model == "hybrid"      # гибрид - среднее поправок; иначе среднее прогнозов
        multi = cfg.get("multi")
        self.multi = _Member(Path(bundle_dir) / multi["file"], device) if multi else None
        self.multi_override = multi["override"] if multi else None
        self.gate = cfg.get("gate")
        label = cfg["label"]
        self.title = cfg.get("title") or (label if label.startswith("IMM") else f"IMM+{label}")
        self.note = cfg.get("note", "")
        n = len(self.members)
        self.name = self.title + (f" (среднее {n} seed)" if n > 1 and self.model in ("hybrid", "e2e") else "")

    @property
    def sensor_override(self) -> dict:
        """Подмены модели РЛС (доплер и его источник скорости) для моделирования отметок из лога."""
        keys = ("DOPPLER_IN_IMM", "DOPPLER_IN_NET", "DOPPLER_TRUTH")
        return {k: self.override[k] for k in keys if k in self.override}

    def run(self, rt) -> dict:
        """
        Прогнозы (K, H, 3): imm - IMM, hyb - гибрид (nan, пока окно не набралось); imm_pos (K, 3) - оценка IMM
        положения в момент обзора k (ENU, nan до запуска фильтра). Если в пакете есть сеть «три варианта»: variants
        (K, 3, H, 2) - положения вариантов по горизонтали, probs (K, 3) - их вероятности.
        """
        with config_override(self.override):
            run = IMM().run(rt)
            w = build_windows(rt, run, window=self.window, with_target=False)
            hyb = np.full_like(run.forecast, np.nan)
            if self.model == "classic":
                hyb = self._classic(rt)
            elif self.mean_corr:
                if len(w["k"]):
                    corr = np.mean([m.correction(w["x"]) for m in self.members], axis=0)
                    hyb[w["k"]] = apply_correction(run.forecast, w["k"], w["psi"], corr)[w["k"]]
            else:
                hyb = np.mean([m.forecast(rt, run) for m in self.members], axis=0)
        out = {"imm": run.forecast, "hyb": hyb, "ks": w["k"], "imm_pos": run.est[:, :3].copy()}
        if self.multi is not None:
            with config_override(self.multi_override):
                wm = build_windows(rt, run, window=self.multi.window, with_target=False)
            k_total, h = run.forecast.shape[:2]
            out["variants"] = np.full((k_total, 3, h, 2), np.nan)
            out["probs"] = np.full((k_total, 3), np.nan)
            if len(wm["k"]):
                hyps, probs = self.multi.variants(wm["x"])
                out["variants"][wm["k"]] = _global_variants(run.forecast, wm["k"], wm["psi"], hyps)
                out["probs"][wm["k"]] = probs
        return out

    def _classic(self, rt) -> np.ndarray:
        """Прогноз метода этапа 1 (K, H, 3): линейная экстраполяция или фильтр Калмана с подменами подбора."""
        if self.classic["method"] == "cv":
            return cv_extrapolate(rt, n_points=int(self.classic["n_points"]))
        with config_override(self.classic["override"]):
            return IMM(KF_MODELS[0], mu0=KF_MODELS[1]).run(rt).forecast


class OnlinePredictor:
    """
    Тот же прогноз, что FinalPredictor.run, но по одной отметке: update(...) принимает обзор и сразу возвращает
    прогноз из него (программа реального времени). Состояние IMM - IMMStream; окно сети строится только для
    последнего обзора из накопленной истории (признаки причинные, поэтому окно то же, что при прогоне трассы).
    Координаты - ENU с началом в точке отсчёта трассы; РЛС в radar_pos (для отметок из файла РЛС - в начале).
    """

    def __init__(self, bundle_dir: Path, device: torch.device = torch.device("cpu"), ensemble: bool = False,
                 radar_pos: np.ndarray = None, members: list = None):
        self.fp = FinalPredictor(bundle_dir, device, ensemble, members)
        self.has_vr = self.fp.case != "nodop"
        self.radar_pos = np.zeros(3) if radar_pos is None else np.asarray(radar_pos, dtype=float)
        with config_override(self.fp.override):
            self.stream = IMM().stream(self.radar_pos, self.has_vr)
            self.m, self.h = self.stream.imm.m, self.stream.imm.horizon
        self.kf_stream = None
        if self.fp.model == "classic" and self.fp.classic["method"] == "kf":
            with config_override(self.fp.classic["override"]):
                self.kf_stream = IMM(KF_MODELS[0], mu0=KF_MODELS[1]).stream(self.radar_pos, self.has_vr)
        self.n = 0
        self._alloc(256)

    def _alloc(self, cap: int) -> None:
        def grow(name, shape, dtype=float, fill=np.nan):
            new = np.full((cap,) + shape, fill, dtype=dtype)
            old = getattr(self, name, None)
            if old is not None:
                new[:self.n] = old[:self.n]
            setattr(self, name, new)
        grow("t", ())
        grow("detected", (), bool, False)
        grow("polar", (3,))
        grow("meas", (3,))
        grow("vr", ())
        grow("est", (9,))
        grow("mu", (self.m,))
        grow("innov", (3,))
        grow("nis", (self.m,))
        grow("vr_innov", ())
        grow("forecast", (self.h, 3))
        self.cap = cap

    def _views(self) -> tuple:
        n = self.n
        rt = SimpleNamespace(t=self.t[:n], detected=self.detected[:n], meas=self.meas[:n], polar=self.polar[:n],
                             vr=self.vr[:n] if self.has_vr else None)
        run = SimpleNamespace(est=self.est[:n], mu=self.mu[:n], innov=self.innov[:n], nis=self.nis[:n],
                              forecast=self.forecast[:n], vr_innov=self.vr_innov[:n] if self.has_vr else None)
        return rt, run

    def update(self, t: float, detected: bool, polar: np.ndarray, meas: np.ndarray, meas_cov: np.ndarray,
               vr: float = np.nan) -> dict:
        """
        Один обзор: polar - (дальность, азимут, угол места) в радианах, meas и meas_cov - отметка в ENU и её
        ковариация (radar.model: polar_to_enu + radar_pos, converted_cov). Возвращает k, imm_pos (3,) - оценку IMM
        положения в этом обзоре (ENU) или None, imm и hyb (H, 3) или None, variants (3, H, 2) и probs (3,) при сети
        «три варианта», gate (радиусы строба) и время, мс.
        """
        if self.n == self.cap:
            self._alloc(2 * self.cap)
        k = self.n
        t0 = time.perf_counter()
        self.t[k], self.detected[k] = t, detected
        self.polar[k], self.meas[k] = (polar, meas) if detected else (np.nan, np.nan)
        self.vr[k] = vr if detected else np.nan
        self.n += 1
        fp = self.fp
        kf_row = None
        if self.kf_stream is not None:      # фильтр Калмана - свой поток по тем же отметкам
            with config_override(fp.classic["override"]):
                kf_row = self.kf_stream.update(k, t, detected, self.meas[k], meas_cov, self.vr[k])
        with config_override(fp.override):
            row = self.stream.update(k, t, detected, self.meas[k], meas_cov, self.vr[k])
            t_imm = time.perf_counter()
            out = {"k": k, "imm_pos": None, "imm": None, "hyb": None, "gate": fp.gate}
            if row is None:
                out["ms"] = {"imm": (t_imm - t0) * 1e3, "net": 0.0}
                return out
            self.est[k], self.mu[k], self.innov[k], self.nis[k] = row["est"], row["mu"], row["innov"], row["nis"]
            self.forecast[k], self.vr_innov[k] = row["forecast"], row["vr_innov"]
            out["imm"] = row["forecast"]
            out["imm_pos"] = np.asarray(row["est"][:3], dtype=float).copy()
            rt, run = self._views()
            w = build_windows(rt, run, window=fp.window, with_target=False, only=[k])
            if fp.model == "classic":
                if fp.classic["method"] == "cv":
                    fc = cv_extrapolate_at(rt, k, n_points=int(fp.classic["n_points"]), horizon=self.h)
                else:
                    fc = kf_row["forecast"] if kf_row is not None else np.full((self.h, 3), np.nan)
                out["hyb"] = None if np.isnan(fc).all() else fc
            elif not fp.mean_corr:
                fc = np.mean([mb.forecast(rt, run, only=[k])[k] for mb in fp.members], axis=0)
                out["hyb"] = None if np.isnan(fc).all() else fc
        if fp.mean_corr and len(w["k"]):
            corr = np.mean([mb.correction(w["x"]) for mb in fp.members], axis=0)
            out["hyb"] = apply_correction(run.forecast, w["k"], w["psi"], corr)[k]
        if fp.multi is not None:
            with config_override(fp.multi_override):
                wm = build_windows(rt, run, window=fp.multi.window, with_target=False, only=[k])
            if len(wm["k"]):
                hyps, probs = fp.multi.variants(wm["x"])
                out["variants"] = _global_variants(run.forecast, wm["k"], wm["psi"], hyps)[0]
                out["probs"] = probs[0]
        out["ms"] = {"imm": (t_imm - t0) * 1e3, "net": (time.perf_counter() - t_imm) * 1e3}
        return out
