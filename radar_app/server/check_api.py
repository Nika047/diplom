"""
Проверка API сервера (PASS / FAIL, код выхода 1 при FAIL): engine\.venv\Scripts\python.exe server\check_api.py

Нужны запущенные движок (engine\main.py) и сервер (http://localhost:5080). Проверяется: вход admin, токены в
HttpOnly cookie, обновление и выход; сведения о движке; справочник моделей (модели диплома всех прогонов, гибрид на
каждый seed, загрузка пакета zip, правка, удаление); логи диплома и копия лога; прогон целиком по моделям справочника
(самый длинный кусок лога LOG при Pd 0,9 и гибриде merged_x1/dop_traj seed 42 даёт ADE 53,8 м - как engine\check.py),
другой seed, несколько моделей на одной трассе; экспорт прогноза CSV; отметки куска в формате файла РЛС, загрузка такого
файла и прогон по нему с координатами РЛС и без них; траектория пакета прогона (прогон целиком и реальное время);
реальное время с одной и несколькими моделями; справочник полётов (выборки по прогонам, траектории); виды пакетов (CV,
KF, сеть без IMM, жадный ансамбль); сценарии (форма, файл с ошибками по пути поля, правила формата, запуск в историю); история; удаление. Созданные файлы, модели, сценарии и запуски
проверка удаляет за собой. Только стандартная библиотека Python.
"""
import http.cookiejar
import io
import json
import pathlib
import zipfile
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE = "http://localhost:5080/api/"
LOG = "Chernika-2025-05-09-152254.csv"
RUN = "merged_x1"
BUNDLES = pathlib.Path(__file__).resolve().parents[2] / "diplom_project" / "bundles" / RUN
results = []

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" - {detail}" if detail else ""))


def call(method, path, body=None, raw=None, ctype="application/json"):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={"Content-Type": ctype} if data else {})
    t0 = time.perf_counter()
    try:
        with opener.open(req, timeout=300) as r:
            text = r.read()
            return r.status, text, (time.perf_counter() - t0) * 1e3
    except urllib.error.HTTPError as e:
        return e.code, e.read(), (time.perf_counter() - t0) * 1e3


def js(text):
    return json.loads(text.decode("utf-8-sig")) if text else None


def upload(name, text, kind):
    boundary = uuid.uuid4().hex
    parts = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"Kind\"\r\n\r\n{kind}\r\n"
             f"--{boundary}\r\nContent-Disposition: form-data; name=\"File\"; filename=\"{name}\"\r\n"
             f"Content-Type: text/csv\r\n\r\n").encode() + text.encode() + f"\r\n--{boundary}--\r\n".encode()
    return call("POST", "SourceFiles/Upload", raw=parts, ctype=f"multipart/form-data; boundary={boundary}")


def form(fields, file_name, data, ctype, path="Models/Upload"):
    boundary = uuid.uuid4().hex
    parts = b"".join(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
                     for k, values in fields.items() for v in (values if isinstance(values, list) else [values]))
    parts += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"File\"; filename=\"{file_name}\"\r\n"
              f"Content-Type: {ctype}\r\n\r\n").encode() + data + f"\r\n--{boundary}--\r\n".encode()
    return call("POST", path, raw=parts, ctype=f"multipart/form-data; boundary={boundary}")


