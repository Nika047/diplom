import type { CompareModelRef, CompareResult, Gate, TrackResult } from "../data/dataModel";
import { engineCaseTitle, forecastKindOptions, optionText } from "../data/enums";
import { modelColor } from "../theme/colors";

// модель сравнения: ответы движка по кускам и поле прогноза в них (imm или hyb); цвет - по месту в списке моделей
export interface CompareModel {
    ref: CompareModelRef;
    label: string;
    short: string; // для узких таблиц
    color: string;
    which: "imm" | "hyb";
    results: TrackResult[];
}

// порядок и цвета фиксированы: случай доплера, затем вид прогноза
const CASE_ORDER = ["nodop", "dop_traj", "dop_tele"];
const KIND_ORDER = ["imm", "hyb", "ens"];
const CASE_SHORT: Record<string, string> = { nodop: "без доп.", dop_traj: "доп. траект.", dop_tele: "доп. телем." };

export const compareModels = (data: CompareResult): CompareModel[] => [...data.models]
    .sort((a, b) => (CASE_ORDER.indexOf(a.case) - CASE_ORDER.indexOf(b.case)) || (KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)))
    .map((ref) => {
        const run = data.runs[ref.case];
        // IMM есть в любом ответе; ансамбль - только в ответе ансамбля
        const results = (ref.kind === "ens" || !run.single ? run.ensemble : run.single) ?? [];
        return {
            ref,
            label: `${optionText(forecastKindOptions, ref.kind)}, ${engineCaseTitle(ref.case)}`,
            short: `${optionText(forecastKindOptions, ref.kind)}, ${CASE_SHORT[ref.case] ?? ref.case}`,
            color: modelColor(CASE_ORDER.indexOf(ref.case) * 3 + KIND_ORDER.indexOf(ref.kind)),
            which: ref.kind === "imm" ? "imm" : "hyb",
            results,
        };
    });

// строб модели на куске: радиусы гибрида; у IMM строба нет
export const modelGate = (m: CompareModel, trackIdx: number): Gate | null =>
    m.which === "hyb" ? m.results[trackIdx]?.gate ?? null : null;
