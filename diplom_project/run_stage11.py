"""
Этап 11: программа - пакеты итоговых моделей для predict.py.

Для случая пишет artifacts/<прогон>/stage11/<случай>/ (pipeline/bundle.py): подмены config, окно, сеть и веса
всех seed итоговой модели этапа 7. Проверка: предсказатель из пакета (FinalPredictor), прогнавший трассы val
по одной, даёт ту же ADE, что запись реестра (3 seed и среднее поправок), и обрабатывает обзор за считанные
миллисекунды (процессор). Для приложения визуализации в пакет добавляются сеть «три варианта
прогноза» этапа 6 и радиусы строба по горизонтам (конформные квантили на val: круг вокруг прогноза гибрида и три
круга вокруг вариантов), а пошаговый предсказатель (OnlinePredictor) сверяется с прогоном трассы целиком.
Пакеты для сравнения в приложении: лучшие IMM + LSTM / GRU / Transformer / Mamba этапа 2 (без «быстрых»
и кроме итоговой) - в compare/<имя>/ того же случая, в том же формате (3 seed, радиус строба круга), из уже обученных
весов; проверка - ADE пакета на val равна реестру. Сети без IMM пакетом не поддерживаются (FinalPredictor - IMM +
сеть). Пакет - вход predict.py:
  python predict.py --log flight_logs/<файл>.csv --case dop_traj [--ensemble]

  .venv\\Scripts\\python.exe run_stage11.py [--case ...] [--smoke]
"""

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402
import torch  # noqa: E402

import config  # noqa: E402
from common import cases  # noqa: E402
from pipeline import bundle, hypotheses as hyp  # noqa: E402
from pipeline.bundle_export import (BUNDLE_ADE_TOL, add_multi, ade_of, bundle_config, check_and_gate,  # noqa: E402
                                    gate_errors, gate_from_errors, write_config)
from pipeline.hypotheses import union_area  # noqa: E402
from pipeline.stage import Ctx, run_stage  # noqa: E402

STAGE = "stage11"


ONLINE_TOL_M = 1e-3     # пошаговый прогноз против прогона трассы: сеть в float32, батч 1 против батча трассы


def online_check(ctx, out, rts: list) -> tuple:
    """Пошаговый предсказатель против прогона трассы: наибольшее расхождение (м) и время на обзор (мс)."""
    full = bundle.FinalPredictor(out, torch.device("cpu"))
    diff, imm_ms, net_ms, n = 0.0, 0.0, 0.0, 0
    for rt in rts:
        ref = full.run(rt)
        op = bundle.OnlinePredictor(out, radar_pos=rt.radar_pos)
        for k in range(len(rt.t)):
            res = op.update(rt.t[k], bool(rt.detected[k]), rt.polar[k], rt.meas[k], rt.meas_cov[k],
                            rt.vr[k] if rt.vr is not None else np.nan)
            imm_ms, net_ms, n = imm_ms + res["ms"]["imm"], net_ms + res["ms"]["net"], n + 1
            if res["imm"] is not None:
                diff = max(diff, float(np.nanmax(np.abs(res["imm"] - ref["imm"][k]), initial=0.0)))
            if res["hyb"] is not None:
                diff = max(diff, float(np.nanmax(np.abs(res["hyb"] - ref["hyb"][k]), initial=0.0)))
            elif np.isfinite(ref["hyb"][k]).any():
                diff = float("inf")
            if "variants" in res:
                diff = max(diff, float(np.nanmax(np.abs(res["variants"] - ref["variants"][k]), initial=0.0)))
    return diff, imm_ms / max(n, 1), net_ms / max(n, 1)


COMPARE = ("IMM+LSTM", "IMM+GRU", "IMM+Transformer", "IMM+Mamba")      # этап 2; папка - имя без «+»


def compare_bundles(ctx: Ctx, final: str) -> None:
    """Пакеты корректоров этапа 2 для сравнения в приложении: compare/<имя>/, проверка ADE val против реестра."""
    summary, reg = ctx.summary, ctx.registry
    root = ctx.paths.artifacts(STAGE, ctx.case) / "compare"
    lines = [f"{'модель':18s} {'папка':18s} {'ADE val реестр':>15s} {'пакет':>7s} {'ADE test':>9s} {'мс CPU':>7s} "
             f"{'r круга 10 с':>13s}"]
    for label in COMPARE:
        method = f"stage2/{label}"
        if method == final or not reg.has(method):
            continue
        out = root / label.replace("+", "_")
        cfg, cd = bundle_config(ctx, method, out)
        cfg.update(role="compare", note="корректор этапа 2 для сравнения (лучший по ADE val)")
        write_config(out, cfg)
        got, want = check_and_gate(ctx, method, out, cfg, cd)
        summary.check(f"Пакет для сравнения {label}: повторяет реестр на val (1 seed)", abs(got / want - 1) <= BUNDLE_ADE_TOL,
                      f"ADE val реестра {want:.2f} м, пакета {got:.2f} м")
        test = reg.metric(method, "test")[0]
        lines.append(f"{label:18s} {out.name:18s} {want:15.2f} {got:7.2f} {test:9.2f} "
                     f"{cfg['response_ms'].get('total_cpu_ms') or float('nan'):7.2f} {cfg['gate']['r_one'][-1]:13.1f}")
    summary.section("Пакеты для сравнения в приложении (compare/, этап 2, 3 seed; ADE test - среднее по seed)", lines)


