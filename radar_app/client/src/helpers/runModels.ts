import type {
    CompareResult, EngineScan, EngineSummary, Phase, RealtimeArchiveData, RunModelRef, RunResult, RunResultV2, ScanRecord, Track,
} from "../data/dataModel";
import { engineCaseTitle } from "../data/enums";
import { modelColor, seriesColors } from "../theme/colors";
import { compareModels } from "./compareModels";
import type { CompareModel } from "./compareModels";
import { realtimeResult } from "./realtimeResult";

// модель запуска на карте, в таблицах и на графиках: ответы движка по кускам и поле прогноза в них (imm или hyb)
export type RunModel = CompareModel;

export interface FullRunData {
    tracks: Track[];
    info: { period_s: number; horizon: number; phases: Phase[] };
    pd: number | null;
    models: RunModel[];
}

type AnyResult = RunResult | RunResultV2 | CompareResult | RealtimeArchiveData;

const isV2 = (d: AnyResult): d is RunResultV2 => (d as RunResultV2).format === 2 && (d as RunResultV2).mode === "full";
const isCompare = (d: AnyResult): d is CompareResult => (d as CompareResult).mode === "compare";
export const isRealtimeData = (d: AnyResult): d is RealtimeArchiveData => "realtime" in d && !!(d as RealtimeArchiveData).realtime;

const fromRef = (m: RunModelRef, i: number, results: RunModel["results"]): RunModel => ({
    ref: { id: m.oid, case: m.case, kind: m.kind, model: m.label },
    label: m.name,
    short: m.name,
    color: modelColor(i),
    which: m.kind === "imm" ? "imm" : "hyb",
    results,
});

// прогон целиком любого формата: модели справочника (format 2), старые сравнение и одиночный прогон
export const fullRunData = (d: AnyResult): FullRunData => {
    if (isV2(d)) {
        const models = d.models.map((m, i) => {
            const entry = d.runs[m.run ?? ""];
            const results = (m.kind === "ens" || !entry?.single ? entry?.ensemble : entry.single) ?? [];
            return fromRef(m, i, results);
        });
        return { tracks: d.tracks, info: d.info, pd: d.pd, models };
    }

    if (isCompare(d)) return { tracks: d.tracks, info: d.info, pd: d.pd, models: compareModels(d) };

    // одиночный прогон до справочника моделей: IMM и гибрид из одного ответа
    const r = d as RunResult;
    const colors = seriesColors();
    const caseTitle = engineCaseTitle(r.case);
    const net = r.results[0]?.model ?? "гибрид";
    return {
        tracks: r.tracks, info: r.info, pd: r.pd,
        models: [
            { ref: { id: "imm", case: r.case, kind: "imm", model: null }, label: `IMM, ${caseTitle}`, short: `IMM, ${caseTitle}`,
                color: colors.imm, which: "imm", results: r.results },
            { ref: { id: "hyb", case: r.case, kind: r.ensemble ? "ens" : "hyb", model: net }, label: `${net}, ${caseTitle}`,
                short: `${net}, ${caseTitle}`, color: colors.hyb, which: "hyb", results: r.results },
        ],
    };
};

// реальное время: обзоры по k (запись обзора - ответ первой сессии движка и ответы всех сессий) -> модели с одним «куском»
export interface RealtimeModelsInput {
    models?: RunModelRef[];
    engines?: Record<string, EngineSummary>;
    engine?: EngineSummary;
    case?: string;
    ensemble?: boolean;
}

export type ScanSlot = Pick<ScanRecord, "result" | "results"> | undefined;

export const realtimeModels = (info: RealtimeModelsInput, scans: ScanSlot[], total: number, horizon: number): RunModel[] => {
    const engine = info.engine ?? { model: "", window: 0, has_variants: false, gate: null };

    if (info.models?.length) {
        return info.models.map((m, i) => {
            const key = m.session ?? "";
            const summary = info.engines?.[key] ?? engine;
            const own: (EngineScan | undefined)[] = scans.map((s) => (s ? s.results?.[key] ?? s.result : undefined));
            return fromRef(m, i, [realtimeResult(total, own, summary.model, summary.window, horizon, summary.gate, summary.model_type)]);
        });
    }

    // сессия до справочника моделей: одна сессия движка - IMM и гибрид
    const colors = seriesColors();
    const result = realtimeResult(total, scans.map((s) => s?.result), engine.model, engine.window, horizon, engine.gate);
    const caseTitle = engineCaseTitle(info.case ?? "");
    return [
        { ref: { id: "imm", case: info.case ?? "", kind: "imm", model: null }, label: `IMM, ${caseTitle}`, short: `IMM, ${caseTitle}`,
            color: colors.imm, which: "imm", results: [result] },
        { ref: { id: "hyb", case: info.case ?? "", kind: info.ensemble ? "ens" : "hyb", model: engine.model },
            label: `${engine.model || "гибрид"}, ${caseTitle}`, short: `${engine.model || "гибрид"}, ${caseTitle}`,
            color: colors.hyb, which: "hyb", results: [result] },
    ];
};