def bundle_zip(case):
    """Пакет диплома в zip с вложенной папкой - как его упакует пользователь."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for f in (BUNDLES / case).iterdir():
            if f.is_file():
                z.write(f, f"{case}/{f.name}")
    return buf.getvalue()


def series(result, model_oid):
    """Ответы движка по кускам для модели запуска формата 2 и поле прогноза."""
    m = next(x for x in result["models"] if x["oid"] == model_oid)
    entry = result["runs"][m["run"]]
    res = entry["ensemble"] if m["kind"] == "ens" or entry["single"] is None else entry["single"]
    return res, "imm" if m["kind"] == "imm" else "hyb"


s, _, _ = call("GET", "Runs")
check("Без входа - 401", s == 401, str(s))
s, b, _ = call("POST", "Auth/Login", {"userName": "admin", "password": "неверный"})
check("Неверный пароль - 401", s == 401, js(b)["message"] if b else "")
s, b, _ = call("POST", "Auth/Login", {"userName": "admin", "password": "123456"})
check("Вход admin", s == 200 and js(b)["userName"] == "admin", f"роли {js(b)['roles'] if s == 200 else b}")
check("Токены в HttpOnly cookie", {c.name for c in jar} >= {".AspNetCore.Identity.Application", ".AspNetCore.Identity.Application.Refresh"})
s, b, _ = call("GET", "Auth/GetUser")
check("GetUser", s == 200 and js(b)["displayName"] == "Администратор")
s, b, _ = call("POST", "Auth/Refresh")
check("Refresh", s == 200)

s, b, _ = call("GET", "ClientSettings/Map")
check("Ключ Яндекс Карт отдаётся", s == 200 and len(js(b)["yandexMapsKey"] or "") > 10)
s, b, ms = call("GET", "Engine/Info")
info = js(b)
check("Engine/Info", s == 200 and len(info["cases"]) == 3,
      f"{', '.join(c['case'] + ': ' + c['model'] for c in info['cases'])}; пинг движка {info['ping_ms']} мс")

s, b, _ = call("GET", "Engine/Clock")
clock = js(b)
# движок и сервер на одном компьютере: часы почти совпадают
check("Часы движка к серверу", s == 200 and abs(clock["offsetMs"]) <= max(clock["rttMs"], 1.0),
      f"расхождение {clock['offsetMs']:+.3f} мс, запрос {clock['rttMs']:.3f} мс")

s, b, _ = call("GET", "Models")
catalog = js(b) if s == 200 else []
# модель диплома: (пакет от bundles/, вид, seed); у итоговых пакетов случаев - IMM, гибрид на каждый seed и ансамбль
D = {(m["bundle"], m["kind"], m["seeds"]): m["oid"] for m in catalog if m["fromDiplom"]}
runs_in_catalog = sorted({m["run"] for m in catalog if m["fromDiplom"]})


def M(case, kind, seed="42", run_name=RUN):
    return D[(f"{run_name}/{case}", kind, None if kind != "hyb" else seed)]


check("Справочник моделей: в каждом прогоне у каждого случая IMM, гибрид на каждый seed и ансамбль",
      s == 200 and len(runs_in_catalog) >= 2 and all(
          (f"{r}/{c}", k, sd) in D for r in runs_in_catalog for c in ("nodop", "dop_traj", "dop_tele")
          for k, sd in (("imm", None), ("hyb", "42"), ("hyb", "43"), ("hyb", "44"), ("ens", None)))
      and all(m["runTitle"].startswith(m["run"]) for m in catalog if m["fromDiplom"]),
      f"моделей {len(catalog)}, из диплома {len(D)}, прогоны {', '.join(runs_in_catalog)}")
s, b, _ = form({"Name": "Проверка пакета", "Kinds": ["hyb", "ens"]}, "dop_traj.zip", bundle_zip("dop_traj"), "application/zip")
mine_models = js(b) if s == 200 else []
check("Загрузка пакета zip: по модели на вид", s == 200 and len(mine_models) == 2, b[:200] if s != 200 else "")
s, b, _ = form({"Name": "Пустой", "Kinds": "hyb"}, "empty.zip", b"PK\x05\x06" + b"\x00" * 18, "application/zip")
check("Архив без config.json - 400", s == 400, js(b)["message"] if b else "")
s, _, _ = call("POST", "Models/Update", {"oid": mine_models[0], "name": "Проверка пакета, гибрид", "note": "проверка API"})
s2, b2, _ = call("GET", "Models")
mine_row = next((m for m in js(b2) if m["oid"] == mine_models[0]), {})
check("Правка наименования и примечания", s == 204 and mine_row.get("note") == "проверка API"
      and mine_row.get("bundle") == "загружен" and mine_row.get("case") == "dopTraj")
# виды пакетов: у CV, KF и жадного ансамбля одна модель, у сети без IMM - на каждый seed
types = {m["bundle"]: m for m in catalog if m["fromDiplom"] and "/extra/" in m["bundle"]}
cv, kf = types.get(f"{RUN}/nodop/extra/CV"), types.get(f"{RUN}/nodop/extra/KF")
greedy = types.get(f"{RUN}/dop_tele/extra/ensemble_MSE")
e2e = [m for m in catalog if m["bundle"] == f"{RUN}/nodop/extra/GRU_bez_IMM"]
check("Виды пакетов в справочнике: CV, KF, жадный ансамбль - по одной модели, сеть без IMM - на каждый seed и ансамбль",
      cv and kf and greedy and cv["typeTitle"] == "линейная экстраполяция" and kf["typeTitle"] == "фильтр Калмана"
      and greedy["typeTitle"] == "жадный ансамбль" and sum(m["bundle"] == cv["bundle"] for m in catalog) == 1
      and sorted(m["seeds"] or "" for m in e2e) == ["", "42", "43", "44"] and {m["modelType"] for m in e2e} == {"e2e"},
      f"{cv and cv['name']}; {kf and kf['name']}; {greedy and greedy['name']}; без IMM: {len(e2e)}")

s, _, _ = call("DELETE", f"Models?OID={M('dop_traj', 'hyb')}")
check("Модель диплома не удаляется - 409", s == 409)

s, b, _ = call("GET", "SourceFiles/DiplomLogs")
logs = js(b)
check("Логи диплома", s == 200 and any(x["name"] == LOG for x in logs), f"{len(logs)} файлов")
s, b, _ = call("POST", "SourceFiles/ImportDiplomLog", {"name": "..\\config.py"})
check("Чужой путь не принимается", s == 400)
s, b, _ = call("POST", "SourceFiles/ImportDiplomLog", {"name": LOG})
src = js(b)
check("Лог диплома скопирован", s == 200 and src["kind"] == "log" and src["fromDiplom"], f"{src['size']} байт")

hyb = M("dop_traj", "hyb")
imm = M("dop_traj", "imm")
s, b, ms = call("POST", "Runs", {"sourceFileOID": src["oid"], "models": [imm, hyb], "pd": 0.9})
run = js(b)
check("Прогон целиком (IMM и гибрид dop_traj, Pd 0,9)", s == 200 and run["adeHyb"] < run["adeImm"]
      and run["modelOIDs"] == [imm, hyb] and run["adeModel"] == run["model"].split("; ")[1],
      f"{run.get('model')}, кусков {run.get('trackCount')}, обзоров {run.get('scanCount')}, ADE IMM {run.get('adeImm', 0):.1f} м, "
      f"гибрид {run.get('adeHyb', 0):.1f} м, движок {run.get('durationMs', 0):.0f} мс, запрос {ms:.0f} мс" if s == 200 else b[:300])

s, b, ms = call("GET", f"Runs/Result?OID={run['oid']}")
res = js(b)
longest = max(range(len(res["tracks"])), key=lambda i: len(res["tracks"][i]["t"]))
hyb_res, _ = series(res, hyb)
e = hyb_res[longest]["errors"]
check("Результат: самый длинный кусок совпадает с check.py движка (ADE гибрид 53,8 м)",
      s == 200 and res["format"] == 2 and abs(e["hyb"]["ade"] - 53.8) < 0.05,
      f"{len(b) / 1024:.0f} КБ, кусок {longest}: обзоров {len(res['tracks'][longest]['t'])}, ADE IMM {e['imm']['ade']} м, "
      f"гибрид {e['hyb']['ade']} м; запрос {ms:.0f} мс")

s, b, _ = call("POST", "Runs", {"sourceFileOID": src["oid"], "models": [mine_models[0]], "pd": 0.9})
mrun = js(b)
s2, b2, _ = call("GET", f"Runs/Result?OID={mrun['oid']}") if s == 200 else (s, b"", 0)
mres, _ = series(js(b2), mine_models[0]) if s2 == 200 else ([], None)
check("Загруженный пакет даёт тот же прогноз, что пакет диплома", s == 200
      and abs(mres[longest]["errors"]["hyb"]["ade"] - e["hyb"]["ade"]) < 1e-9, b[:200] if s != 200 else "")
s, b, _ = call("GET", "Runs")
mrow = next((r for r in js(b) if r["oid"] == mrun.get("oid")), {}) if s == 200 else {}
check("История: без выбранного IMM ADE IMM пусто, у модели ADE - её наименование",
      mrow.get("adeImm") is None and mrow.get("adeHyb") is not None and mrow.get("adeModel") == mrow.get("model"),
      f"ADE IMM {mrow.get('adeImm')}, модель ADE «{mrow.get('adeModel')}» {mrow.get('adeHyb')} м")

seed43 = M("dop_traj", "hyb", "43")
s, b, _ = call("POST", "Runs", {"sourceFileOID": src["oid"], "models": [hyb, seed43], "pd": 0.9})
srun = js(b)
s2, b2, _ = call("GET", f"Runs/Result?OID={srun['oid']}") if s == 200 else (s, b"", 0)
sres = js(b2) if s2 == 200 else {}
ade42, ade43 = (series(sres, o)[0][longest]["errors"]["hyb"]["ade"] for o in (hyb, seed43)) if sres else (None, None)
check("Два seed одного пакета: два прогона движка с выбранными seed, гибриды различаются",
      s == 200 and sorted(str(x["members"]) for x in sres["runs"].values()) == ["[42]", "[43]"] and abs(ade42 - 53.8) < 0.05
      and ade43 != ade42, f"ADE гибрида: seed 42 {ade42} м, seed 43 {ade43} м")

picked = [M("nodop", "imm"), M("nodop", "hyb"), hyb, M("dop_tele", "imm"), M("dop_tele", "ens")]
s, b, ms = call("POST", "Runs", {"sourceFileOID": src["oid"], "pd": 0.9, "models": picked})
cmp_run = js(b)
s2, b2, _ = call("GET", f"Runs/Result?OID={cmp_run['oid']}") if s == 200 else (s, b"", 0)
cmp = js(b2) if s2 == 200 else {}
cmp_res, _ = series(cmp, hyb) if cmp else ([], None)
tele = next((cmp["runs"][m["run"]] for m in cmp.get("models", []) if m["oid"] == M("dop_tele", "ens")), {})
# тот же лог и те же куски, что у прогона выше: longest - самый длинный кусок
cmp_ade = cmp_res[longest]["errors"]["hyb"]["ade"] if cmp_res else None
check("Несколько моделей: 5 моделей, гибрид доплера по траектории - те же 53,8 м, у телеметрии только ансамбль",
      s == 200 and cmp_run["mode"] == "full" and [m["oid"] for m in cmp["models"]] == picked and abs(cmp_ade - 53.8) < 0.05
      and len(cmp["runs"]) == 3 and tele.get("single") is None and tele.get("ensemble") is not None
      and all(m["ade"] is not None for m in cmp["models"]),
      f"ADE моделей: {', '.join(str(round(m['ade'], 1)) for m in cmp.get('models', []))}; запрос {ms:.0f} мс" if s == 200 else b[:200])
s, b, _ = call("GET", f"Runs/ExportForecast?OID={cmp_run['oid']}")
methods = {line.split(",")[5] for line in b.decode("utf-8-sig").splitlines()[1:]}
expected = {m["name"].replace(",", ";") for m in cmp.get("models", [])}
check("Экспорт: все 5 моделей в столбце «метод»", s == 200 and methods == expected and len(expected) == 5, "; ".join(sorted(methods)))
s, b, _ = call("POST", "Runs", {"sourceFileOID": src["oid"], "models": []})
check("Запуск без моделей - 400", s == 400)
s, b, _ = call("POST", "Runs", {"sourceFileOID": src["oid"], "models": [str(uuid.uuid4())]})
check("Неизвестная модель - 400", s == 400)

s, b, _ = call("GET", f"Runs/ExportForecast?OID={run['oid']}")
lines = b.decode("utf-8-sig").splitlines()
check("Экспорт прогноза CSV", s == 200 and lines[0].startswith("кусок,k,t_s,h") and len(lines) > 1000, f"{len(lines)} строк")

s, b, _ = call("GET", f"Runs/RadarFile?OID={run['oid']}&Track={longest}")
rf = js(b)
check("Отметки куска в формате файла РЛС", s == 200 and rf["text"].startswith("t,range_m,az_deg,el_deg,vr_mps"),
      f"{rf['fileName']}, РЛС {rf['radar']['lat']:.5f}, {rf['radar']['lon']:.5f}")

s, b, _ = upload(rf["fileName"], rf["text"], "radar")
rsrc = js(b)
check("Загрузка файла отметок", s == 200 and rsrc["kind"] == "radar")
s, b, _ = call("GET", "Flights")
flights = js(b) if s == 200 else []
dlog = next((f for f in flights if f["key"] == LOG), {})
mine = next((f for f in flights if f["key"] == rsrc["oid"]), {})
tracks = [f for f in flights if f["kind"] == "track"]
check("Справочник полётов: выборки лога по прогонам, траектории пакетов",
      dlog.get("splits") == {"base_x1": "train", "merged_x1": "train"} and len(tracks) > 0
      and {f["origin"] for f in tracks} == {"synth", "aug"} and {f["run"] for f in tracks} == set(runs_in_catalog),
      f"траекторий {len(tracks)}; {LOG}: {dlog.get('splits')}")
check("Справочник полётов: лог диплома с запусками и загруженный файл отметок",
      s == 200 and dlog.get("origin") == "real" and dlog.get("pieces", 0) > 0 and dlog.get("runCount", 0) >= 1
      and mine.get("origin") == "manual" and mine.get("kind") == "radar" and mine.get("pieces") == 1
      and 0 < mine.get("durationS", 0) <= (len(res["tracks"][longest]["t"]) - 1) * 2,
      f"строк {len(flights)}; {LOG}: кусков {dlog.get('pieces')}, запусков {dlog.get('runCount')}; файл отметок: "
      f"{mine.get('durationS')} с" if s == 200 else str(s))
s, b, _ = call("POST", "Runs", {"sourceFileOID": rsrc["oid"], "models": [hyb], "radarLat": rf["radar"]["lat"],
                                "radarLon": rf["radar"]["lon"], "radarAlt": rf["radar"]["alt"]})
rrun = js(b)
check("Прогон по файлу отметок с координатами РЛС", s == 200 and rrun["adeHyb"] is None
      and rrun["scanCount"] == len(res["tracks"][longest]["t"]), f"обзоров {rrun.get('scanCount')}")
s, b, _ = call("POST", "Runs", {"sourceFileOID": rsrc["oid"], "models": [hyb], "radarLat": 59.9})
check("Только широта без долготы - 400", s == 400, js(b)["message"] if b else "")
s, b, _ = call("POST", "Runs", {"sourceFileOID": rsrc["oid"], "models": [hyb]})
nrun = js(b)
s2, b2, _ = call("GET", f"Runs/Result?OID={nrun['oid']}")
check("Прогон по файлу отметок без координат - только ENU", s == 200 and series(js(b2), hyb)[0][0]["hyb_ll"] is None)
s, b, _ = call("POST", "Runs", {"sourceFileOID": rsrc["oid"], "models": [M("nodop", "hyb")]})
check("Файл с доплером и модель без доплера - прогон идёт", s == 200, b[:200] if s != 200 else "")

# траектория пакета прогона: истина ENU без широты и долготы, отметки - моделью РЛС диплома
track = next(f for f in tracks if f["run"] == RUN and f["origin"] == "synth")
s, b, _ = call("POST", "Runs", {"trackRun": RUN, "trackId": track["trackId"], "models": [M("dop_traj", "imm"), hyb], "pd": 0.9})
trun = js(b)
s2, b2, _ = call("GET", f"Runs/Result?OID={trun['oid']}") if s == 200 else (s, b"", 0)
tres = js(b2) if s2 == 200 else {}
check("Прогон по траектории пакета: на плоскости, с ошибками", s == 200 and trun["kind"] == "track"
      and trun["fileName"] == track["trackId"] and trun["trackRun"] == RUN and trun["adeHyb"] is not None
      and tres["tracks"][0]["origin"] is None and series(tres, hyb)[0][0]["hyb_ll"] is None,
      f"{RUN}/{track['trackId']}: обзоров {trun.get('scanCount')}, ADE IMM {trun.get('adeImm')} м, гибрид {trun.get('adeHyb')} м"
      if s == 200 else b[:200])
s, b, _ = call("POST", "Runs", {"trackRun": RUN, "trackId": "нет такой", "models": [hyb]})
check("Неизвестная траектория - 400", s == 400, js(b)["message"] if b else "")
s, b, _ = call("POST", "Runs", {"trackRun": RUN, "trackId": track["trackId"], "models": [hyb], "pd": 0})
check("Pd вне (0; 1] - 400", s == 400, js(b)["message"] if b else "")
s, b, _ = call("POST", "Realtime", {"trackRun": RUN, "trackId": track["trackId"], "models": [hyb], "pd": 0.9})
trt = js(b)
s2, _, _ = call("POST", "Realtime/Step", {"oid": trt["oid"]}) if s == 200 else (s, b"", 0)
check("Реальное время по траектории пакета", s == 200 and s2 == 200 and trt["fileName"] == track["trackId"],
      f"обзоров {trt.get('state', {}).get('total')}" if s == 200 else b[:200])
call("DELETE", f"Runs?OID={trt['oid']}")
s, b, _ = call("GET", "Flights")
trow = next((f for f in js(b) if f["key"] == f"{RUN}/{track['trackId']}"), {})
check("Запуск по траектории считается в справочнике полётов", trow.get("runCount") == 1, str(trow.get("runCount")))
call("DELETE", f"Runs?OID={trun['oid']}")

# сценарии: форма, файл (ошибки с путём поля), запуск в историю
name1 = f"Проверка API {uuid.uuid4().hex[:6]}"
s, b, _ = call("POST", "Scenarios/Save", {"name": name1, "flightSource": "log", "logName": LOG, "mode": "full", "pd": 0.9,
                                          "models": [M("dop_traj", "imm"), hyb], "basemap": "plane", "horizons": [2, 10],
                                          "layers": ["truth", "plots"], "focus": True})
sc1 = js(b)
check("Сценарий формы сохранён", s == 200 and sc1["modelOIDs"] == [M("dop_traj", "imm"), hyb] and sc1["horizons"] == "2,10",
      b[:200] if s != 200 else sc1["models"])
s, b, _ = call("POST", "Scenarios/Save", {"name": name1, "flightSource": "log", "logName": LOG, "mode": "full", "models": [hyb]})
check("Сценарий с тем же наименованием - 400", s == 400, js(b)["message"] if b else "")
s, b, _ = call("POST", "Scenarios/Save", {"name": name1 + "-", "flightSource": "log", "logName": LOG, "mode": "full",
                                          "models": [hyb], "speed": 10, "radarLat": 60})
errs = js(b).get("errors", []) if b else []
check("Ошибки формы - списком с полем", s == 400 and any(x.startswith("mode") for x in errs) and any(x.startswith("radar") for x in errs),
      "; ".join(errs))
s, b, ms = call("POST", "Scenarios/Run", {"oid": sc1["oid"]})
sr = js(b)
s2, b2, _ = call("GET", "Runs")
srow = next((r for r in js(b2) if r["oid"] == sr["oid"]), {}) if s == 200 else {}
check("Запуск сценария - запись в истории", s == 200 and sr["mode"] == "full" and srow.get("scenarioName") == name1
      and abs(srow.get("adeHyb", 0) - 53.8) < 0.05, f"ADE гибрида {srow.get('adeHyb')} м, запрос {ms:.0f} мс" if s == 200 else b[:200])
call("DELETE", f"Runs?OID={sr['oid']}")

name2 = f"Проверка файла {uuid.uuid4().hex[:6]}"
good = {"format": "radar_app/scenario", "version": 1, "scenarios": [{
    "name": name2, "note": "из файла",
    "flight": {"source": "track", "run": RUN, "id": track["trackId"]},
    "models": [f"{RUN}/dop_traj:imm", {"bundle": f"{RUN}/dop_traj", "kind": "hyb", "members": [43]}, f"{RUN}/dop_traj:ens"],
    "mode": {"type": "realtime", "speed": 10, "start_scan": 5, "autoplay": False},
    "radar": {"pd": 0.9},
    "view": {"basemap": "plane", "horizons_s": [10], "layers": ["truth", "gate"], "focus": False}}]}
bad = {"format": "radar_app/scenario", "version": 1, "scenarios": [{
    "name": "x", "flight": {"source": "log", "file": "нет.csv"}, "models": ["merged_x1/dop_traj:hyb", "merged_x1/nodop:abc"],
    "mode": {"type": "full", "speed": 3}, "colour": 1}]}
s, b, _ = form({}, "bad.json", json.dumps(bad).encode(), "application/json", "Scenarios/Upload")
errs = js(b).get("errors", []) if b else []
check("Файл сценариев с ошибками - 400, ошибки с путём поля, ничего не сохранено",
      s == 400 and {"scenarios[0].colour", "scenarios[0].flight.file", "scenarios[0].models[1]", "scenarios[0].mode"}
      <= {x.split(":")[0] for x in errs}, "; ".join(errs))
s, b, _ = form({}, "good.json", json.dumps(good, ensure_ascii=False).encode(), "application/json", "Scenarios/Upload")
up = js(b) if s == 200 else []
s2, b2, _ = call("GET", f"Scenarios/Get?OID={up[0]}") if s == 200 else (s, b"", 0)
sc2 = js(b2) if s2 == 200 else {}
check("Файл сценариев загружен: траектория, модели с seed, реальное время, вид",
      s == 200 and sc2.get("modelOIDs") == [M("dop_traj", "imm"), M("dop_traj", "hyb", "43"), M("dop_traj", "ens")]
      and sc2.get("flightSource") == "track" and sc2.get("mode") == "realtime" and sc2.get("startScan") == 5
      and sc2.get("autoplay") is False and sc2.get("layers") == "truth,gate", b[:300] if s != 200 else sc2.get("models"))
s, b, _ = call("POST", "Scenarios/Run", {"oid": up[0]}) if up else (0, b"", 0)
sr2 = js(b) if s == 200 else {}
s2, b2, _ = call("GET", f"Realtime/Get?OID={sr2.get('oid')}") if s == 200 else (s, b"", 0)
st2 = js(b2)["state"] if s2 == 200 else {}
check("Запуск сценария реального времени: с обзора 5, без пуска", s == 200 and sr2["mode"] == "realtime"
      and st2.get("position") == 5 and st2.get("playing") is False, str(st2) if s == 200 else b[:200])
call("DELETE", f"Runs?OID={sr2.get('oid')}")
s, b, _ = form({}, "good.json", json.dumps(good, ensure_ascii=False).encode(), "application/json", "Scenarios/Upload")
check("Повторная загрузка того же наименования - 400", s == 400)

# правила формата (scenarios\README.md, «Формат») и виды пакетов
rules = {"format": "radar_app/scenario", "version": 1, "scenarios": [
    {"name": "r0", "flight": {"source": "log", "file": LOG, "piece": "all"}, "models": [f"{RUN}/dop_traj:imm"],
     "mode": {"type": "realtime"}, "view": {"focus": True, "follow": True}},
    {"name": "r1", "flight": {"source": "log", "file": LOG}, "models": [
        {"bundle": f"{RUN}/dop_traj", "kind": "hyb", "members": [42, 43]},
        {"bundle": f"{RUN}/dop_traj", "kind": "ens", "members": [42, 43]},
        {"bundle": f"{RUN}/nodop/extra/CV", "kind": "hyb", "members": [42]},
        f"{RUN}/nodop/extra/KF:ens", f"{RUN}/nodop/compare/IMM_GRU:imm", f"{RUN}/nodop:hyb"],
     "mode": {"type": "realtime", "speed": 25}},
    {"name": "r2", "flight": {"source": "track", "run": RUN, "id": track["trackId"]}, "models": [f"{RUN}/nodop:hyb"],
     "mode": {"type": "full"}, "view": {"basemap": "osm"}}]}
s, b, _ = form({}, "rules.json", json.dumps(rules).encode(), "application/json", "Scenarios/Upload")
paths = {x.split(":")[0] for x in (js(b) or {}).get("errors", [])}
check("Правила 09.11: один кусок в реальном времени, фокус или слежение, seed у hyb и ens, CV и KF без seed и ens, IMM - у "
      "пакета случая, ускорение при 5+ моделях, у траектории - только плоскость",
      s == 400 and {"scenarios[0].flight.piece", "scenarios[0].view", "scenarios[1].models[0]", "scenarios[1].models[1]",
                    "scenarios[1].models[2]", "scenarios[1].models[3]", "scenarios[1].models[4]", "scenarios[2].view.basemap"} <= paths,
      "; ".join(sorted(paths)))
kinds = {"format": "radar_app/scenario", "version": 1, "scenarios": [{
    "name": f"Виды пакетов {uuid.uuid4().hex[:6]}", "flight": {"source": "log", "file": LOG},
    "models": [f"{RUN}/nodop:imm", f"{RUN}/nodop/extra/CV:hyb", f"{RUN}/nodop/extra/KF:hyb",
               {"bundle": f"{RUN}/nodop/extra/GRU_bez_IMM", "kind": "hyb", "members": [43]}],
    "mode": {"type": "full"}, "radar": {"pd": 0.9}, "view": {"follow": True}}]}
s, b, _ = form({}, "kinds.json", json.dumps(kinds, ensure_ascii=False).encode(), "application/json", "Scenarios/Upload")
kup = js(b) if s == 200 else []
s2, b2, ms = call("POST", "Scenarios/Run", {"oid": kup[0]}) if kup else (s, b, 0)
kr = js(b2) if s2 == 200 else {}
s3, b3, _ = call("GET", f"Runs/Result?OID={kr.get('oid')}") if s2 == 200 else (s2, b"", 0)
kres = js(b3) if s3 == 200 else {}
ades = [round(m["ade"], 1) for m in kres.get("models", [])]
s4, b4, _ = call("GET", f"Scenarios/Get?OID={kup[0]}") if kup else (0, b"", 0)
check("Сценарий с CV, KF и сетью без IMM: загружен со слежением, прогноз каждой модели посчитан",
      s == 200 and s2 == 200 and len(ades) == 4 and len(set(ades)) == 4 and (js(b4) or {}).get("follow") is True,
      f"ADE моделей: {', '.join(map(str, ades))}; запрос {ms:.0f} мс" if s2 == 200 else (b or b2)[:300])
if kr.get("oid"):
    call("DELETE", f"Runs?OID={kr['oid']}")
for oid in kup:
    call("DELETE", f"Scenarios?OID={oid}")
# загруженный файл: у отметок координаты РЛС необязательны, без них подложки нет; лог - как log
def upload_errors(fields):
    s, b, _ = call("POST", "Scenarios/Save", {"name": f"upload {uuid.uuid4().hex[:6]}", "flightSource": "upload",
                                              "mode": "full", "models": [hyb], **fields})
    if s == 200:
        call("DELETE", f"Scenarios?OID={js(b)['oid']}")
    return s, {x.split(":")[0] for x in (js(b) or {}).get("errors", [])} if s == 400 else set()


radar_osm = upload_errors({"sourceFileOID": rsrc["oid"], "basemap": "osm"})
radar_alt = upload_errors({"sourceFileOID": rsrc["oid"], "radarAlt": 10})
radar_geo = upload_errors({"sourceFileOID": rsrc["oid"], "basemap": "yandex", "radarLat": rf["radar"]["lat"],
                           "radarLon": rf["radar"]["lon"]})
log_text = (BUNDLES.parents[1] / "flight_logs" / LOG).read_text(encoding="utf-8")
s, b, _ = upload(f"check_api_{uuid.uuid4().hex[:6]}.csv", log_text, "log")
lsrc = js(b) if s == 200 else {}
log_geo = upload_errors({"sourceFileOID": lsrc.get("oid"), "radarLat": 60, "radarLon": 30})
log_ok = upload_errors({"sourceFileOID": lsrc.get("oid"), "pd": 0.9, "basemap": "osm"})
if lsrc:
    call("DELETE", f"SourceFiles?OID={lsrc['oid']}")
check("Загруженный файл в сценарии: у отметок без координат osm - ошибка, alt без lat и lon - ошибка, с координатами - "
      "подложка есть; загруженный лог - pd и подложка, координаты РЛС - ошибка",
      radar_osm == (400, {"view.basemap"}) and radar_alt == (400, {"radar.alt"}) and radar_geo[0] == 200
      and lsrc.get("kind") == "log" and log_geo == (400, {"radar"}) and log_ok[0] == 200,
      f"отметки: {radar_osm}, {radar_alt}, {radar_geo}; лог: {lsrc.get('kind')}, {log_geo}, {log_ok}")
s, b, _ = call("POST", "Scenarios/Save", {"name": name2 + " файл", "flightSource": "upload", "sourceFileOID": rsrc["oid"],
                                          "mode": "full", "models": [hyb]})
sc3 = js(b) if s == 200 else {}
s2, _, _ = call("DELETE", f"SourceFiles?OID={rsrc['oid']}")
check("Загруженный файл в сценарии не удаляется - 409", s == 200 and s2 == 409, b[:200] if s != 200 else "")
s, b, _ = call("GET", "Scenarios")
names = {x["name"] for x in js(b)} if s == 200 else set()
for oid in [sc1["oid"], *up, sc3.get("oid")]:
    if oid:
        call("DELETE", f"Scenarios?OID={oid}")
s2, b2, _ = call("GET", "Scenarios")
check("Список сценариев и удаление", s == 200 and {name1, name2} <= names
      and not ({name1, name2} & {x["name"] for x in js(b2)}))

# реальное время: события SignalR здесь не читаются (проверка в браузере), состояние - по ответам REST
s, b, ms = call("POST", "Realtime", {"sourceFileOID": src["oid"], "models": [hyb], "pd": 0.9})
rt = js(b)
check("Сессия реального времени создана", s == 200 and rt["state"]["position"] == -1 and rt["engine"]["has_variants"]
      and rt["maxSpeed"] == 50 and [m["oid"] for m in rt["models"]] == [hyb],
      f"{rt.get('engine', {}).get('model')}, обзоров {rt.get('state', {}).get('total')}, запрос {ms:.0f} мс" if s == 200 else b[:200])
for _ in range(3):
    s, b, step_ms = call("POST", "Realtime/Step", {"oid": rt["oid"]})
st = js(b)
check("Шаг: три обзора посчитаны", s == 200 and st["position"] == 2 and st["computed"] == 3, f"последний шаг {step_ms:.0f} мс")
s, b, ms = call("POST", "Realtime/Seek", {"oid": rt["oid"], "k": 120})
st = js(b)
check("Перемотка вперёд: движок догнал пакетом", s == 200 and st["position"] == 120 and st["computed"] == 121, f"{ms:.0f} мс")
s, b, _ = call("POST", "Realtime/Seek", {"oid": rt["oid"], "k": 50})
st = js(b)
check("Перемотка назад: из памяти, без новых обзоров", s == 200 and st["position"] == 50 and st["computed"] == 121)
s, b, _ = call("POST", "Realtime/Seek", {"oid": rt["oid"], "k": 120})
s, b, _ = call("POST", "Realtime/Play", {"oid": rt["oid"], "speed": 50})
time.sleep(2.0)
s, b, _ = call("POST", "Realtime/Pause", {"oid": rt["oid"]})
st = js(b)
# x50 - обзор раз в 40 мс: за 2 с около 50 обзоров
check("Пуск x50 на 2 с и пауза", s == 200 and not st["playing"] and 30 <= st["position"] - 120 <= 60, f"обзоров за 2 с: {st['position'] - 120}")
s, b, _ = call("GET", f"Realtime/Get?OID={rt['oid']}")
full = js(b)
last = full["scans"][-1]
stamps = last["stamps"]
check("Get: трасса и все посчитанные обзоры с метками времени", s == 200 and len(full["scans"]) == st["computed"]
      and stamps["plotMs"] <= stamps["engineReceivedMs"] <= stamps["engineDoneMs"] and last["result"]["err"] is not None,
      f"последний обзор: сервер -> движок {stamps['engineReceivedMs'] - stamps['plotMs']:.2f} мс, "
      f"движок {stamps['engineDoneMs'] - stamps['engineReceivedMs']:.2f} мс")
s, _, _ = call("DELETE", f"Realtime?OID={rt['oid']}")
s2, _, _ = call("GET", f"Realtime/Get?OID={rt['oid']}")
check("Закрытие сессии: потом 404", s == 204 and s2 == 404)
s, b, _ = call("GET", f"Runs/Result?OID={rt['oid']}")
saved = js(b)
sc = saved["realtime"]["scans"] if s == 200 else []
check("Сохранённая сессия: обзоры, модель и метка отправки", s == 200 and len(sc) == st["computed"]
      and saved["engine"]["model"] and all("sentMs" in x["stamps"] for x in sc if x["k"] > 120),
      f"обзоров {len(sc)}, модель {saved.get('engine', {}).get('model')}" if s == 200 else str(s))
s, b, _ = call("POST", "Realtime", {"sourceFileOID": src["oid"], "models": picked, "pd": 0.9, "speed": 50})
rt5 = js(b)
s2, b2, _ = call("POST", "Realtime/Step", {"oid": rt5["oid"]}) if s == 200 else (s, b"", 0)
s3, b3, _ = call("GET", f"Realtime/Get?OID={rt5['oid']}") if s == 200 else (s, b"", 0)
scan5 = js(b3)["scans"][0] if s3 == 200 else {}
# IMM телеметрии берётся из сессии ансамбля своего пакета: 3 сессии на 5 моделей
check("Реальное время, 5 моделей: 3 сессии движка, ускорение не выше x10",
      s == 200 and rt5["maxSpeed"] == 10 and rt5["state"]["speed"] == 10 and len(rt5["engines"]) == 3
      and set(scan5.get("results", {})) == set(rt5["engines"]) and {m["session"] for m in rt5["models"]} == set(rt5["engines"]),
      f"сессии {', '.join(rt5.get('engines', {}))}" if s == 200 else b[:200])
call("DELETE", f"Runs?OID={rt5['oid']}")

s, b, _ = call("POST", "Realtime", {"sourceFileOID": src["oid"], "models": [M("nodop", "hyb")]})
rt2 = js(b)
call("POST", "Realtime/Step", {"oid": rt2["oid"]})
s, _, _ = call("DELETE", f"Runs?OID={rt2['oid']}")
s2, _, _ = call("GET", f"Realtime/Get?OID={rt2['oid']}")
check("Удаление запуска с открытой сессией закрывает её", s == 204 and s2 == 404)

s, b, _ = call("GET", "Runs")
lst = js(b)
rt_row = next((r for r in lst if r["oid"] == rt["oid"]), None)
check("Сессия в истории как реальное время", rt_row is not None and rt_row["mode"] == "realtime" and rt_row["scanCount"] == st["computed"])
check("История запусков", s == 200 and len(lst) >= 5 and lst[0]["created"] >= lst[-1]["created"], f"{len(lst)} запусков")
s, b, _ = call("GET", "SourceFiles")
check("Список файлов с числом запусков", s == 200 and any(f["oid"] == rsrc["oid"] and f["runCount"] == 3 for f in js(b)))

s, b, _ = call("DELETE", f"SourceFiles?OID={src['oid']}")
check("Файл с запусками не удаляется - 409", s == 409)
for r in lst:
    if r["sourceFileOID"] in (src["oid"], rsrc["oid"]):
        call("DELETE", f"Runs?OID={r['oid']}")
s1, _, _ = call("DELETE", f"SourceFiles?OID={src['oid']}")
s2, _, _ = call("DELETE", f"SourceFiles?OID={rsrc['oid']}")
check("Удаление запусков и файлов", s1 == 204 and s2 == 204)

s, _, _ = call("DELETE", f"Models?OID={mine_models[0]}")
s2, _, _ = call("DELETE", f"Models?OID={mine_models[1]}")
s3, b3, _ = call("GET", "Models")
check("Удаление загруженных моделей без запусков", s == 204 and s2 == 204 and not any(m["oid"] in mine_models for m in js(b3)))

s, _, _ = call("POST", "Auth/Logout")
s2, _, _ = call("GET", "Auth/GetUser")
check("Выход: после него 401", s == 204 and s2 == 401)

print(f"\nИтог: {'PASS' if all(results) else 'FAIL'} ({sum(results)} из {len(results)})")
sys.exit(0 if all(results) else 1)
