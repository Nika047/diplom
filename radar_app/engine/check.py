"""
Проверка движка (PASS / FAIL, код выхода 1 при FAIL): engine\\.venv\\Scripts\\python.exe engine\\check.py [--http URL]

Без --http - операции движка напрямую, для каждого случая доплера, на логе полёта диплома (--log, по умолчанию
первый лог с куском не короче MIN_SCANS) при вероятности обнаружения --pd (по умолчанию 0,9 - с пропусками):
  - пересчёт ENU -> широта и долгота совпадает с координатами лога (не больше 1 м, как в predict.py);
  - прогноз по трассе из JSON тот же, что по исходной RadarTrack (перевод трассы ничего не теряет);
  - ответы переводятся в строгий JSON (без nan);
  - пошаговый прогноз сессии совпадает с прогоном трассы (допуск этапа 11 - 1e-3 м);
  - при сети «три варианта» в пакете: варианты те же, что по исходной трассе, и пошагово; вероятности в сумме 1;
    радиусы строба растут с горизонтом;
  - отметки, выгруженные в формат файла РЛС, читаются обратно, и по ним строится прогноз;
  - выборки логов - по каждому прогону (bundles/<прогон>/splits.json);
  - траектории пакетов (bundles/<прогон>/tracks): трасса с истиной без широты и долготы, повторный вызов - те же отметки;
  - выбор seed (members): гибрид другого seed отличается, IMM тот же, ансамбль из всех seed = ансамбль по умолчанию,
    пошаговый прогноз с seed совпадает с прогоном трассы;
  - виды пакетов: CV и KF без сети, сеть без IMM, жадный ансамбль - прогноз считается, IMM
    тот же, что у итоговой модели случая; у CV, KF и ансамбля seed не выбираются; пошаговый прогноз ансамбля = прогон.
С --http URL - те же основные шаги через HTTP у запущенного движка (проверка HTTP-слоя, один случай).
"""

import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402

from radar_engine import service, settings  # noqa: E402
from radar_engine.convert import from_track  # noqa: E402
from radar_engine.diplom import CASES, LOCK, bundle_dir, predict, predictor  # noqa: E402

MIN_SCANS = 120
GEO_TOL_M = 1.0
ONLINE_TOL_M = 1e-3

results = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append(ok)
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" - {detail}" if detail else ""))


def pick_log(pd: float) -> Path:
    for path in sorted((settings.DIPLOM_PROJECT / "flight_logs").glob("*.csv")):
        text = path.read_text(encoding="utf-8", errors="replace")
        try:
            tracks = service.tracks_from_log(path.name, text, "nodop", pd)["tracks"]
        except ValueError:
            continue
        if max(len(t["t"]) for t in tracks) >= MIN_SCANS:
            return path
    raise SystemExit(f"Нет лога с куском не короче {MIN_SCANS} обзоров")


def max_diff(a, b) -> float:
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    both = ~np.isnan(a) & ~np.isnan(b)
    same_nan = bool((np.isnan(a) == np.isnan(b)).all())
    return float(np.abs(a[both] - b[both]).max(initial=0.0)) if same_nan else float("inf")


def nan_rows(rows, width: int) -> np.ndarray:
    return np.array([[np.nan] * width if r is None else r for r in rows], dtype=float)


