"""
Запись пакета модели из реестра и хранилища (этап 11, export_bundle.py) и проверка пакета.

Пакет - формат pipeline/bundle.py: config.json, веса участников, по желанию сеть «три варианта» (multi) и радиусы
строба (gate). Пакетом можно сделать (config["model"]):
  hybrid   - корректор (этапы 2-4: mode "hybrid") и сочетание гипотез (этапы 6-7, spec);
  e2e      - сеть без IMM этапа 2;
  classic  - stage1/CV и stage1/KF (подобранные; исходные - нет: их параметры не хранятся отдельно);
  ensemble - жадный ансамбль этапа 8, если все его участники - гибриды, сочетания гипотез или сети без IMM.
Нельзя: схемы этапа 5 (сеть внутри фильтра или управляет им - другой прогон фильтра; поэтому и ансамбли с ними) и
модели анализа этапа 9 (обучены при другом шуме РЛС или точности доплера; подмены config в пакете - штатные).
Проверка пакета: ADE на val (первый участник; у classic и ensemble - вся модель) равна записи реестра (порог
BUNDLE_ADE_TOL).
"""

import json
from pathlib import Path

import numpy as np
import torch

import config
from eval import metrics
from pipeline import bundle
from pipeline import hypotheses as hyp

BUNDLE_ADE_TOL = 0.005      # доля: ADE пакета на val против реестра


def ade_of(pred, rts: list, ks: list) -> float:
    """ADE прогнозов пакета на обзорах оценки ks (тех же, что у реестра). Без маски в счёт попадали последние
    HORIZON_SCANS обзоров трассы, где истина есть только для коротких горизонтов: ADE выходила ниже реестра
    (merged_x1: на 1,2-1,4%, трасс много и они короче)."""
    pairs = []
    for rt, k in zip(rts, ks):
        out = pred.run(rt)
        masked = np.full_like(out["hyb"], np.nan)
        masked[k] = out["hyb"][k]
        pairs.append(metrics.forecast_pairs(rt, masked))
    return metrics.summarize(metrics.concat_pairs(pairs))["ade"]


def gate_errors(pred, rts: list, ks: list) -> tuple:
    """Ошибки на горизонтах 1..H на обзорах ks: гибрида и ближайшего из трёх вариантов; варианты в момент H."""
    h_total = config.HORIZON_SCANS
    one, many, last = [[] for _ in range(h_total)], [[] for _ in range(h_total)], []
    for rt, k in zip(rts, ks):
        out = pred.run(rt)
        for h in range(h_total):
            kk = k[k + h + 1 < len(rt.t)]
            truth = rt.truth[kk + h + 1, :2]
            one[h].append(np.linalg.norm(out["hyb"][kk, h, :2] - truth, axis=1))
            if "variants" in out:
                many[h].append(np.linalg.norm(out["variants"][kk, :, h] - truth[:, None], axis=2).min(axis=1))
                if h == h_total - 1:
                    last.append(out["variants"][kk, :, h])
    cat = lambda lst: [np.concatenate(v) if v else np.zeros(0) for v in lst]  # noqa: E731
    one, many = cat(one), cat(many)
    last = np.concatenate(last) if last else np.zeros((0, 3, 2))
    keep = [np.isfinite(e) for e in one]
    return [e[m] for e, m in zip(one, keep)], [e[np.isfinite(e)] for e in many], last[np.isfinite(last).all(axis=(1, 2))]


def gate_from_errors(one: list, many: list) -> dict:
    """Радиусы строба по горизонтам: конформные квантили ошибок на val (круг; три круга, если есть варианты)."""
    cov = config.GATE_COVERAGE
    return {"coverage": cov, "calibrated_on": "val", "horizon_s": [config.SCAN_PERIOD * (h + 1) for h in range(len(one))],
            "r_one": [metrics.conformal_quantile(e, cov) for e in one],
            "r_multi": [metrics.conformal_quantile(e, cov) for e in many] if many and all(len(e) for e in many) else None}


CLASSIC = {"stage1/CV": "cv", "stage1/KF": "kf"}


def exportable(reg, method: str) -> str:
    """Пустая строка - метод можно записать пакетом; иначе причина."""
    if not reg.has(method):
        return "нет в реестре случая"
    if method in CLASSIC:
        return ""
    if method.startswith("stage9/"):
        return "обучена в условиях анализа этапа 9 (другой шум РЛС или точность доплера), пакет их не хранит"
    ex = reg.data[method][str(reg.seeds(method)[0])]["extra"]
    if method.startswith("stage8/"):
        bad = [m for m, _ in ex.get("members", []) if exportable(reg, m)]
        return f"в ансамбле есть участники, которых нельзя записать пакетом: {sorted(set(bad))}" if bad else ""
    if ex.get("spec"):
        return ""
    if ex.get("mode") not in ("hybrid", "e2e") or "corrector" not in ex:
        return "не корректор «IMM + сеть» и не сеть без IMM (схема этапа 5 или классический метод)"
    return ""


def model_of(reg, method: str) -> str:
    """Вид модели пакета (config["model"]) для метода реестра, который можно записать (exportable)."""
    if method in CLASSIC:
        return "classic"
    if method.startswith("stage8/"):
        return "ensemble"
    ex = reg.data[method][str(reg.seeds(method)[0])]["extra"]
    return "e2e" if ex.get("mode") == "e2e" else "hybrid"


