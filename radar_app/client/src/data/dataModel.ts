// ответы сервера (camelCase) и данные движка, которые сервер отдает как есть (snake_case): .agent_docs/ARCHITECTURE.md

export interface UserData {
    oid: string;
    userName: string;
    displayName: string;
    roles: string[];
}

export type SourceKind = "log" | "radar" | "track";
export type RunMode = "full" | "realtime" | "compare";
export type DopplerCase = "nodop" | "dopTraj" | "dopTele";

export interface SourceFileRow {
    oid: string;
    fileName: string;
    kind: SourceKind;
    size: number;
    created: string;
    fromDiplom: boolean;
    runCount: number;
}

// справочник полётов: лог диплома, траектория пакета прогона или загруженный файл (FlightsController)
export type FlightOrigin = "real" | "sim" | "manual" | "synth" | "aug";

export interface FlightRow {
    key: string;                  // имя лога диплома, OID загруженного файла или <прогон>/<id траектории>
    fileName: string;             // имя файла или id траектории
    kind: SourceKind;
    origin: FlightOrigin;
    aircraft: string | null;      // аппарат лога; у расширения - исходный лог
    rows: number | null;          // записей в логе; у траектории - точек
    pieces: number | null;        // кусков после очистки; 0 - запускать нечего
    durationS: number | null;     // суммарная длительность кусков, с
    splits: Record<string, string | null>; // выборка диплома по прогонам: train, val, test, excluded, sim, analysis
    run: string | null;           // прогон пакета траектории
    trackId: string | null;
    detail: string | null;        // сценарий генератора или вид расширения
    size: number;
    created: string | null;
    sourceFileOID: string | null;
    runCount: number;
    error: string | null;
}

// справочник моделей (ModelsController): пакет модели и вид прогноза по нему
export interface ModelRow {
    oid: string;
    name: string;
    note: string | null;
    bundle: string;               // <прогон>/<случай>... или «загружен»
    kind: ForecastKind;
    case: DopplerCase;
    label: string | null;
    members: number;
    seeds: string | null;         // seed сетей модели через запятую; нет - по умолчанию (первый или все)
    run: string | null;           // прогон диплома - вид входных данных обучения
    runTitle: string;             // прогон с пояснением: «merged_x1: реальные полёты и сгенерированные траектории ...»
    modelType: string;            // вид модели пакета: hybrid, e2e (сеть без IMM), classic (CV, KF), ensemble (жадный ансамбль)
    typeTitle: string;            // вид для таблицы: IMM, гибрид, сеть без IMM, фильтр Калмана, ...
    composition: string;          // состав из config.json пакета: фильтр, сеть, окно, seed, доплер
    window: number | null;
    fromDiplom: boolean;
    created: string;
    runCount: number;
}

export interface DiplomLog {
    name: string;
    size: number;
}

export interface RunRow {
    oid: string;
    created: string;
    sourceFileOID: string | null; // нет у запуска по траектории пакета
    fileName: string;             // имя файла или id траектории
    kind: SourceKind;
    trackRun: string | null;
    trackId: string | null;
    scenarioName: string | null;  // запуск по сценарию: наименование на момент запуска
    mode: RunMode;
    case: DopplerCase;
    ensemble: boolean;
    pd: number | null;
    radarLat: number | null;
    radarLon: number | null;
    radarAlt: number | null;
    model: string | null;
    modelOIDs: string[];   // модели справочника по порядку; у старых запусков пусто
    trackCount: number;
    scanCount: number;
    adeImm: number | null;     // нет, если IMM не выбран
    adeHyb: number | null;     // ADE первой модели не-IMM любого вида
    adeModel: string | null;   // её наименование; у старых запусков нет - гибрид случая
    durationMs: number;
}

// запуск по моделям справочника (одна или несколько) - прогон целиком (Runs) и реальное время (Realtime); полёт - файл или
// траектория пакета прогона
export interface RunCreateModel {
    sourceFileOID: string | null;
    trackRun: string | null;
    trackId: string | null;
    models: string[];
    pd: number;
    radarLat: number | null;
    radarLon: number | null;
    radarAlt: number;
}

// строб: радиусы по горизонтам 1..H, м; круг вокруг гибрида и круги вокруг трёх вариантов
export interface Gate {
    coverage: number;
    calibrated_on: string;
    horizon_s: number[];
    r_one: number[];
    r_multi: number[] | null;
}

export interface Phase {
    code: number;
    name: string; // straight, entry, turn, exit, slow
    title: string;
}

