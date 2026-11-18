"""
Проверка файлов сценариев запуска (PASS / FAIL, код выхода 1 при FAIL):

  engine\\.venv\\Scripts\\python.exe engine\\check_scenario.py scenarios\\glava4.json [...] [--run] [--resolved DIR]

Правила - таблица «Поля и проверка при загрузке» из ..\\diplom_project\\.agent_docs\\APP_SCENARIO.md с правками
(scenarios\\README.md, «Формат»): слои карты - имена приложения, view.focus и
view.follow вместо follow_forecast, в реальном времени один кусок (по умолчанию самый длинный), при 5 моделях и больше
ускорение не выше x10, у hyb ровно один seed, у ens все seed пакета, повтор имени загруженного файла - ошибка;
у загруженного файла отметок координаты РЛС необязательны (lat и lon вместе, alt - только с ними), без них
osm и yandex - ошибка; загруженный лог полёта - по правилам log (radar.pd, без координат).

Проверяется без движка: структура файла, неизвестные поля, типы и диапазоны; лог есть в flight_logs диплома и кусок
существует; траектория есть в bundles/<прогон>/tracks/index.json; пакет - папка с config.json и весами, seed есть в
пакете; IMM - только у пакета случая (так заводит справочник приложения); start_scan меньше числа обзоров;
предупреждение, если полёт из train прогона модели. Загруженные файлы (flight.source = upload) лежат только у сервера:
их наличие, вид (файл отметок или лог полёта - по столбцам) и столбец vr_mps для моделей с доплером скрипт не
проверяет и пишет об этом предупреждение; вид файла скрипт выводит из radar: pd - лог, lat / lon / alt - файл отметок.

--run - ещё прогон каждого сценария кодом диплома через операции движка (service): трассы под каждый пакет, прогноз
каждой модели, ADE по выбранным кускам; в реальном времени - ещё сессия OnlinePredictor на первых обзорах. Так
проверяется, что пакеты, seed и полёт загружаются и прогноз считается, но не интерфейс приложения.
--resolved DIR - записать разрешённую копию каждого файла (значения по умолчанию подставлены, модели - объектами).
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from radar_engine import service, settings  # noqa: E402
from radar_engine.diplom import config  # noqa: E402

FORMAT = "radar_app/scenario"
VERSIONS = (1,)
MAX_BYTES = 1024 * 1024
MAX_SCENARIOS = 100
NAME_MAX = 200
SOURCES = ("log", "upload", "track")
KINDS = ("imm", "hyb", "ens")
MODES = ("full", "realtime")
SPEED_MIN, SPEED_MAX = 1, 50
# как RealtimeService.ManyModels и LimitedSpeed сервера
MANY_MODELS, LIMITED_SPEED = 5, 10
BASEMAPS = ("osm", "yandex", "plane")
# как SceneLayers клиента (client/src/components/map/trackScene.ts)
LAYERS = ("plots", "truth", "phases", "variants", "gate")
HORIZONS_S = tuple(int((h + 1) * config.SCAN_PERIOD) for h in range(config.HORIZON_SCANS))
DOPPLER_CASES = ("dop_traj", "dop_tele")
RUN_SCANS = 40  # сколько обзоров подать в сессию реального времени при --run

SCENARIO_KEYS = {"name", "note", "flight", "models", "mode", "radar", "view"}
FLIGHT_KEYS = {"log": {"source", "file", "piece"}, "upload": {"source", "file", "piece"},
               "track": {"source", "run", "id"}}
MODE_KEYS = {"full": {"type"}, "realtime": {"type", "speed", "start_scan", "autoplay"}}
# у upload - pd (загруженный лог полёта) или lat / lon / alt (файл отметок), вид файла знает только сервер
RADAR_KEYS = {"log": {"pd"}, "track": {"pd"}, "upload": {"pd", "lat", "lon", "alt"}}
GEO_BASEMAPS = ("osm", "yandex")
VIEW_KEYS = {"basemap", "horizons_s", "layers", "focus", "follow"}
MODEL_KEYS = {"bundle", "kind", "members"}

results = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append(ok)
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" - {detail}" if detail else ""))


class Report:
    def __init__(self) -> None:
        self.errors: list = []
        self.warnings: list = []
        self.notes: list = []

    def err(self, path: str, text: str) -> None:
        self.errors.append(f"{path}: {text}")

    def warn(self, path: str, text: str) -> None:
        self.warnings.append(f"{path}: {text}")


def is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def unknown(rep: Report, path: str, obj: dict, allowed: set) -> None:
    for key in sorted(set(obj) - allowed):
        rep.err(f"{path}.{key}", f"неизвестное поле (допустимы: {', '.join(sorted(allowed))})")


# ============================================================================
# Данные диплома: логи, траектории, пакеты (читаются один раз)
# ============================================================================

_pieces: dict = {}
_tracks: dict = {}
_bundles: dict = {}
_splits: dict = {}


def log_pieces(name: str) -> list | None:
    """Число обзоров каждого куска лога после очистки (очистка и модель РЛС диплома); нет лога - None."""
    if name not in _pieces:
        path = settings.DIPLOM_PROJECT / "flight_logs" / name
        if not path.is_file():
            _pieces[name] = None
        else:
            try:
                tracks = service.tracks_from_log(name, path.read_text(encoding="utf-8", errors="replace"), "nodop",
                                                 1.0)["tracks"]
                _pieces[name] = [len(t["t"]) for t in tracks]
            except ValueError:
                _pieces[name] = []
    return _pieces[name]


def track_entry(run: str, track_id: str) -> dict | None:
    if run not in _tracks:
        path = settings.BUNDLES_ROOT / run / "tracks" / "index.json"
        _tracks[run] = ({t["id"]: t for t in json.loads(path.read_text(encoding="utf-8"))["tracks"]}
                        if path.is_file() else None)
    index = _tracks[run]
    return None if index is None else index.get(track_id)


def bundle_config(bundle: str) -> dict | None:
    if bundle not in _bundles:
        path = settings.BUNDLES_ROOT / bundle / "config.json"
        _bundles[bundle] = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None
    return _bundles[bundle]


def run_splits(run: str) -> dict:
    if run not in _splits:
        path = settings.BUNDLES_ROOT / run / "splits.json"
        _splits[run] = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    return _splits[run]


# ============================================================================
# Проверка сценария
# ============================================================================

def check_flight(rep: Report, path: str, flight, mode_type: str | None) -> tuple:
    """Полёт сценария -> (разрешённый flight, обзоров в выбранном куске или None)."""
    if not isinstance(flight, dict):
        rep.err(path, "ожидается объект")
        return None, None
    source = flight.get("source")
    if source not in SOURCES:
        rep.err(f"{path}.source", f"ожидается одно из {', '.join(SOURCES)}, получено {source!r}")
        return None, None
    unknown(rep, path, flight, FLIGHT_KEYS[source])
    out = {"source": source}
    if source == "track":
        run, track_id = flight.get("run"), flight.get("id")
        if not isinstance(run, str) or not run:
            rep.err(f"{path}.run", "нужна строка - прогон диплома (папка bundles/<прогон>)")
            return None, None
        if not isinstance(track_id, str) or not track_id:
            rep.err(f"{path}.id", "нужна строка - id из bundles/<прогон>/tracks/index.json")
            return None, None
        if not (settings.BUNDLES_ROOT / run / "tracks" / "index.json").is_file():
            rep.err(f"{path}.run", f"нет bundles/{run}/tracks/index.json")
            return None, None
        entry = track_entry(run, track_id)
        if entry is None:
            rep.err(f"{path}.id", f"нет траектории {track_id!r} в bundles/{run}/tracks/index.json")
            return None, None
        out.update(run=run, id=track_id)
        return out, int(entry["points"])

    file = flight.get("file")
    if not isinstance(file, str) or not file:
        rep.err(f"{path}.file", "нужна строка - имя файла")
        return None, None
    out["file"] = file
    piece = flight.get("piece", "all" if mode_type != "realtime" else None)
    if source == "upload":
        rep.warn(f"{path}.file", "загруженные файлы есть только у сервера: наличие файла, его вид, кусок и столбец vr_mps "
                                 "скрипт не проверяет")
        out["piece"] = piece
        return out, None

    pieces = log_pieces(file)
    if pieces is None:
        rep.err(f"{path}.file", f"нет лога {file!r} в diplom_project/flight_logs")
        return None, None
    if not pieces:
        rep.err(f"{path}.file", "в логе не осталось кусков после очистки")
        return None, None
    if piece is None:
        piece = max(range(len(pieces)), key=lambda i: pieces[i])
    if piece == "all":
        if mode_type == "realtime":
            rep.err(f"{path}.piece", "реальное время идёт по одному куску: нужен номер куска (без поля - самый длинный)")
            return None, None
        out["piece"] = "all"
        return out, None
    if not is_int(piece) or not 0 <= piece < len(pieces):
        rep.err(f"{path}.piece", f"ожидается \"all\" или целое 0..{len(pieces) - 1} (кусков {len(pieces)}), "
                                 f"получено {piece!r}")
        return None, None
    out["piece"] = piece
    return out, pieces[piece]


def parse_model(rep: Report, path: str, item) -> dict | None:
    """Модель сценария -> {bundle, kind, members} с seed по умолчанию."""
    if isinstance(item, str):
        if ":" not in item:
            rep.err(path, f"строка модели - \"<пакет>:<вид>\", получено {item!r}")
            return None
        bundle, kind = item.rsplit(":", 1)
        members = None
    elif isinstance(item, dict):
        unknown(rep, path, item, MODEL_KEYS)
        bundle, kind, members = item.get("bundle"), item.get("kind"), item.get("members")
    else:
        rep.err(path, "ожидается строка \"<пакет>:<вид>\" или объект {bundle, kind, members?}")
        return None
    if not isinstance(bundle, str) or not bundle or bundle.startswith(("/", "\\")) or ".." in bundle.split("/"):
        rep.err(f"{path}.bundle", f"путь пакета от bundles/ через «/», получено {bundle!r}")
        return None
    bundle = bundle.strip("/")
    if kind not in KINDS:
        rep.err(f"{path}.kind", f"ожидается одно из {', '.join(KINDS)}, получено {kind!r}")
        return None
    cfg = bundle_config(bundle)
    if cfg is None:
        rep.err(f"{path}.bundle", f"нет пакета bundles/{bundle} (нужен config.json)")
        return None
    seeds = [int(m["seed"]) for m in cfg.get("members", [])]
    missing = [m["file"] for m in cfg.get("members", []) if not (settings.BUNDLES_ROOT / bundle / m["file"]).is_file()]
    if missing:
        rep.err(f"{path}.bundle", f"в пакете нет весов {', '.join(missing)}")
        return None
    if kind == "imm":
        if members is not None:
            rep.err(f"{path}.members", "у IMM нет участников-сетей")
            return None
        if len(bundle.split("/")) != 2:
            rep.err(f"{path}.kind", "IMM в справочнике приложения есть только у пакета случая (<прогон>/<случай>); "
                                    f"возьмите \"{'/'.join(bundle.split('/')[:2])}:imm\"")
            return None
        return {"bundle": bundle, "kind": kind}
    if members is not None:
        if not isinstance(members, list) or not members or not all(is_int(s) for s in members) \
                or len(set(members)) != len(members):
            rep.err(f"{path}.members", "ожидается непустой список разных целых seed")
            return None
        absent = [s for s in members if s not in seeds]
        if absent:
            rep.err(f"{path}.members", f"нет seed {', '.join(map(str, absent))} в пакете, есть {seeds}")
            return None
    if kind == "hyb":
        if members is not None and len(members) != 1:
            rep.err(f"{path}.members", f"у hyb ровно один seed (для среднего нескольких - kind ens), получено {members}")
            return None
        return {"bundle": bundle, "kind": kind, "members": members or seeds[:1]}
    if len(seeds) < 2:
        rep.err(f"{path}.kind", f"ансамбль нужен из двух сетей и больше, в пакете seed {seeds}")
        return None
    if members is not None and sorted(members) != sorted(seeds):
        rep.err(f"{path}.members", f"у ens только все seed пакета {seeds} (справочник заводит ансамбль из всех), "
                                   f"получено {members}")
        return None
    return {"bundle": bundle, "kind": kind, "members": seeds}


def check_scenario(rep: Report, path: str, sc) -> dict | None:
    if not isinstance(sc, dict):
        rep.err(path, "ожидается объект")
        return None
    unknown(rep, path, sc, SCENARIO_KEYS)
    for key in ("name", "flight", "models", "mode"):
        if key not in sc:
            rep.err(f"{path}.{key}", "обязательное поле")
    if any(key not in sc for key in ("name", "flight", "models", "mode")):
        return None
    out = {}
    name = sc["name"]
    if not isinstance(name, str) or not name.strip() or len(name) > NAME_MAX:
        rep.err(f"{path}.name", f"непустая строка до {NAME_MAX} символов")
    out["name"] = name
    if "note" in sc:
        if not isinstance(sc["note"], str):
            rep.err(f"{path}.note", "ожидается строка")
        out["note"] = sc["note"]

    mode = sc["mode"]
    mode_type = mode.get("type") if isinstance(mode, dict) else None
    if mode_type not in MODES:
        rep.err(f"{path}.mode.type", f"ожидается одно из {', '.join(MODES)}, получено {mode_type!r}")
        mode_type = None

    flight, scans = check_flight(rep, f"{path}.flight", sc["flight"], mode_type)
    out["flight"] = flight

    models_raw = sc["models"]
    models = []
    if not isinstance(models_raw, list) or not models_raw:
        rep.err(f"{path}.models", "нужен непустой список моделей")
    else:
        seen = {}
        for i, item in enumerate(models_raw):
            m = parse_model(rep, f"{path}.models[{i}]", item)
            if m is None:
                continue
            key = (m["bundle"], m["kind"], tuple(m.get("members") or ()))
            if key in seen:
                rep.err(f"{path}.models[{i}]", f"повтор модели models[{seen[key]}]")
                continue
            seen[key] = i
            models.append(m)
    out["models"] = models

    if mode_type is not None:
        unknown(rep, f"{path}.mode", mode, MODE_KEYS[mode_type])
        res_mode = {"type": mode_type}
        if mode_type == "realtime":
            speed = mode.get("speed", SPEED_MIN)
            if not is_num(speed) or not SPEED_MIN <= speed <= SPEED_MAX:
                rep.err(f"{path}.mode.speed", f"число {SPEED_MIN}..{SPEED_MAX}, получено {speed!r}")
            elif len(models_raw if isinstance(models_raw, list) else []) >= MANY_MODELS and speed > LIMITED_SPEED:
                rep.err(f"{path}.mode.speed", f"при {MANY_MODELS} моделях и больше ускорение не выше x{LIMITED_SPEED} "
                                              "(сервер считает сессии движка по очереди)")
            start = mode.get("start_scan", 0)
            if not is_int(start) or start < 0:
                rep.err(f"{path}.mode.start_scan", f"целое от 0, получено {start!r}")
            elif scans is not None and start >= scans:
                rep.err(f"{path}.mode.start_scan", f"обзоров в куске {scans}, нужен номер меньше")
            autoplay = mode.get("autoplay", True)
            if not isinstance(autoplay, bool):
                rep.err(f"{path}.mode.autoplay", "ожидается true или false")
            res_mode.update(speed=speed, start_scan=start, autoplay=autoplay)
        out["mode"] = res_mode

    # источник берётся и у полёта с ошибкой: остальные поля всё равно проверяются
    source = sc["flight"].get("source") if isinstance(sc["flight"], dict) else None
    source = source if source in SOURCES else None
    radar = sc.get("radar", {})
    if not isinstance(radar, dict):
        rep.err(f"{path}.radar", "ожидается объект")
    elif source is not None:
        unknown(rep, f"{path}.radar", radar, RADAR_KEYS[source])
        geo = [k for k in ("lat", "lon", "alt") if k in radar]
        if source == "upload" and geo and "pd" in radar:
            rep.err(f"{path}.radar", "pd - у загруженного лога полёта, lat / lon / alt - у файла отметок; вместе нельзя")
        elif source == "upload" and geo:
            ok = True
            for key, lo, hi in (("lat", -90, 90), ("lon", -180, 180), ("alt", None, None)):
                v = radar.get(key)
                if key in radar and (not is_num(v) or (lo is not None and not lo <= v <= hi)):
                    rep.err(f"{path}.radar.{key}", "число" + (f" {lo}..{hi}" if lo is not None else ", м"))
                    ok = False
            if ("lat" in radar) != ("lon" in radar):
                rep.err(f"{path}.radar", "нужны и lat, и lon или ни то, ни другое")
                ok = False
            elif "alt" in radar and "lat" not in radar:
                rep.err(f"{path}.radar.alt", "высота РЛС - только вместе с lat и lon")
                ok = False
            if ok:
                out["radar"] = {k: radar[k] for k in geo}
            if any(bundle_config(m["bundle"]).get("case") in DOPPLER_CASES for m in models):
                rep.warn(f"{path}.models", "модель с доплером: у загруженного файла отметок нужен столбец vr_mps - не проверено")
        elif source == "upload" and "pd" not in radar:
            # вид загруженного файла неизвестен: pd по умолчанию не подставляется, у файла отметок его нет
            out["radar"] = {}
        else:
            pd = radar.get("pd", 1.0)
            if not is_num(pd) or not 0 < pd <= 1:
                rep.err(f"{path}.radar.pd", f"число в (0; 1], получено {pd!r}")
            out["radar"] = {"pd": pd}

    if "view" in sc:
        view = sc["view"]
        if not isinstance(view, dict):
            rep.err(f"{path}.view", "ожидается объект")
        else:
            unknown(rep, f"{path}.view", view, VIEW_KEYS)
            if "basemap" in view:
                if view["basemap"] not in BASEMAPS:
                    rep.err(f"{path}.view.basemap", f"ожидается одно из {', '.join(BASEMAPS)}")
                elif source == "track" and view["basemap"] != "plane":
                    rep.err(f"{path}.view.basemap", "у траектории нет широты и долготы: только plane")
                elif (source == "upload" and view["basemap"] in GEO_BASEMAPS and isinstance(radar, dict)
                      and "pd" not in radar and not ("lat" in radar and "lon" in radar)):
                    if any(k in radar for k in ("lat", "lon", "alt")):
                        rep.err(f"{path}.view.basemap", "у файла отметок без radar.lat / lon подложки нет, укажите "
                                                        "координаты или plane")
                    else:
                        rep.warn(f"{path}.view.basemap", "если загруженный файл - отметки без координат РЛС, сервер "
                                                         "отклонит подложку: нужны radar.lat / lon или plane")
            if "horizons_s" in view:
                h = view["horizons_s"]
                if not isinstance(h, list) or not h or not all(x in HORIZONS_S for x in h) or len(set(h)) != len(h):
                    rep.err(f"{path}.view.horizons_s", f"непустой список разных значений из {list(HORIZONS_S)}")
            if "layers" in view:
                ls = view["layers"]
                if not isinstance(ls, list) or not all(x in LAYERS for x in ls) or len(set(ls)) != len(ls):
                    rep.err(f"{path}.view.layers", f"список разных слоёв из {', '.join(LAYERS)}")
            for key in ("focus", "follow"):
                if key in view and not isinstance(view[key], bool):
                    rep.err(f"{path}.view.{key}", "ожидается true или false")
            if view.get("focus") is True and view.get("follow") is True:
                rep.err(f"{path}.view", "focus и follow вместе нельзя: при фокусе на прогнозе слежение выключено")
            out["view"] = view

    # проверки с данными
    if flight and models:
        runs = {m["bundle"].split("/")[0] for m in models}
        cases = {"/".join(m["bundle"].split("/")[:2]) for m in models}
        if len(cases) > 1:
            rep.notes.append(f"{path}: модели разных {'прогонов' if len(runs) > 1 else 'случаев'} - "
                             f"{', '.join(sorted(cases))}")
        for run in sorted(runs):
            if source == "log":
                split = run_splits(run).get(flight["file"])
                if split == "train":
                    rep.warn(f"{path}.flight", f"полёт из train прогона {run}: оценка на обучающих данных")
                elif split != "test":
                    rep.notes.append(f"{path}: полёт в прогоне {run} - выборка {split!r}, не test")
            elif source == "track":
                entry = track_entry(flight["run"], flight["id"])
                if flight["run"] != run:
                    rep.warn(f"{path}.flight", f"траектория прогона {flight['run']}, модель прогона {run}")
                elif entry.get("set") == "train":
                    rep.warn(f"{path}.flight", f"траектория из train прогона {run}: оценка на обучающих данных")
    return out


def check_file(path: Path) -> tuple:
    """Файл сценариев -> (Report, разрешённая копия или None)."""
    rep = Report()
    raw = path.read_bytes()
    if len(raw) > MAX_BYTES:
        rep.err("файл", f"больше {MAX_BYTES // 1024} КБ")
        return rep, None
    try:
        data = json.loads(raw.decode("utf-8"))
    except UnicodeDecodeError:
        rep.err("файл", "не UTF-8")
        return rep, None
    except json.JSONDecodeError as e:
        rep.err("файл", f"не JSON: {e}")
        return rep, None
    if not isinstance(data, dict):
        rep.err("файл", "ожидается объект {format, version, scenarios}")
        return rep, None
    unknown(rep, "файл", data, {"format", "version", "scenarios"})
    if data.get("format") != FORMAT:
        rep.err("format", f"ожидается {FORMAT!r}")
    if data.get("version") not in VERSIONS:
        rep.err("version", f"известные версии: {list(VERSIONS)}")
    scenarios = data.get("scenarios")
    if not isinstance(scenarios, list) or not 1 <= len(scenarios) <= MAX_SCENARIOS:
        rep.err("scenarios", f"список из 1..{MAX_SCENARIOS} сценариев")
        return rep, None
    resolved, names = [], {}
    for i, sc in enumerate(scenarios):
        out = check_scenario(rep, f"scenarios[{i}]", sc)
        if out is None:
            continue
        name = out.get("name")
        if isinstance(name, str):
            if name in names:
                rep.err(f"scenarios[{i}].name", f"повтор имени scenarios[{names[name]}]")
            names.setdefault(name, i)
        resolved.append(out)
    return rep, {"format": FORMAT, "version": data.get("version"), "scenarios": resolved}


# ============================================================================
# Прогон сценария движком (--run)
# ============================================================================

def build_tracks(flight: dict, pd: float, bundle: str) -> list:
    bundle_abs = str(settings.BUNDLES_ROOT / bundle)
    if flight["source"] == "log":
        path = settings.DIPLOM_PROJECT / "flight_logs" / flight["file"]
        tracks = service.tracks_from_log(flight["file"], path.read_text(encoding="utf-8", errors="replace"), None, pd,
                                         bundle_abs)["tracks"]
        return tracks if flight["piece"] == "all" else [tracks[flight["piece"]]]
    return service.tracks_from_bundle(flight["run"], flight["id"], None, pd, bundle_abs)["tracks"]


def run_scenario(sc: dict) -> None:
    flight, pd = sc["flight"], sc["radar"]["pd"]
    parts = []
    tracks_by_bundle = {}
    for m in sc["models"]:
        if m["bundle"] not in tracks_by_bundle:
            tracks_by_bundle[m["bundle"]] = build_tracks(flight, pd, m["bundle"])
        tracks = tracks_by_bundle[m["bundle"]]
        bundle_abs = str(settings.BUNDLES_ROOT / m["bundle"])
        ens = m["kind"] == "ens"
        field = "imm" if m["kind"] == "imm" else "hyb"
        num = den = 0.0
        for tr in tracks:
            out = service.run(tr, None, ens, bundle_abs, m.get("members"))
            e = out["errors"][field]
            if e["ade"] is not None:
                num, den = num + e["ade"] * e["n"], den + e["n"]
        seeds = "" if m["kind"] == "imm" else f" {m['members']}"
        parts.append(f"{m['bundle']}:{m['kind']}{seeds} {num / den:.1f} м" if den else f"{m['bundle']}:{m['kind']} нет")
    scans = sum(len(tr["t"]) for tr in next(iter(tracks_by_bundle.values())))
    check(f"Прогон: {sc['name']}", all(not p.endswith(" нет") for p in parts),
          f"кусков {len(next(iter(tracks_by_bundle.values())))}, обзоров {scans}, Pd {pd}; ADE: " + "; ".join(parts))
    if sc["mode"]["type"] == "realtime":
        m = next(x for x in sc["models"] if x["kind"] != "imm")
        tr = tracks_by_bundle[m["bundle"]][0]
        d = service.create_session(None, m["kind"] == "ens", tr["radar_pos"], tr["origin"], tr["truth"],
                                   str(settings.BUNDLES_ROOT / m["bundle"]), m["members"])
        s = service.session(d["id"])
        n_hyb = 0
        try:
            for k in range(min(RUN_SCANS, len(tr["t"]))):
                vr = tr["vr"][k] if tr["vr"] is not None else None
                res = s.scan(tr["t"][k], tr["detected"][k], tr["polar"][k], vr)
                n_hyb += res["hyb"] is not None
        finally:
            service.delete_session(d["id"])
        check(f"Реальное время: {sc['name']}", n_hyb > 0,
              f"{m['bundle']}:{m['kind']}, обзоров {min(RUN_SCANS, len(tr['t']))}, прогноз гибрида в {n_hyb}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Проверка файлов сценариев radar_app")
    parser.add_argument("files", nargs="+", type=Path, help="файлы сценариев JSON")
    parser.add_argument("--run", action="store_true", help="ещё прогнать каждый сценарий кодом диплома")
    parser.add_argument("--resolved", type=Path, default=None, help="папка для разрешённых копий файлов")
    args = parser.parse_args()
    for path in args.files:
        print(f"\n== {path.name}")
        rep, resolved = check_file(path)
        for line in rep.warnings:
            print(f"  предупреждение - {line}")
        for line in rep.notes:
            print(f"  пометка - {line}")
        for line in rep.errors:
            print(f"  ошибка - {line}")
        n = len(resolved["scenarios"]) if resolved else 0
        check(f"Сценарии {path.name}", not rep.errors, f"сценариев {n}, ошибок {len(rep.errors)}, "
                                                        f"предупреждений {len(rep.warnings)}")
        if rep.errors or resolved is None:
            continue
        if args.resolved:
            args.resolved.mkdir(parents=True, exist_ok=True)
            (args.resolved / path.name).write_text(json.dumps(resolved, ensure_ascii=False, indent=2),
                                                   encoding="utf-8")
        if args.run:
            for sc in resolved["scenarios"]:
                if sc["flight"]["source"] == "upload":
                    print(f"[----] Прогон: {sc['name']} - загруженный файл есть только у сервера, пропущен")
                    continue
                try:
                    run_scenario(sc)
                except ValueError as e:
                    check(f"Прогон: {sc['name']}", False, str(e))
    failed = results.count(False)
    print(f"\nИтого: {len(results) - failed} из {len(results)} PASS")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
