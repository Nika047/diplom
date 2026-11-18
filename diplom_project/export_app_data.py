"""
Данные прогона для приложения визуализации без pickle: разбиение логов и траектории генератора и расширения.

Пишет в bundles/<прогон>/ (или --out):
  splits.json              - разбиение логов этапа 0: {"<файл лога>.csv": "train" | "val" | "test" | ...};
  tracks/index.json        - справочник траекторий: id, файл, вид (synth / aug), сценарий генератора или вид
                             расширения с исходным куском лога, выборка, число точек, длительность, число маневров;
  tracks/<набор>.csv       - истина траекторий набора: id, t (с), e, n, u (м, ENU от начала траектории), phase
                             (участок разметки: straight / entry / turn / exit / slow).
Наборы (--sets): synth_val, synth_test (сгенерированные траектории val и test; только merged), synth_train,
synth_analysis (генератор, набор анализа этапа 9), aug (копии реальных полётов train: переразметка РЛС - та же истина,
другая РЛС; отражение; растяжение по скорости). По умолчанию - synth_val, synth_test и aug (в base - synth_analysis и
aug).
Источник - кэш этапа 0 этого ПК (cache/<прогон>/stage0); числа совпадают с обучением только на том же ПК, где
считались этапы (домашний): контрольные суммы кэша между компьютерами расходятся (PROJECT_STATE.md).
Проверка: число траекторий и точек в CSV равно числу в кэше, t растёт внутри каждой траектории.

  $env:DIPLOM_DATA='merged'; $env:DIPLOM_SYNTH='1'
  .venv\\Scripts\\python.exe export_app_data.py [--sets synth_val,synth_test,aug] [--out папка]
"""

import argparse
import csv
import json
import pickle
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402

import config  # noqa: E402
from common.logging_setup import setup_logging  # noqa: E402
from data import splits as splits_mod  # noqa: E402
from eval.checks import StageSummary  # noqa: E402
from pipeline.paths import RunPaths  # noqa: E402

SETS = ("synth_val", "synth_test", "synth_train", "synth_analysis", "aug")


def load(cache0: Path, name: str) -> list:
    """[(трек, выборка, вид расширения или "")] набора name из кэша этапа 0."""
    def pkl(fname):
        with open(cache0 / fname, "rb") as fh:
            return pickle.load(fh)
    if name in ("synth_val", "synth_test"):
        if config.USE_HOLDOUT:
            return []
        part = name.split("_")[1]
        return [(tr, part, "") for tr in pkl("tracks_synth_eval.pkl")[part]]
    if name == "synth_train":
        return [(tr, "train", "") for tr in pkl("tracks_synth_train.pkl")]
    if name == "synth_analysis":
        return [(tr, "analysis", "") for tr in pkl("tracks_synth_analysis.pkl")]
    return [(tr, "train", kind) for kind, copies in pkl("tracks_aug.pkl").items() for tr in copies]


def write_set(out: Path, name: str, items: list) -> tuple:
    """CSV набора и записи справочника; (записи, точек записано)."""
    rows, n_pts = [], 0
    path = out / f"{name}.csv"
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["id", "t", "e", "n", "u", "phase"])
        for tr, part, kind in items:
            t0 = float(tr.t[0])
            for i in range(len(tr.t)):
                w.writerow([tr.flight_id, f"{tr.t[i] - t0:.3f}", f"{tr.pos[i, 0]:.3f}", f"{tr.pos[i, 1]:.3f}",
                            f"{tr.pos[i, 2]:.3f}", config.PHASES[int(tr.phase[i])]])
            n_pts += len(tr.t)
            entry = {"id": tr.flight_id, "file": path.name, "kind": "aug" if kind else "synth", "set": part,
                     "points": int(len(tr.t)), "duration_s": round(float(tr.t[-1] - tr.t[0]), 1),
                     "turns": len(tr.turn_onsets)}
            if kind:
                entry.update(aug_kind=kind, source_id=tr.flight_id.split("~")[0], source_log=tr.log_file)
            else:
                entry["scenario"] = tr.scenario
            rows.append(entry)
    return rows, n_pts


def check_csv(path: Path) -> tuple:
    """(траекторий, точек, время растёт внутри каждой) по записанному CSV."""
    ids, n, monotone, last = set(), 0, True, {}
    with open(path, encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            n += 1
            ids.add(row["id"])
            t = float(row["t"])
            if row["id"] in last and t <= last[row["id"]]:
                monotone = False
            last[row["id"]] = t
    return len(ids), n, monotone


def main() -> int:
    parser = argparse.ArgumentParser(description="Данные прогона для приложения визуализации (без pickle)")
    parser.add_argument("--sets", default="", help=f"наборы через запятую: {', '.join(SETS)}")
    parser.add_argument("--out", default="", help="папка; пусто - bundles/<прогон>/")
    args = parser.parse_args()
    log = setup_logging("export_app_data")
    paths = RunPaths(False)
    cache0 = paths.stage0
    names = [s.strip() for s in args.sets.split(",") if s.strip()] or (
        ["synth_analysis", "aug"] if config.USE_HOLDOUT else ["synth_val", "synth_test", "aug"])
    unknown = [s for s in names if s not in SETS]
    if unknown:
        log.error("Неизвестные наборы %s; есть %s", unknown, SETS)
        return 2
    root = Path(args.out) if args.out else Path(__file__).resolve().parent / "bundles" / config.RUN_NAME
    out = root / "tracks"
    out.mkdir(parents=True, exist_ok=True)
    summary = StageSummary(f"Данные для приложения - прогон {config.RUN_NAME}")
    splits = splits_mod.load_splits(cache0 / "splits.json")
    (root / "splits.json").write_text(json.dumps(splits, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")
    summary.check("Разбиение логов записано", (root / "splits.json").exists(),
                  f"логов {len(splits)}: " + ", ".join(f"{p} {sum(v == p for v in splits.values())}"
                                                       for p in sorted(set(splits.values()))))
    index, lines = [], []
    for name in names:
        items = load(cache0, name)
        if not items:
            lines.append(f"{name}: нет в этом прогоне")
            continue
        rows, n_pts = write_set(out, name, items)
        index += rows
        n_tr, n_csv, monotone = check_csv(out / f"{name}.csv")
        summary.check(f"{name}: CSV повторяет кэш", n_tr == len(items) and n_csv == n_pts and monotone,
                      f"траекторий {n_tr} из {len(items)}, точек {n_csv} из {n_pts}, время растёт: {monotone}")
        size = (out / f"{name}.csv").stat().st_size / 1e6
        hours = sum(r["duration_s"] for r in rows) / 3600
        lines.append(f"{name}: траекторий {len(rows)}, {hours:.1f} ч, точек {n_pts}, {size:.1f} МБ")
    (out / "index.json").write_text(json.dumps({"run": config.RUN_NAME, "tracks": index}, ensure_ascii=False, indent=1),
                                    encoding="utf-8")
    summary.section("Наборы", lines + [f"папка: {root}"])
    summary.write(paths.results("export_app_data") / "summary.txt")
    return 0 if summary.all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