def run_case(ctx: Ctx) -> bool:
    summary, reg = ctx.summary, ctx.registry
    fin = ctx.state("final")
    if fin is None:
        summary.check("Итоговая модель случая выбрана на этапе 7", False, "нет состояния final")
        return False
    method = fin["method"]
    seeds = reg.seeds(method)
    out = ctx.paths.artifacts(STAGE, ctx.case)
    cfg, cd = bundle_config(ctx, method, out)
    cfg.update(role="final", title=f"Итоговая модель: {cfg['title']}", note="итоговая модель случая (этап 7)")
    members = cfg["members"]
    hyp_state = ctx.state("hyp") or {}
    multi_method = next((r["method"] for r in hyp_state.get("rows", []) if r["hyp"] == "multi"), None)
    if multi_method and reg.has(multi_method):
        add_multi(ctx, cfg, out, multi_method, seeds[0])
    write_config(out, cfg)
    (out.parent / "splits.json").write_bytes((ctx.paths.stage0 / "splits.json").read_bytes())   # для приложения
    summary.check("Пакет итоговой модели записан", (out / "config.json").exists() and all((out / m["file"]).exists() for m in members),
                  f"{out}, участников {len(members)}")

    rts, ks = cd.eval("val")[1], cd.ks("val")
    p1 = bundle.FinalPredictor(out, torch.device("cpu"), ensemble=False)
    got = ade_of(p1, rts, ks)
    want = reg.report(method, "val", seeds[0])["ade"]
    summary.check("Предсказатель из пакета (1 seed) повторяет результат этапа 7 на val", abs(got / want - 1) <= BUNDLE_ADE_TOL,
                  f"ADE val реестра {want:.2f} м, пакета {got:.2f} м")
    pe = bundle.FinalPredictor(out, torch.device("cpu"), ensemble=True)
    got_e = ade_of(pe, rts, ks)
    summary.section("Пакет", [f"{p1.name}: ADE val {got:.2f} м; {pe.name}: ADE val {got_e:.2f} м",
                              f"подмены config: {cfg['override']}"])
    # строб для приложения: радиусы по val, покрытие и площадь - на test
    one, many, _ = gate_errors(p1, rts, ks)
    cov = config.GATE_COVERAGE
    gate = gate_from_errors(one, many)
    cfg["gate"] = gate
    write_config(out, cfg)
    t_one, t_many, t_last = gate_errors(bundle.FinalPredictor(out, torch.device("cpu")), cd.eval("test")[1], cd.ks("test"))
    lines = [f"{'горизонт, с':>12s} {'r круга, м':>11s} {'покрытие test':>14s} {'r трёх, м':>10s} {'покрытие test':>14s}"]
    for h, sec in enumerate(gate["horizon_s"]):
        r3 = gate["r_multi"][h] if gate["r_multi"] else float("nan")
        c3 = float((t_many[h] <= r3).mean()) if gate["r_multi"] and len(t_many[h]) else float("nan")
        lines.append(f"{sec:12g} {gate['r_one'][h]:11.1f} {float((t_one[h] <= gate['r_one'][h]).mean()):14.3f} "
                     f"{r3:10.1f} {c3:14.3f}")
    if gate["r_multi"] and len(t_last):
        a1, a3 = np.pi * gate["r_one"][-1] ** 2, union_area(t_last, gate["r_multi"][-1])
        lines.append(f"площадь на {gate['horizon_s'][-1]:g} с (test): круг {a1:.0f} м^2, три круга {a3:.0f} м^2 ({a3 / a1 - 1:+.1%})")
    summary.section(f"Строб для приложения (покрытие {cov:.0%}, радиусы - конформные квантили на val)", lines)
    summary.check("Строб: на val покрытие не ниже заданного (по построению)", all(
        float((e <= r).mean()) >= cov - 1e-9 for e, r in zip(one, gate["r_one"])), f"радиусы {gate['r_one']}")
    diff, imm_ms, net_ms = online_check(ctx, out, rts[:2])
    summary.check("Пошаговый прогноз (по одной отметке) совпадает с прогоном трассы", diff <= ONLINE_TOL_M,
                  f"наибольшее расхождение {diff:.2e} м на 2 трассах val")
    summary.section("Пошаговый прогноз (процессор, одна отметка)", [
        f"шаг IMM {imm_ms:.2f} мс, окно и сеть{' и три варианта' if 'multi' in cfg else ''} {net_ms:.2f} мс на обзор"])
    scans = sum(len(rt.t) for rt in rts[:3])
    t0 = time.perf_counter()
    for rt in rts[:3]:
        p1.run(rt)
    ms = (time.perf_counter() - t0) / scans * 1000
    summary.section("Время обработки пакетом (процессор, весь трек за один проход)", [
        f"{ms:.2f} мс на обзор (ориентир: время отклика реестра {cfg['response_ms'].get('total_cpu_ms')} мс)"])
    compare_bundles(ctx, method)
    return True


def main() -> int:
    return run_stage(STAGE, "Этап 11: пакеты итоговых моделей для программы", run_case)


if __name__ == "__main__":
    sys.exit(main())
