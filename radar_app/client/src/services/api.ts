import { client } from "./client";
import { API_CONFIG } from "../data/settings";
import type {
    CompareResult, DiplomLog, EngineInfo, FlightRow, ForecastKind, ModelRow, RealtimeArchiveData, RealtimeSessionInfo, RealtimeState, RunCreateModel, RunMode,
    RunResult, RunResultV2, RunRow, ScenarioEditModel, ScenarioRow, SourceFileRow, SourceKind,
} from "../data/dataModel";

const ep = API_CONFIG.apiData.endpoints;

export const engineApi = {
    info: () => client.get<EngineInfo>(ep.engineInfo).then((r) => r.data),
};

export const flightsApi = {
    // первый запрос после запуска движка ждёт разбора всех логов диплома (несколько секунд)
    list: () => client.get<FlightRow[]>(ep.flights, { timeout: 120_000 }).then((r) => r.data),
};

export const modelsApi = {
    list: () => client.get<ModelRow[]>(ep.models).then((r) => r.data),
    // пакет zip: движок читает config.json и веса всех сетей - это может занять несколько секунд
    upload: (file: File, name: string, note: string, kinds: ForecastKind[]) => {
        const form = new FormData();
        form.append("File", file);
        form.append("Name", name);
        form.append("Note", note);
        kinds.forEach((k) => form.append("Kinds", k));
        return client.post<string[]>(ep.modelsUpload, form, { headers: { "Content-Type": "multipart/form-data" }, timeout: 300_000 })
            .then((r) => r.data);
    },
    update: (oid: string, name: string, note: string) => client.post(ep.modelsUpdate, { oid, name, note }),
    remove: (oid: string) => client.delete(ep.models, { params: { OID: oid } }),
};

export const scenariosApi = {
    list: () => client.get<ScenarioRow[]>(ep.scenarios).then((r) => r.data),
    get: (oid: string) => client.get<ScenarioRow>(ep.scenariosGet, { params: { OID: oid } }).then((r) => r.data),
    // ошибки проверки - в ответе 400: { message, errors [путь поля: текст] }
    save: (model: ScenarioEditModel) => client.post<ScenarioRow>(ep.scenariosSave, model, { timeout: 120_000 }).then((r) => r.data),
    upload: (file: File) => {
        const form = new FormData();
        form.append("File", file);
        return client.post<string[]>(ep.scenariosUpload, form, { headers: { "Content-Type": "multipart/form-data" }, timeout: 120_000 })
            .then((r) => r.data);
    },
    remove: (oid: string) => client.delete(ep.scenarios, { params: { OID: oid } }),
    // запуск: запись в истории; ответ - OID запуска и режим
    run: (oid: string) => client.post<{ oid: string; mode: RunMode }>(ep.scenariosRun, { oid }, { timeout: 300_000 }).then((r) => r.data),
};

export const sourceFilesApi = {
    list: () => client.get<SourceFileRow[]>(ep.sourceFiles).then((r) => r.data),
    diplomLogs: () => client.get<DiplomLog[]>(ep.sourceFilesDiplomLogs).then((r) => r.data),
    importDiplomLog: (name: string) => client.post<SourceFileRow>(ep.sourceFilesImportDiplomLog, { name }).then((r) => r.data),
    upload: (file: File, kind: SourceKind) => {
        const form = new FormData();
        form.append("File", file);
        form.append("Kind", kind);
        return client.post<SourceFileRow>(ep.sourceFilesUpload, form, { headers: { "Content-Type": "multipart/form-data" } })
            .then((r) => r.data);
    },
    remove: (oid: string) => client.delete(ep.sourceFiles, { params: { OID: oid } }),
};

export const runsApi = {
    list: () => client.get<RunRow[]>(ep.runs).then((r) => r.data),
    create: (model: RunCreateModel) => client.post<RunRow>(ep.runs, model, { timeout: 300_000 }).then((r) => r.data),
    result: (oid: string) => client.get<RunResult>(ep.runResult, { params: { OID: oid } }).then((r) => r.data),
    // файл результата как есть: формат 2 (модели справочника) или старые форматы (helpers/runModels.ts)
    anyResult: (oid: string) => client.get<RunResult | RunResultV2 | CompareResult | RealtimeArchiveData>(ep.runResult, { params: { OID: oid } })
        .then((r) => r.data),
    remove: (oid: string) => client.delete(ep.runs, { params: { OID: oid } }),
    exportForecast: (oid: string) => client.get<Blob>(ep.runExportForecast, { params: { OID: oid }, responseType: "blob" }),
    radarFile: (oid: string, track: number) => client
        .get<{ fileName: string; text: string; radar: { lat: number; lon: number; alt: number } }>(ep.runRadarFile, { params: { OID: oid, Track: track } })
        .then((r) => r.data),
};

export const realtimeApi = {
    create: (model: RunCreateModel & { track?: number | null; speed: number }) =>
        client.post<RealtimeSessionInfo>(ep.realtime, model, { timeout: 120_000 }).then((r) => r.data),
    get: (oid: string) => client.get<RealtimeSessionInfo>(ep.realtimeGet, { params: { OID: oid } }).then((r) => r.data),
    play: (oid: string, speed?: number) => client.post<RealtimeState>(ep.realtimePlay, { oid, speed }).then((r) => r.data),
    pause: (oid: string) => client.post<RealtimeState>(ep.realtimePause, { oid }).then((r) => r.data),
    step: (oid: string) => client.post<RealtimeState>(ep.realtimeStep, { oid }).then((r) => r.data),
    seek: (oid: string, k: number) => client.post<RealtimeState>(ep.realtimeSeek, { oid, k }, { timeout: 120_000 }).then((r) => r.data),
    speed: (oid: string, speed: number) => client.post<RealtimeState>(ep.realtimeSpeed, { oid, speed }).then((r) => r.data),
    stop: (oid: string) => client.delete(ep.realtime, { params: { OID: oid } }),
    list: () => client.get<RealtimeSessionInfo[]>(ep.realtime).then((r) => r.data),
};

// имя файла из заголовка Content-Disposition ответа
export const fileNameFrom = (disposition: string | undefined, fallback: string): string => {
    const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition ?? "");
    if (star) return decodeURIComponent(star[1]);
    const plain = /filename="?([^";]+)"?/i.exec(disposition ?? "");
    return plain ? plain[1] : fallback;
};

export const saveBlob = (blob: Blob, fileName: string): void => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
};
