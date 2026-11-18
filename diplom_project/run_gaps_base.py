"""
Пропуски отметок для основы на MSE: тот же расчёт, что раздел gaps этапа 9, но не для итоговой
модели этапа 7 (у merged_x1 это корректор с потерями ADE), а для её основы - корректора этапа 2, обученного по
MSE. Именно основа на MSE - итоговая модель в тексте диплома (40,8 / 36,0 / 36,5 м на test).

Сети не переобучаются: берутся из хранилища моделей (3 seed основы), меняется только вероятность обнаружения
RADAR_PD из PD_LEVELS; шум отметок от P_d не зависит, пропуски при меньшей P_d включают пропуски при большей.
Кроме ADE считаются ошибки на входе в маневр и на маневре и разность ADE основы и IMM на одних и тех же
полётах с интервалом 95% (бутстрап по полётам, eval/bootstrap.py) - значимо ли гибрид точнее IMM при пропусках.

Проверяется: при P_d = 1 ADE основы совпадает с записанной в реестре (те же сети, те же данные); доля
пропусков соответствует 1 - P_d (PD_MISS_TOL).

  .venv\\Scripts\\python.exe run_gaps_base.py [--case nodop|dop_traj|dop_tele|all] [--smoke]
Результат: results/<прогон>/stage9_gaps_base/<случай>/summary.txt и gaps_base.png. Время - минуты, обучения нет.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import matplotlib  # noqa: E402

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

import config  # noqa: E402
from common import cases  # noqa: E402
from eval import bootstrap, metrics  # noqa: E402
from pipeline import evaluation, hypotheses as hyp, predictors  # noqa: E402
from pipeline.data import flight_key  # noqa: E402
from pipeline.stage import Ctx, run_stage  # noqa: E402
from viz.plots import _save  # noqa: E402

STAGE = "stage9_gaps_base"
METHODS = ("IMM", "KF", "основа", "ансамбль seed")
ADE_TOL = 0.05  # м: расхождение с реестром при P_d = 1


class Base:
    """Основа случая (этап 2, потери MSE): окна, сети по seed, поправки на любом варианте данных."""

    def __init__(self, ctx: Ctx):
        fin = ctx.state("final")
        self.method = fin["base_method"]
        self.seeds = ctx.registry.seeds(self.method)
        ex = ctx.registry.data[self.method][str(self.seeds[0])]["extra"]
        self.bc = hyp.BaseConfig(ex["corrector"], ex["window"], ex["net_input"], ex["hp"], ex.get("params", {}))
        self.cd = ctx.casedata(window=self.bc.window, net_input=self.bc.net_input)
        self.ctx = ctx

    def forecasts(self, cd, name: str) -> tuple:
        """Прогнозы основы по seed и ансамбля seed на наборе name."""
        corrs = [predictors.corrections(self.ctx, self.method, s, cd, [name]) for s in self.seeds]
        per_seed = [evaluation.hybrid_forecasts(cd, name, c[name]) for c in corrs]
        ens = predictors.mean_corr(corrs)
        return per_seed, evaluation.hybrid_forecasts(cd, name, ens[name])


def paired_vs_imm(tracks, rts, fc_a, fc_imm) -> dict:
    keys = [flight_key(tr) for tr in tracks]
    pa = [metrics.forecast_pairs(rt, fc) for rt, fc in zip(rts, fc_a)]
    pb = [metrics.forecast_pairs(rt, fc) for rt, fc in zip(rts, fc_imm)]
    _, sa, ca = bootstrap.flight_sums(pa, keys)
    _, sb, cb = bootstrap.flight_sums(pb, keys)
    return bootstrap.paired_difference(sa, ca, sb, cb)


def run_case(ctx: Ctx) -> bool:
    if ctx.state("final") is None:
        ctx.summary.check("Основа случая есть (состояние final этапа 7)", False, "нет состояния final")
        return False
    base = Base(ctx)
    ctx.summary.section("Модель", [f"{base.method} (потери MSE), seed {base.seeds}; сети не переобучались"])
    levels = (1.0, 0.8) if ctx.smoke else config.PD_LEVELS
    names = config.EVAL_SETS
    table = {}
    for pd_ in levels:
        cdp = base.cd.variant(extra={"RADAR_PD": pd_})
        table[pd_] = {}
        for n in names:
            rts = cdp.eval(n)[1]
            classic = evaluation.classic_forecasts(cdp, n)
            per_seed, ens = base.forecasts(cdp, n)
            reps = {m: evaluation.summarize_method(rts, classic[m]) for m in ("IMM", "KF")}
            seed_reps = [evaluation.summarize_method(rts, fc) for fc in per_seed]
            reps["основа"] = {k: float(np.mean([r[k] for r in seed_reps])) for k in ("ade", "entry", "turn")}
            reps["ансамбль seed"] = evaluation.summarize_method(rts, ens)
            # значимость - по первому seed основы против IMM, как сравнение одной модели
            reps["разность с IMM"] = paired_vs_imm(cdp.sets[n], rts, per_seed[0], classic["IMM"])
            table[pd_][n] = reps
            miss = float(1.0 - np.mean([rt.detected.mean() for rt in rts]))
            if pd_ == 1.0:
                ctx.summary.check(f"{n}, P_d = 1: пропусков нет", miss == 0.0, f"доля пропусков {miss:.3f}")
                reg = float(np.mean([ctx.registry.report(base.method, n, s)["ade"] for s in base.seeds]))
                got = reps["основа"]["ade"]
                ctx.summary.check(f"{n}, P_d = 1: ADE основы совпадает с реестром", abs(got - reg) <= ADE_TOL,
                                  f"{got:.2f} м против {reg:.2f} м в реестре")
            else:
                ctx.summary.check(f"{n}, P_d = {pd_}: доля пропусков соответствует",
                                  abs(miss - (1 - pd_)) <= config.PD_MISS_TOL,
                                  f"доля пропусков {miss:.3f} при ожидаемой {1 - pd_:.3f}")
    for n in names:
        lines = [f"{'P_d':>5s}" + "".join(f"{m:>15s}" for m in METHODS) + f"{'основа к IMM':>15s}"
                 + f"{'разность с IMM, м [95%]':>32s}"]
        for pd_ in levels:
            t = table[pd_][n]
            d = t["разность с IMM"]
            lines.append(f"{pd_:5.1f}" + "".join(f"{t[m]['ade']:15.1f}" for m in METHODS)
                         + f"{t['основа']['ade'] / t['IMM']['ade'] - 1:+15.1%}"
                         + f"{d['diff']:+12.2f} [{d['lo']:+.2f}; {d['hi']:+.2f}]"
                         + ("  значимо" if d["better"] else "  не значимо"))
        ctx.summary.section(f"{n}: ADE (м) при пропусках отметок, основа на MSE", lines)
        lines = [f"{'P_d':>5s}" + "".join(f"{m + ', ' + k:>18s}" for m in ("IMM", "основа") for k in ("вход", "маневр"))]
        for pd_ in levels:
            t = table[pd_][n]
            lines.append(f"{pd_:5.1f}" + "".join(f"{t[m][k]:18.1f}" for m in ("IMM", "основа") for k in ("entry", "turn")))
        ctx.summary.section(f"{n}: ошибка на входе в маневр и на маневре (м)", lines)
        if len(levels) > 1:
            first, last = table[levels[0]][n], table[levels[-1]][n]
            ctx.summary.section(f"{n}: рост ADE от P_d = {levels[0]} до {levels[-1]}",
                                [f"{m}: {last[m]['ade'] / first[m]['ade'] - 1:+.1%}" for m in METHODS])
    fig, ax = plt.subplots(figsize=(7, 4.5))
    for m in METHODS:
        ax.plot(levels, [table[p]["test"][m]["ade"] for p in levels], "-o", ms=4, label=m)
    ax.set_xlabel("вероятность обнаружения P_d")
    ax.set_ylabel("ADE test, м")
    ax.invert_xaxis()
    ax.legend(fontsize=8)
    ax.set_title(f"Пропуски отметок, основа на MSE: {cases.CASE_TITLES[ctx.case]}", fontsize=10)
    _save(fig, ctx.out_dir / "gaps_base.png")
    return True


def main() -> int:
    return run_stage(STAGE, "Пропуски отметок для основы на MSE", run_case)


if __name__ == "__main__":
    sys.exit(main())