def check_case(case: str, path: Path, pd: float) -> None:
    print(f"\n== {case}")
    text = path.read_text(encoding="utf-8", errors="replace")
    tracks = service.tracks_from_log(path.name, text, case, pd)["tracks"]
    track = max(tracks, key=lambda tr: len(tr["t"]))
    geo = max(tr["geo_err_m"] for tr in tracks)
    check("Пересчёт ENU -> широта и долгота совпадает с логом", geo <= GEO_TOL_M, f"{geo:.3f} м")
    check("Доплер в трассе только у случаев с доплером", (track["vr"] is not None) == (case != "nodop"))

    # исходная RadarTrack - напрямую из predict.from_log, без перевода в JSON
    p = predictor(case, False)
    with LOCK:
        items = predict.from_log(path, pd, service.log, p.sensor_override)
        rt0 = next(rt for rt, _, _ in items if rt.flight_id == track["flight_id"])
        fc0 = p.run(rt0)
    track = json.loads(json.dumps(track, allow_nan=False))
    rt1 = from_track(track)
    out = service.run(track, case, False)
    dump = json.dumps(out, allow_nan=False)
    check("Ответ прогона - строгий JSON", True, f"{len(dump) / 1024:.0f} КБ, обзоров {len(rt1.t)}, "
          f"пропусков {1 - rt1.detected.mean():.1%}")
    d_imm = max_diff(fc0["imm"], nan_rows([x for row in out["imm"] for x in row], 3).reshape(fc0["imm"].shape))
    d_hyb = max_diff(fc0["hyb"], nan_rows([x for row in out["hyb"] for x in row], 3).reshape(fc0["hyb"].shape))
    # прогноз в ответе округлён до мм
    check("Прогноз по трассе из JSON тот же, что по исходной трассе", d_imm <= 1e-3 and d_hyb <= 1e-3,
          f"IMM {d_imm:.1e} м, гибрид {d_hyb:.1e} м")
    e = out["errors"]
    check("Ошибки посчитаны", e is not None and e["hyb"]["ade"] is not None,
          f"ADE IMM {e['imm']['ade']:.1f} м, гибрид {e['hyb']['ade']:.1f} м; {out['model']}, "
          f"{out['ms_per_scan']:.3f} мс на обзор" if e else "")
    check("Ошибки по горизонтам растут с горизонтом",
          out["ade_by_horizon"]["imm"][0] < out["ade_by_horizon"]["imm"][-1],
          f"IMM {out['ade_by_horizon']['imm']}, гибрид {out['ade_by_horizon']['hyb']}")
    if p.multi is not None:
        var = nan_rows([x for a in out["variants"] for b in a for x in b], 2).reshape(fc0["variants"].shape)
        dv = max_diff(fc0["variants"], var)
        probs = np.array([[np.nan] * 3 if r is None else [np.nan if v is None else v for v in r] for r in out["probs"]])
        ok = ~np.isnan(probs).any(axis=1)
        dp = float(np.abs(probs[ok].sum(axis=1) - 1).max(initial=0.0))
        check("Три варианта: те же, что по исходной трассе, вероятности в сумме 1, есть широта и долгота",
              dv <= 1e-3 and ok.any() and dp <= 1e-3 and out["variants_ll"] is not None,
              f"обзоров с вариантами {int(ok.sum())}, расхождение {dv:.1e} м, сумма вероятностей +-{dp:.1e}")
        g = out["gate"]
        check("Строб: радиусы растут с горизонтом, у трёх вариантов меньше одного круга",
              all(np.diff(g["r_one"]) > 0) and all(a < b for a, b in zip(g["r_multi"], g["r_one"])),
              f"покрытие {g['coverage']}, круг {np.round(g['r_one'], 1).tolist()} м, "
              f"варианты {np.round(g['r_multi'], 1).tolist()} м")
    else:
        check("Пакет без сети «три варианта» - вариантов в ответе нет", out["variants"] is None)

    sess = service.create_session(case, False, track["radar_pos"], track["origin"], track["truth"])
    s = service.session(sess["id"])
    online = np.full_like(fc0["hyb"], np.nan)
    online_var = np.full_like(fc0["variants"], np.nan) if p.multi is not None else None
    times, t_imm, t_net = [], [], []
    online_err = np.full((len(track["t"]), fc0["hyb"].shape[1]), np.nan)
    for k in range(len(track["t"])):
        polar = track["polar"][k]
        vr = track["vr"][k] if track["vr"] is not None else None
        r = s.scan(track["t"][k], track["detected"][k], polar, vr)
        times.append(r["ms"]["imm"] + r["ms"]["net"])
        t_imm.append(r["ms"]["imm"])
        t_net.append(r["ms"]["net"])
        if r["hyb"] is not None:
            online[k] = nan_rows(r["hyb"], 3)
            online_err[k] = [np.nan if v is None else v for v in r["err"]["hyb"]]
        if r["variants"] is not None:
            online_var[k] = nan_rows([x for row in r["variants"] for x in row], 2).reshape(online_var.shape[1:])
        json.dumps(r, allow_nan=False)
    service.delete_session(sess["id"])
    ks = fc0["ks"]
    d = float(np.nanmax(np.abs(online[ks] - fc0["hyb"][ks]), initial=0.0)) if len(ks) else float("inf")
    check("Пошаговый прогноз сессии совпадает с прогоном трассы", d <= ONLINE_TOL_M,
          f"обзоров с прогнозом {len(ks)}, расхождение {d:.1e} м; на обзор {np.mean(times):.3f} мс в среднем "
          f"(IMM {np.mean(t_imm):.3f}, сеть {np.mean(t_net):.3f}), {np.percentile(times, 99):.3f} мс 99-й "
          f"перцентиль; первые 100 обзоров {np.mean(times[:100]):.3f} мс, последние 100 - {np.mean(times[-100:]):.3f} мс")

    run_err = np.array([[np.nan if v is None else v for v in row] for row in out["err"]["hyb"]])
    de = max_diff(run_err[ks], online_err[ks])
    check("Ошибка прогноза в сессии та же, что у прогона трассы", de <= 0.02, f"расхождение {de:.1e} м (округление до 1 см)")
    if online_var is not None:
        both = np.isfinite(online_var).all(axis=(1, 2, 3)) & np.isfinite(fc0["variants"]).all(axis=(1, 2, 3))
        dv = float(np.abs(online_var[both] - fc0["variants"][both]).max(initial=np.inf if not both.any() else 0.0))
        check("Пошаговые три варианта совпадают с прогоном трассы", dv <= ONLINE_TOL_M,
              f"обзоров {int(both.sum())}, расхождение {dv:.1e} м")

    csv = service.radar_csv(track)
    radar = csv["radar"]
    back = service.tracks_from_radar("radar.csv", csv["text"], case, radar["lat"], radar["lon"], radar["alt"])
    tr = back["tracks"][0]
    out_r = service.run(tr, case, False)
    check("Отметки в формате файла РЛС читаются обратно, прогноз строится",
          len(tr["t"]) == len(track["t"]) and len(out_r["ks"]) > 0 and out_r["errors"] is None,
          f"обзоров {len(tr['t'])}, с прогнозом {len(out_r['ks'])}")