export interface EngineCase {
    case: string; // имя у движка: nodop, dop_traj, dop_tele
    model: string;
    label: string;
    corrector: string;
    window: number;
    members: number;
    doppler: boolean;
    has_variants: boolean;
    gate: Gate | null;
    response_ms: Record<string, number> | null;
    error?: string;
}

export interface EngineInfo {
    run: string;
    period_s: number;
    horizon: number;
    default_pd: number;
    phases: Phase[];
    cases: EngineCase[];
    ping_ms: number;
}

export type P3 = [number, number, number] | null; // ENU, м
export type P2 = [number, number] | null; // широта, долгота или e, n

export interface Track {
    name: string;
    flight_id: string;
    source: "log" | "radar" | "track";
    case: string;
    origin: [number, number, number] | null;
    radar_pos: [number, number, number];
    radar_ll: P2;
    t: number[];
    detected: boolean[];
    polar: P3[];
    vr: (number | null)[] | null;
    meas: P3[];
    meas_ll: P2[] | null;
    truth: P3[] | null;
    truth_ll: P2[] | null;
    phase: number[] | null;
    onsets: number[];
    geo_err_m: number | null;
}

export interface ErrorRow {
    ade: number | null;
    fde: number | null;
    n: number | null;
    straight: number | null;
    entry: number | null;
    turn: number | null;
    exit: number | null;
}

export interface TrackResult {
    case: string;
    ensemble: boolean;
    model: string;
    window: number;
    horizon: number;
    ks: number[];
    imm: P3[][];                  // (K, H)
    hyb: P3[][];
    imm_ll: P2[][] | null;
    hyb_ll: P2[][] | null;
    variants: P2[][][] | null;    // (K, 3, H), e и n
    variants_ll: P2[][][] | null;
    probs: (number | null)[][] | null; // (K, 3)
    imm_pos?: P3[] | null;        // (K) оценка фильтра IMM в момент обзора - от неё начинаются линии прогноза
    model_type?: string;          // вид модели пакета (hybrid, e2e, classic, ensemble); у старых запусков нет
    imm_pos_ll?: P2[] | null;
    gate: Gate | null;
    errors: { imm: ErrorRow; hyb: ErrorRow } | null;
    ade_by_horizon: { imm: (number | null)[]; hyb: (number | null)[] } | null;
    err: { imm: (number | null)[][]; hyb: (number | null)[][] } | null; // (K, H): ошибка прогноза из обзора k на горизонте h
    ms_total: number;
    ms_per_scan: number;
}

export interface RunResult {
    oid: string;
    case: string;
    ensemble: boolean;
    pd: number | null;
    info: { period_s: number; horizon: number; phases: Phase[] };
    tracks: Track[];
    results: TrackResult[];
}

// реальное время

export interface RealtimeState {
    sessionId: string;
    position: number;   // показанный обзор, -1 - еще ни одного
    computed: number;   // посчитано обзоров движком
    total: number;
    playing: boolean;
    speed: number;
    ended: boolean;
    stopped?: boolean;  // сессия закрыта
}

// метки времени звеньев, Unix мс: сервер взял отметку -> движок принял -> движок посчитал -> сервер отправил
export interface ScanStamps {
    plotMs: number;
    engineReceivedMs: number;
    engineDoneMs: number;
    sentMs?: number;
}

// ответ сессии движка на один обзор (как есть)
export interface EngineScan {
    k: number;
    imm: P3[] | null;      // (H)
    hyb: P3[] | null;
    imm_ll: P2[] | null;
    hyb_ll: P2[] | null;
    variants: P2[][] | null;    // (3, H)
    variants_ll: P2[][] | null;
    probs: (number | null)[] | null;
    err: { imm: (number | null)[]; hyb: (number | null)[] } | null;
    imm_pos?: P3 | null;
    imm_pos_ll?: P2 | null;
    ms: { wait: number; imm: number; net: number };
    received_ms: number;
    done_ms: number;
}

export interface ScanRecord {
    k: number;
    stamps: ScanStamps;
    result: EngineScan;                    // первая сессия движка
    results?: Record<string, EngineScan>; // все сессии движка по ключу
}

// событие Scan хаба
export interface ScanEvent {
    sessionId: string;
    k: number;
    replay: boolean;
    stamps: ScanStamps | null;
    result: EngineScan;
    results?: Record<string, EngineScan>;
    state: RealtimeState;
}

