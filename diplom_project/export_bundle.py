"""
Пакет обученной модели для приложения визуализации (формат этапа 11, pipeline/bundle.py): «IMM + сеть»,
а также сеть без IMM (stage2/<сеть> (без IMM)), CV и KF этапа 1 (stage1/CV, stage1/KF) и жадный ансамбль этапа 8.

Модель берётся из реестра и хранилища прогона (cache/<прогон>/state, model_store/<прогон>), поэтому запуск - на
том ПК, где модель обучалась (домашний). Пакет пишется в bundles/<прогон>/<случай>/extra/<имя>/ (или --out):
config.json с title и note, веса участников, по желанию сеть «три варианта» этапа 6 и радиусы строба по val.
Проверка (сводка results/<прогон>/export_bundle/<случай>/summary.txt): ADE пакета на val (первый участник) равна
записи реестра. Какие модели можно записать пакетом, а какие нет и почему - pipeline/bundle_export.py; --list
печатает список по случаю.

  $env:DIPLOM_DATA='merged'; $env:DIPLOM_SYNTH='1'
  .venv\\Scripts\\python.exe export_bundle.py --case dop_tele --list
  .venv\\Scripts\\python.exe export_bundle.py --case dop_tele --method "stage4/IMM+стопка LSTM+LSTM+Attention x32" \\
      --seeds 42,43 --title "Стопка этапа 4" --note "лучшая по поиску архитектуры" [--multi]
  --cache и --store - взять реестр и хранилище из другой папки (например, из резервной копии),
  вместо cache/<прогон> и model_store/<прогон>; --name - имя папки пакета в extra/.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import argparse  # noqa: E402

import torch  # noqa: E402

import config  # noqa: E402
from pipeline.bundle import FinalPredictor  # noqa: E402
from pipeline.bundle_export import (BUNDLE_ADE_TOL, add_multi, ade_of, bundle_config, check_and_gate,  # noqa: E402
                                    classic_config, ensemble_config, exportable, model_of, write_config)
from pipeline.stage import Ctx, run_stage  # noqa: E402

STAGE = "export_bundle"
BUNDLES_DIR = Path(__file__).resolve().parent / "bundles"


def add_args(parser) -> None:
    parser.add_argument("--method", default="", help="метод реестра, например \"stage2/IMM+GRU\" (или без префикса этапа)")
    parser.add_argument("--seeds", default="", help="участники через запятую, например 42,43; пусто - все seed")
    parser.add_argument("--title", default="", help="подпись в приложении; пусто - имя метода")
    parser.add_argument("--note", default="", help="примечание")
    parser.add_argument("--multi", action="store_true", help="добавить сеть «три варианта» этапа 6 (если есть)")
    parser.add_argument("--out", default="", help="папка пакета; пусто - bundles/<прогон>/<случай>/extra/<имя>")
    parser.add_argument("--list", action="store_true", help="только перечислить модели случая")
    parser.add_argument("--name", default="", help="имя папки пакета в extra/; пусто - по имени метода")
    parser.add_argument("--cache", default="", help="папка кэша прогона (реестр, state) вместо cache/<прогон>")
    parser.add_argument("--store", default="", help="папка хранилища моделей прогона вместо model_store/<прогон>")


def slug(label: str) -> str:
    return "".join(ch if ch.isalnum() else "_" for ch in label).strip("_")


def resolve(reg, name: str) -> str:
    """Полное имя метода реестра по имени с префиксом этапа или без него (без префикса - если однозначно)."""
    if reg.has(name):
        return name
    hits = [m for m in reg.methods() if m.split("/", 1)[-1] == name]
    return hits[0] if len(hits) == 1 else ""


def run_case(ctx: Ctx) -> bool:
    summary, reg, args = ctx.summary, ctx.registry, ctx.args
    if args.list:
        lines = [f"{'метод':60s} {'seed':>10s} {'ADE val':>8s}  пакет"]
        for m in reg.methods():
            why = exportable(reg, m)
            seeds = ",".join(str(s) for s in reg.seeds(m))
            lines.append(f"{m:60s} {seeds:>10s} {reg.metric(m, 'val')[0]:8.2f}  {'можно' if not why else 'нет: ' + why}")
        summary.section("Модели случая и возможность пакета", lines)
        return True
    method = resolve(reg, args.method)
    summary.check("Метод найден в реестре", bool(method), f"{args.method!r} -> {method or 'нет или неоднозначно'}")
    if not method:
        return False
    why = exportable(reg, method)
    summary.check("Метод можно записать пакетом", not why, why or method)
    if why:
        return False
    model = model_of(reg, method)
    label = method.split("/", 1)[1]
    root = ctx.art_dir if ctx.smoke else BUNDLES_DIR / config.RUN_NAME / ctx.case     # смоук не пишет в bundles/
    out = Path(args.out) if args.out else root / "extra" / (args.name or slug(label))
    if model == "classic":
        cfg, cd = classic_config(ctx, method, out)
        seeds = [0]
    elif model == "ensemble":
        cfg, cd = ensemble_config(ctx, method, out)
        seeds = [0]
    else:
        seeds = [int(s) for s in args.seeds.split(",") if s.strip()] or reg.seeds(method)
        missing = [s for s in seeds if s not in reg.seeds(method)]
        summary.check("Участники есть в реестре", not missing, f"запрошены {seeds}, есть {reg.seeds(method)}")
        if missing:
            return False
        cfg, cd = bundle_config(ctx, method, out, seeds)
    cfg.update(role="extra", title=args.title or cfg["title"], note=args.note)
    if args.multi and model == "hybrid":
        hyp_state = ctx.state("hyp") or {}
        multi_method = next((r["method"] for r in hyp_state.get("rows", []) if r["hyp"] == "multi"), None)
        summary.check("Сеть «три варианта» этапа 6 найдена", bool(multi_method and reg.has(multi_method)),
                      str(multi_method))
        if multi_method and reg.has(multi_method):
            add_multi(ctx, cfg, out, multi_method, seeds[0])
    write_config(out, cfg)
    got, want = check_and_gate(ctx, method, out, cfg, cd)
    summary.check("Пакет повторяет реестр на val (первый участник)", abs(got / want - 1) <= BUNDLE_ADE_TOL,
                  f"ADE val реестра {want:.3f} м, пакета {got:.3f} м (seed {seeds[0]})")
    for name in config.EVAL_SETS[1:]:          # для справки: test (holdout) пакета против реестра
        rts, ks = cd.eval(name)[1], cd.ks(name)
        got_n = ade_of(FinalPredictor(out, torch.device("cpu")), rts, ks)
        want_n = reg.report(method, name, seeds[0])["ade"]
        summary.check(f"Пакет повторяет реестр на {name} (первый участник)", abs(got_n / want_n - 1) <= BUNDLE_ADE_TOL,
                      f"ADE {name} реестра {want_n:.3f} м, пакета {got_n:.3f} м")
    summary.section("Пакет", [f"{out}", f"метод {method}, вид {model}, участники {seeds}, title {cfg['title']!r}",
                              f"строб на {cfg['gate']['horizon_s'][-1]:g} с: круг {cfg['gate']['r_one'][-1]:.1f} м"
                              + (f", три круга {cfg['gate']['r_multi'][-1]:.1f} м" if cfg["gate"]["r_multi"] else "")])
    return True


def main() -> int:
    pre = argparse.ArgumentParser(add_help=False)
    pre.add_argument("--cache", default="")
    pre.add_argument("--store", default="")
    known, _ = pre.parse_known_args()
    if known.cache:             # до создания Ctx: пути прогона берутся из config при запуске этапа
        config.CACHE_DIR = Path(known.cache)
    if known.store:
        config.STORE_DIR = Path(known.store)
    return run_stage(STAGE, "Пакет обученной модели для приложения", run_case, add_args=add_args)


if __name__ == "__main__":
    sys.exit(main())
