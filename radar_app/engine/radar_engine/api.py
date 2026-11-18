"""
HTTP-интерфейс движка (FastAPI). Описание методов и форматов - .agent_docs/ARCHITECTURE.md, «API движка».

Методы синхронные: FastAPI выполняет их в пуле потоков, а код диплома всё равно идёт по одному под diplom.LOCK.
Ошибка входных данных (ValueError) - ответ 400, неизвестная сессия (service.NotFound) - 404.
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from radar_engine import service

log = logging.getLogger("radar_engine")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # пакеты загружаются при старте, чтобы первый прогноз не ждал чтения весов
    for case in service.info()["cases"]:
        if "error" in case:
            log.warning("Случай %s: %s", case["case"], case["error"])
        else:
            log.info("Случай %s: %s, окно %d, три варианта: %s", case["case"], case["model"], case["window"],
                     "есть" if case["has_variants"] else "нет в пакете")
    yield


app = FastAPI(title="Движок прогноза", lifespan=lifespan)


@app.exception_handler(ValueError)
async def bad_request(_request: Request, exc: ValueError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.exception_handler(service.NotFound)
async def not_found(_request: Request, exc: service.NotFound):
    return JSONResponse(status_code=404, content={"detail": str(exc)})


# модель: bundle - путь к папке пакета (справочник моделей приложения); без него - пакет случая case в BUNDLES_DIR

class LogRequest(BaseModel):
    name: str
    text: str
    case: str | None = None
    bundle: str | None = None
    pd: float = 1.0


class RadarRequest(BaseModel):
    name: str
    text: str
    case: str | None = None
    bundle: str | None = None
    lat: float | None = None
    lon: float | None = None
    alt: float = 0.0


class DescribeRequest(BaseModel):
    name: str
    text: str
    kind: str  # log | radar


class BundleTrackRequest(BaseModel):
    run: str
    id: str
    case: str | None = None
    bundle: str | None = None
    pd: float = 1.0


class TrackRequest(BaseModel):
    track: dict


class RunRequest(BaseModel):
    track: dict
    case: str | None = None
    bundle: str | None = None
    ensemble: bool = False
    members: list[int] | None = None  # seed участников пакета; нет - по умолчанию (все при ensemble, иначе первый)


class BundleRequest(BaseModel):
    bundle: str


class SessionRequest(BaseModel):
    case: str | None = None
    bundle: str | None = None
    ensemble: bool = False
    members: list[int] | None = None
    radar_pos: list[float]
    origin: list[float] | None = None
    truth: list[list[float] | None] | None = None  # истина трассы - только для ошибки прогноза в ответе


class Scan(BaseModel):
    t: float
    detected: bool
    polar: list[float] | None = None
    vr: float | None = None


class ScanBatch(BaseModel):
    scans: list[Scan]


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "time_ms": service.now_ms()}


@app.get("/info")
def info() -> dict:
    return service.info()


@app.post("/bundles/describe")
def bundles_describe(req: BundleRequest) -> dict:
    return service.describe_bundle(req.bundle)


@app.get("/logs")
def logs() -> dict:
    return service.logs_catalog()


@app.get("/tracks")
def tracks() -> dict:
    return service.tracks_catalog()


@app.post("/logs/describe")
def logs_describe(req: DescribeRequest) -> dict:
    return service.describe_file(req.name, req.text, req.kind)


@app.post("/tracks/log")
def tracks_log(req: LogRequest) -> dict:
    return service.tracks_from_log(req.name, req.text, req.case, req.pd, req.bundle)


@app.post("/tracks/radar")
def tracks_radar(req: RadarRequest) -> dict:
    return service.tracks_from_radar(req.name, req.text, req.case, req.lat, req.lon, req.alt, req.bundle)


@app.post("/tracks/bundle")
def tracks_bundle(req: BundleTrackRequest) -> dict:
    return service.tracks_from_bundle(req.run, req.id, req.case, req.pd, req.bundle)


@app.post("/tracks/radar-csv")
def tracks_radar_csv(req: TrackRequest) -> dict:
    return service.radar_csv(req.track)


@app.post("/run")
def run(req: RunRequest) -> dict:
    return service.run(req.track, req.case, req.ensemble, req.bundle, req.members)


@app.get("/sessions")
def sessions() -> list:
    return service.sessions()


@app.post("/sessions")
def create_session(req: SessionRequest) -> dict:
    return service.create_session(req.case, req.ensemble, req.radar_pos, req.origin, req.truth, req.bundle,
                                  req.members)


@app.post("/sessions/{sid}/scan")
def scan(sid: str, req: Scan) -> dict:
    return service.session(sid).scan(req.t, req.detected, req.polar, req.vr)


@app.post("/sessions/{sid}/scans")
def scans(sid: str, req: ScanBatch) -> dict:
    s = service.session(sid)
    return {"results": [s.scan(x.t, x.detected, x.polar, x.vr) for x in req.scans]}


@app.delete("/sessions/{sid}")
def delete_session(sid: str) -> dict:
    service.delete_session(sid)
    return {"deleted": sid}