// модель запуска в файле результата и в сессии реального времени
export interface RunModelRef {
    oid: string;
    name: string;
    kind: ForecastKind;
    case: string;          // имя случая у движка
    label: string | null;
    run?: string;          // прогон целиком: ключ в runs
    ade?: number | null;
    session?: string;      // реальное время: ключ сессии движка
}

export interface EngineSummary {
    model: string;
    model_type?: string;
    window: number;
    has_variants: boolean;
    gate: Gate | null;
}

// файл результата прогона целиком (format 2): ответы движка по пакету и виду сети, по кускам
export interface RunResultV2 {
    oid: string;
    mode: "full";
    format: 2;
    pd: number | null;
    info: { period_s: number; horizon: number; phases: Phase[] };
    models: RunModelRef[];
    tracks: Track[];
    runs: Record<string, { bundle: string; single: TrackResult[] | null; ensemble: TrackResult[] | null }>;
}

export interface RealtimeSessionInfo {
    oid: string;
    fileName: string;
    case: DopplerCase;
    ensemble: boolean;
    pd: number | null;
    info: { period_s: number; horizon: number; phases: Phase[] };
    engine: EngineSummary;
    models?: RunModelRef[];                  // у старых запусков нет
    engines?: Record<string, EngineSummary>;
    maxSpeed?: number;
    state: RealtimeState;
    track?: Track;
    scans?: ScanRecord[];
}

// сохраненная сессия реального времени (файл результата запуска с Mode = Realtime)
export interface RealtimeArchiveData {
    oid: string;
    case: string;
    ensemble: boolean;
    pd: number | null;
    info: { period_s: number; horizon: number; phases: Phase[] };
    engine?: EngineSummary; // у старых сессий нет
    models?: RunModelRef[]; // у старых сессий нет
    engines?: Record<string, EngineSummary>;
    tracks: Track[];
    realtime: { scans: ScanRecord[] };
}

// сравнение моделей

// вид прогноза: IMM случая, гибрид (одна сеть), гибрид-ансамбль (среднее поправок всех seed)
export type ForecastKind = "imm" | "hyb" | "ens";

// сценарий (ScenariosController): готовый набор параметров запуска
export type FlightSource = "log" | "upload" | "track";

export interface ScenarioRow {
    oid: string;
    name: string;
    note: string | null;
    flightSource: FlightSource;
    logName: string | null;
    sourceFileOID: string | null;
    sourceFileName: string | null;
    sourceFileKind: SourceKind | null;
    trackRun: string | null;
    trackId: string | null;
    piece: number | null;
    mode: RunMode;
    speed: number | null;
    startScan: number | null;
    autoplay: boolean;
    pd: number | null;
    radarLat: number | null;
    radarLon: number | null;
    radarAlt: number | null;
    basemap: string | null;      // osm, yandex, plane; нет - как выбрал зритель
    horizons: string | null;     // секунды через запятую
    layers: string | null;       // plots, truth, phases, variants, gate через запятую
    focus: boolean | null;       // фокус на прогнозе
    follow: boolean | null;      // следить за целью
    modelOIDs: string[];
    models: string;
    runCount: number;
    created: string;
}

// сценарий формы: создание (oid нет) и правка
export interface ScenarioEditModel {
    oid: string | null;
    name: string;
    note: string | null;
    flightSource: FlightSource;
    logName: string | null;
    sourceFileOID: string | null;
    trackRun: string | null;
    trackId: string | null;
    piece: number | null;
    models: string[];
    mode: RunMode;
    speed: number | null;
    startScan: number | null;
    autoplay: boolean;
    pd: number | null;
    radarLat: number | null;
    radarLon: number | null;
    radarAlt: number | null;
    basemap: string | null;
    horizons: number[] | null;
    layers: string[] | null;
    focus: boolean | null;
    follow: boolean | null;
}

export interface CompareModelRef {
    id: string;       // <случай движка>/<вид>: dop_traj/hyb
    case: string;     // имя случая у движка: nodop, dop_traj, dop_tele
    kind: ForecastKind;
    model: string | null;
}

// файл результата сравнения (старый формат): ответы движка по случаю доплера и виду сети, по кускам
export interface CompareResult {
    oid: string;
    mode: "compare";
    pd: number | null;
    info: { period_s: number; horizon: number; phases: Phase[] };
    models: CompareModelRef[];
    tracks: Track[];
    runs: Record<string, { single: TrackResult[] | null; ensemble: TrackResult[] | null }>;
}
