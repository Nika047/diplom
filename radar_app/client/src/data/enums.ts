import type { DopplerCase, FlightOrigin, FlightSource, ForecastKind, RunMode, SourceKind } from "./dataModel";

// значения - как отдает сервер (имя члена перечисления в camelCase), подписи - из Description на сервере
export interface EnumOption<T extends string> {
    value: T;
    text: string;
}

export const dopplerCaseOptions: EnumOption<DopplerCase>[] = [
    { value: "nodop", text: "без доплера" },
    { value: "dopTraj", text: "доплер по траектории" },
    { value: "dopTele", text: "доплер по телеметрии" },
];

// имя случая у движка (/info, файл результата)
export const engineCaseName: Record<DopplerCase, string> = {
    nodop: "nodop",
    dopTraj: "dop_traj",
    dopTele: "dop_tele",
};

export const sourceKindOptions: EnumOption<SourceKind>[] = [
    { value: "log", text: "лог полёта" },
    { value: "radar", text: "отметки РЛС" },
    { value: "track", text: "траектория" },
];

export const flightSourceOptions: EnumOption<FlightSource>[] = [
    { value: "log", text: "лог диплома" },
    { value: "upload", text: "загруженный файл" },
    { value: "track", text: "траектория пакета" },
];

export const flightOriginOptions: EnumOption<FlightOrigin>[] = [
    { value: "real", text: "реальный" },
    { value: "sim", text: "симулятор" },
    { value: "manual", text: "добавлен вручную" },
    { value: "synth", text: "сгенерирована" },
    { value: "aug", text: "расширение" },
];

// выборки разбиения логов диплома (этап 0)
export const splitTitle: Record<string, string> = {
    train: "обучение",
    val: "валидация",
    test: "тест",
    excluded: "исключён",
    sim: "симулятор, вне выборок",
    analysis: "анализ (вне обучения)",
};

// подложка карты (сценарий, MapSettings.mode)
export const basemapTitle: Record<string, string> = {
    osm: "OpenStreetMap",
    yandex: "Яндекс",
    plane: "плоскость",
};

// слои карты (сценарий, SceneLayers)
export const layerTitle: Record<string, string> = {
    plots: "отметки РЛС",
    truth: "истина (GPS)",
    phases: "участки",
    variants: "три варианта",
    gate: "строб",
};

export const runModeOptions: EnumOption<RunMode>[] = [
    { value: "full", text: "прогон целиком" },
    { value: "realtime", text: "реальное время" },
    { value: "compare", text: "сравнение моделей" },
];

export const forecastKindOptions: EnumOption<ForecastKind>[] = [
    { value: "imm", text: "IMM" },
    { value: "hyb", text: "гибрид" },
    { value: "ens", text: "ансамбль" },
];

// подпись случая по имени у движка (nodop, dop_traj, dop_tele)
export const engineCaseTitle = (name: string): string =>
    optionText(dopplerCaseOptions, (Object.keys(engineCaseName) as DopplerCase[]).find((c) => engineCaseName[c] === name)) || name;

export const optionText = <T extends string>(options: EnumOption<T>[], value: T | null | undefined): string =>
    options.find((o) => o.value === value)?.text ?? (value ?? "");