def classic_config(ctx, method: str, out: Path) -> tuple:
    """config пакета метода этапа 1 (CV или KF с параметрами подбора из состояния classic); (cfg, CaseData)."""
    from common import cases

    st = ctx.state("classic")
    cd = ctx.casedata()
    if CLASSIC[method] == "cv":
        classic = {"method": "cv", "n_points": int(st["cv_points"])}
    else:
        classic = {"method": "kf", "override": {**cd.override(), **st["kf"],
                                                **cases.overrides(ctx.case, False, st["kf_sigma_vr"])}}
    out.mkdir(parents=True, exist_ok=True)
    ex = ctx.registry.data[method]["0"]["extra"]
    label = {"cv": "Линейная экстраполяция", "kf": "Фильтр Калмана"}[classic["method"]]
    cfg = {"case": ctx.case, "method": method, "label": label, "title": label, "note": "", "model": "classic",
           "classic": classic, "window": config.WINDOW_SCANS, "override": cd.override(), "members": [], "spec": [],
           "response_ms": {k: ex.get(k) for k in ("imm_ms", "total_cpu_ms")}, "run": config.RUN_NAME}
    return cfg, cd


def ensemble_config(ctx, method: str, out: Path) -> tuple:
    """config пакета жадного ансамбля этапа 8: parts - участники (метод, seed) со своими весами; (cfg, CaseData)."""
    reg = ctx.registry
    ex = reg.data[method]["0"]["extra"]
    out.mkdir(parents=True, exist_ok=True)
    parts, windows = [], set()
    for i, (m, s) in enumerate(ex["members"]):
        ex_m = reg.data[m][str(s)]["extra"]
        windows.add(ex_m["window"])
        parts.append({**bundle.export_member(ctx, m, int(s), out, prefix=f"part{i}"), "method": m})
    if len(windows) != 1:
        raise ValueError(f"{method}: участники с разными окнами {sorted(windows)} - пакет строит окна одного размера")
    cd = ctx.casedata(window=windows.pop(), net_input=True)
    label = method.split("/", 1)[1]
    cfg = {"case": ctx.case, "method": method, "label": label, "title": label, "note": "", "model": "ensemble",
           "window": cd.window, "override": cd.override(), "members": [], "parts": parts, "spec": [],
           "response_ms": {k: ex.get(k) for k in ("imm_ms", "net_cpu_ms", "net_gpu_ms", "total_cpu_ms", "total_gpu_ms")},
           "run": config.RUN_NAME}
    return cfg, cd


def display_label(method: str, extra: dict) -> str:
    """Подпись модели для приложения: у сочетания гипотез - корректор и гипотезы («IMM+LSTM, потери ADE вместо MSE»)."""
    label = method.split("/", 1)[1]
    spec = extra.get("spec") or []
    if not spec:
        return label
    return f"IMM+{extra['corrector']}, " + ", ".join(hyp.TITLES[h] for h in hyp.HYPS if h in spec)


def bundle_config(ctx, method: str, out: Path, seeds: list = None) -> tuple:
    """Участники (seeds; None - все seed реестра) и config пакета без строба и сети «три варианта»; (cfg, CaseData)."""
    reg = ctx.registry
    seeds = [int(s) for s in (seeds or reg.seeds(method))]
    ex = reg.data[method][str(seeds[0])]["extra"]
    cd = ctx.casedata(window=ex["window"], net_input=ex["net_input"])
    out.mkdir(parents=True, exist_ok=True)
    members = [bundle.export_member(ctx, method, s, out) for s in seeds]
    label = method.split("/", 1)[1]
    cfg = {"case": ctx.case, "method": method, "label": label, "title": display_label(method, ex), "note": "",
           "window": ex["window"], "model": "e2e" if ex.get("mode") == "e2e" else "hybrid",
           "override": cd.override(), "members": members, "spec": ex.get("spec", []), "corrector": ex["corrector"],
           "hp": ex["hp"],
           "response_ms": {k: ex.get(k) for k in ("imm_ms", "net_cpu_ms", "net_gpu_ms", "total_cpu_ms", "total_gpu_ms")},
           "run": config.RUN_NAME}
    return cfg, cd


def add_multi(ctx, cfg: dict, out: Path, multi_method: str, seed: int) -> None:
    """Сеть «три варианта прогноза» (этап 6) в пакет: multi_<seed>.pt и config["multi"]."""
    reg = ctx.registry
    m_seed = seed if seed in reg.seeds(multi_method) else reg.seeds(multi_method)[0]
    ex_m = reg.data[multi_method][str(m_seed)]["extra"]
    cd_m = ctx.casedata(window=ex_m["window"], net_input=ex_m["net_input"])
    cfg["multi"] = {**bundle.export_member(ctx, multi_method, m_seed, out, prefix="multi"), "method": multi_method,
                    "override": cd_m.override()}


def write_config(out: Path, cfg: dict) -> None:
    (out / "config.json").write_text(json.dumps(cfg, ensure_ascii=False, indent=1, default=float), encoding="utf-8")


def check_and_gate(ctx, method: str, out: Path, cfg: dict, cd) -> tuple:
    """ADE пакета на val (первый участник; classic и ensemble - вся модель, запись реестра seed 0) против реестра и
    строб по val; пишет config с gate. (ADE пакета, реестра)."""
    p1 = bundle.FinalPredictor(out, torch.device("cpu"))
    rts, ks = cd.eval("val")[1], cd.ks("val")
    got = ade_of(p1, rts, ks)
    seed = int(cfg["members"][0]["seed"]) if cfg["members"] else 0
    want = ctx.registry.report(method, "val", seed)["ade"]
    one, many, _ = gate_errors(p1, rts, ks)
    cfg["gate"] = gate_from_errors(one, many)
    write_config(out, cfg)
    return got, want