def http(url: str, method: str = "GET", body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def check_http(base: str, path: Path, pd: float) -> None:
    base = base.rstrip("/")
    print(f"\n== HTTP {base}")
    check("/health", http(base + "/health")["status"] == "ok")
    info = http(base + "/info")
    check("/info: пакеты всех случаев", all("error" not in c for c in info["cases"]),
          ", ".join(f"{c['case']}: {c.get('model', c.get('error'))}" for c in info["cases"]))
    logs = http(base + "/logs")["logs"]
    check("/logs: сводка логов диплома", any(r["name"] == path.name and r["pieces"] > 0 for r in logs), f"логов {len(logs)}")
    case = "dop_traj"
    text = path.read_text(encoding="utf-8", errors="replace")
    tracks = http(base + "/tracks/log", "POST", {"name": path.name, "text": text, "case": case, "pd": pd})["tracks"]
    track = max(tracks, key=lambda tr: len(tr["t"]))
    t0 = time.perf_counter()
    out = http(base + "/run", "POST", {"track": track, "case": case, "ensemble": True})
    check("/run (ансамбль)", out["errors"] is not None, f"{out['model']}, ADE гибрид {out['errors']['hyb']['ade']} м, "
          f"запрос {(time.perf_counter() - t0) * 1e3:.0f} мс")
    seed = http(base + "/run", "POST", {"track": track, "case": case, "members": [43]})
    check("/run (seed 43)", seed["members"] == [43] and seed["hyb"] != out["hyb"], f"ADE гибрид {seed['errors']['hyb']['ade']} м")
    items = http(base + "/tracks")["tracks"]
    first = items[0]
    tr = http(base + "/tracks/bundle", "POST", {"run": first["run"], "id": first["id"], "case": case, "pd": pd})["tracks"][0]
    check("/tracks и /tracks/bundle", tr["origin"] is None and len(tr["t"]) > 1,
          f"траекторий {len(items)}, {first['run']}/{first['id']}: обзоров {len(tr['t'])}")
    sess = http(base + "/sessions", "POST", {"case": case, "radar_pos": track["radar_pos"], "origin": track["origin"]})
    lat = []
    for k in range(40):
        t0 = time.perf_counter()
        r = http(f"{base}/sessions/{sess['id']}/scan", "POST", {"t": track["t"][k], "detected": track["detected"][k],
                                                                 "polar": track["polar"][k], "vr": track["vr"][k]})
        lat.append((time.perf_counter() - t0) * 1e3)
    check("/sessions/{id}/scan", r["hyb"] is not None and r["hyb_ll"] is not None
          and (r["variants_ll"] is not None) == bool(sess["has_variants"]),
          f"40 обзоров, запрос в среднем {np.mean(lat):.2f} мс, наибольший {np.max(lat):.2f} мс")
    batch = [{"t": track["t"][k], "detected": track["detected"][k], "polar": track["polar"][k], "vr": track["vr"][k]}
             for k in range(40, 60)]
    res = http(f"{base}/sessions/{sess['id']}/scans", "POST", {"scans": batch})["results"]
    check("/sessions/{id}/scans (догон пакетом)", [r["k"] for r in res] == list(range(40, 60)))
    http(f"{base}/sessions/{sess['id']}", "DELETE")
    try:
        http(f"{base}/sessions/{sess['id']}/scan", "POST", {"t": 0, "detected": False})
        check("Удалённая сессия - 404", False)
    except urllib.error.HTTPError as e:
        check("Удалённая сессия - 404", e.code == 404)


def check_same_plots(path: Path, pd: float) -> None:
    """Сравнение моделей рисует все случаи на одной трассе: отметки и истина у случаев доплера должны совпадать."""
    print("\n== отметки разных случаев доплера")
    text = path.read_text(encoding="utf-8", errors="replace")
    tracks = {case: service.tracks_from_log(path.name, text, case, pd)["tracks"] for case in CASES}
    base = tracks[CASES[0]]
    same = all(
        len(tracks[c]) == len(base) and all(
            a["detected"] == b["detected"] and a["polar"] == b["polar"] and a["truth"] == b["truth"]
            for a, b in zip(tracks[c], base))
        for c in CASES[1:])
    vr_differ = tracks["dop_traj"][0]["vr"] != tracks["dop_tele"][0]["vr"]
    check("Отметки и истина одинаковы у всех случаев доплера, различается только радиальная скорость",
          same and vr_differ, f"кусков {len(base)}, случаи: {', '.join(CASES)}")


def check_bundle_path(path: Path, pd: float) -> None:
    """Модель из справочника приложения задаётся путём к пакету: прогноз тот же, что по случаю."""
    print("\n== модель по пути к пакету")
    case = "dop_traj"
    bundle = str(bundle_dir(case))
    text = path.read_text(encoding="utf-8", errors="replace")
    track = max(service.tracks_from_log(path.name, text, None, pd, bundle)["tracks"], key=lambda tr: len(tr["t"]))
    by_case = service.run(track, case, False)
    by_path = service.run(track, None, False, bundle)
    same = by_case["hyb"] == by_path["hyb"] and by_case["imm"] == by_path["imm"] and by_case["errors"] == by_path["errors"]
    summary = service.describe_bundle(bundle)
    check("Прогноз по пути к пакету тот же, что по случаю", same and by_path["case"] == case,
          f"ADE гибрида {by_path['errors']['hyb']['ade']} м")
    check("Сводка пакета по пути", summary["case"] == case and summary["members"] == len(summary["seeds"]) > 0,
          f"{summary['model']}, seed {summary['seeds']}")
    try:
        service.describe_bundle(str(path.parent))
        check("Папка без config.json - ошибка входных данных", False)
    except ValueError as e:
        check("Папка без config.json - ошибка входных данных", "config.json" in str(e))


def check_catalog(path: Path) -> None:
    """Справочник полётов: сводка логов диплома и загруженного файла - очисткой диплома; выборки - по прогонам."""
    print("\n== сводка логов")
    catalog = service.logs_catalog()
    logs = catalog["logs"]
    row = next((r for r in logs if r["name"] == path.name), None)
    summary = service.describe_file(path.name, path.read_text(encoding="utf-8", errors="replace"), "log")
    check("Сводка логов диплома: все логи, у выбранного есть куски", row is not None and row["pieces"] > 0
          and len(logs) == len(list(path.parent.glob("*.csv"))),
          f"логов {len(logs)}, без кусков {sum(r['pieces'] == 0 for r in logs)}; {path.name}: кусков {row and row['pieces']}, "
          f"{row and row['duration_s']:.0f} с, выборки {row and row['splits']}")
    check("Выборки логов по каждому прогону с данными для приложения", len(catalog["runs"]) > 0 and row is not None
          and set(row["splits"]) == set(catalog["runs"]) and all(v is not None for v in row["splits"].values()),
          f"прогоны {', '.join(catalog['runs'])}")
    check("Сводка загруженного лога та же, что у лога диплома",
          row is not None and all(summary[k] == row[k] for k in ("rows", "pieces", "duration_s", "aircraft", "source")))


def check_tracks(pd: float) -> None:
    """Траектории генератора и расширения из пакетов прогонов: трасса с истиной на плоскости, отметки воспроизводятся."""
    print("\n== траектории пакетов")
    items = service.tracks_catalog()["tracks"]
    by_run = {r: sum(t["run"] == r for t in items) for r in service.runs()}
    check("Траектории пакетов всех прогонов", all(n > 0 for n in by_run.values()) and len(by_run) > 0,
          ", ".join(f"{r}: {n}" for r, n in by_run.items()))
    bundle = str(bundle_dir("dop_traj"))
    for kind in ("synth", "aug"):
        entry = next(t for t in items if t["kind"] == kind)
        a = service.tracks_from_bundle(entry["run"], entry["id"], None, pd, bundle)["tracks"][0]
        b = service.tracks_from_bundle(entry["run"], entry["id"], None, pd, bundle)["tracks"][0]
        truth = nan_rows(a["truth"], 3)
        expected = int(entry["duration_s"] // 2.0) + 1
        out = service.run(a, None, False, bundle)
        check(f"Траектория {kind} -> трасса", a["origin"] is None and a["truth_ll"] is None and not np.isnan(truth).any()
              and len(a["t"]) == expected and a["polar"] == b["polar"] and out["errors"] is not None,
              f"{entry['run']}/{entry['id']}: обзоров {len(a['t'])}, участки {sorted(set(a['phase']))}, "
              f"ADE гибрида {out['errors']['hyb']['ade']} м")
    try:
        service.tracks_from_bundle("../x", "a", None, pd, bundle)
        check("Чужой прогон - ошибка входных данных", False)
    except ValueError:
        check("Чужой прогон - ошибка входных данных", True)


def check_members(path: Path, pd: float) -> None:
    """Выбор участников пакета: seed - отдельная модель."""
    print("\n== выбор seed")
    bundle = str(bundle_dir("dop_traj"))
    seeds = service.describe_bundle(bundle)["seeds"]
    text = path.read_text(encoding="utf-8", errors="replace")
    track = max(service.tracks_from_log(path.name, text, None, pd, bundle)["tracks"], key=lambda tr: len(tr["t"]))
    default = service.run(track, None, False, bundle)
    first = service.run(track, None, False, bundle, [seeds[0]])
    other = service.run(track, None, False, bundle, [seeds[1]])
    ens = service.run(track, None, True, bundle)
    ens_all = service.run(track, None, True, bundle, seeds)
    check("Seed по умолчанию - первый участник; другой seed - другой гибрид, тот же IMM",
          default["hyb"] == first["hyb"] and other["hyb"] != first["hyb"] and other["imm"] == first["imm"],
          f"ADE гибрида: seed {seeds[0]} {first['errors']['hyb']['ade']} м, seed {seeds[1]} {other['errors']['hyb']['ade']} м")
    check("Ансамбль из всех seed = ансамбль по умолчанию", ens["hyb"] == ens_all["hyb"], f"ADE {ens['errors']['hyb']['ade']} м")
    sess = service.create_session(None, False, track["radar_pos"], track["origin"], None, bundle, [seeds[1]])
    s = service.session(sess["id"])
    diff = 0.0
    for k in range(len(track["t"])):
        r = s.scan(track["t"][k], track["detected"][k], track["polar"][k], track["vr"][k])
        if r["hyb"] is not None:
            diff = max(diff, max_diff(nan_rows(r["hyb"], 3), nan_rows(other["hyb"][k], 3)))
    service.delete_session(sess["id"])
    # оба прогноза - из JSON, округлены до 1 мм: к допуску этапа 11 добавляется округление
    check("Пошаговый прогноз с seed = прогон трассы с тем же seed",
          sess["members"] == [seeds[1]] and diff <= ONLINE_TOL_M + 1e-3 + 1e-9,
          f"наибольшее расхождение {diff:.2e} м (округление ответа до 1 мм)")
    try:
        service.run(track, None, False, bundle, [999])
        check("Нет такого seed - ошибка входных данных", False)
    except ValueError:
        check("Нет такого seed - ошибка входных данных", True)


def check_model_types(path: Path, pd: float) -> None:
    """Пакеты не-гибридов (bundles/<прогон>/<случай>/extra): прогноз модели пакета - в hyb, IMM - случая."""
    print("\n== виды пакетов")
    extra = settings.BUNDLES_DIR / "nodop" / "extra"
    text = path.read_text(encoding="utf-8", errors="replace")
    base = str(bundle_dir("nodop"))
    track = max(service.tracks_from_log(path.name, text, None, pd, base)["tracks"], key=lambda tr: len(tr["t"]))
    final = service.run(track, None, False, base)
    for name, expected in (("CV", "classic"), ("KF", "classic"), ("GRU_bez_IMM", "e2e")):
        bundle = extra / name
        if not (bundle / "config.json").exists():
            check(f"Пакет {name}", False, f"нет {bundle}")
            continue
        summary = service.describe_bundle(str(bundle))
        out = service.run(track, None, False, str(bundle))
        check(f"Пакет {name}: вид {expected}, прогноз считается, IMM - случая", summary["model_type"] == expected
              and out["errors"] is not None and out["imm"] == final["imm"] and out["hyb"] != out["imm"],
              f"{summary['model']}, seed {summary['seeds']}; ADE {out['errors']['hyb']['ade']} м, IMM {out['errors']['imm']['ade']} м")
    try:
        service.run(track, None, False, str(extra / "CV"), [42])
        check("У CV seed не выбирается - ошибка входных данных", False)
    except ValueError:
        check("У CV seed не выбирается - ошибка входных данных", True)

    ens = settings.BUNDLES_DIR / "dop_tele" / "extra" / "ensemble_MSE"
    if not (ens / "config.json").exists():
        check("Жадный ансамбль", False, f"нет {ens}")
        return
    summary = service.describe_bundle(str(ens))
    tele = max(service.tracks_from_log(path.name, text, None, pd, str(ens))["tracks"], key=lambda tr: len(tr["t"]))
    out = service.run(tele, None, False, str(ens))
    sess = service.create_session(None, False, tele["radar_pos"], tele["origin"], None, str(ens))
    s = service.session(sess["id"])
    diff = 0.0
    for k in range(len(tele["t"])):
        r = s.scan(tele["t"][k], tele["detected"][k], tele["polar"][k], tele["vr"][k])
        if r["hyb"] is not None:
            diff = max(diff, max_diff(nan_rows(r["hyb"], 3), nan_rows(out["hyb"][k], 3)))
    service.delete_session(sess["id"])
    check("Жадный ансамбль: частей больше одной, пошаговый прогноз = прогон трассы",
          summary["model_type"] == "ensemble" and summary["parts"] > 1 and out["errors"] is not None
          and diff <= ONLINE_TOL_M + 1e-3 + 1e-9,
          f"{summary['model']}, частей {summary['parts']}; ADE {out['errors']['hyb']['ade']} м; расхождение {diff:.2e} м")


def main() -> int:
    parser = argparse.ArgumentParser(description="Проверка движка прогноза")
    parser.add_argument("--log", type=Path, help="лог полёта CSV (по умолчанию - из flight_logs диплома)")
    parser.add_argument("--pd", type=float, default=0.9, help="вероятность обнаружения")
    parser.add_argument("--http", help="адрес запущенного движка, например http://127.0.0.1:8765")
    args = parser.parse_args()
    path = args.log or pick_log(args.pd)
    print(f"Лог: {path.name}, Pd = {args.pd}, пакеты: {settings.BUNDLES_DIR}")
    if args.http:
        check_http(args.http, path, args.pd)
    else:
        for case in CASES:
            check_case(case, path, args.pd)
        check_same_plots(path, args.pd)
        check_catalog(path)
        check_bundle_path(path, args.pd)
        check_tracks(args.pd)
        check_members(path, args.pd)
        check_model_types(path, args.pd)
    print(f"\nИтог: {'PASS' if all(results) else 'FAIL'} ({sum(results)} из {len(results)})")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
