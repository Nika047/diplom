import type { EngineScan, Gate, TrackResult } from "../data/dataModel";

// посчитанные обзоры реального времени -> TrackResult, как у прогона целиком: та же карта и та же сцена (trackScene).
// массивы по числу обзоров трассы, непосчитанные обзоры - пусто
export const realtimeResult = (total: number, scans: (EngineScan | undefined)[], model: string, window: number,
    horizon: number, gate: Gate | null, modelType?: string): TrackResult => {
    const imm: TrackResult["imm"] = new Array(total);
    const hyb: TrackResult["hyb"] = new Array(total);
    const immLl: NonNullable<TrackResult["imm_ll"]> = new Array(total);
    const hybLl: NonNullable<TrackResult["hyb_ll"]> = new Array(total);
    const variants: NonNullable<TrackResult["variants"]> = new Array(total);
    const variantsLl: NonNullable<TrackResult["variants_ll"]> = new Array(total);
    const probs: NonNullable<TrackResult["probs"]> = new Array(total);
    const immPos: NonNullable<TrackResult["imm_pos"]> = new Array(total);
    const immPosLl: NonNullable<TrackResult["imm_pos_ll"]> = new Array(total);
    const errImm: (number | null)[][] = new Array(total);
    const errHyb: (number | null)[][] = new Array(total);
    const ks: number[] = [];

    let geo = false;
    let anyVariants = false;
    let anyPos = false;

    scans.forEach((s, k) => {
        if (!s) return;
        if (s.hyb) ks.push(k);
        imm[k] = s.imm ?? [];
        hyb[k] = s.hyb ?? [];
        immLl[k] = s.imm_ll ?? [];
        hybLl[k] = s.hyb_ll ?? [];
        variants[k] = s.variants ?? [];
        variantsLl[k] = s.variants_ll ?? [];
        probs[k] = s.probs ?? [];
        immPos[k] = s.imm_pos ?? null;
        immPosLl[k] = s.imm_pos_ll ?? null;
        anyPos ||= s.imm_pos != null;
        errImm[k] = s.err?.imm ?? [];
        errHyb[k] = s.err?.hyb ?? [];
        geo ||= s.imm_ll != null;
        anyVariants ||= s.variants != null;
    });

    return {
        case: "", ensemble: false, model, model_type: modelType, window, horizon, ks,
        imm, hyb,
        imm_ll: geo ? immLl : null,
        hyb_ll: geo ? hybLl : null,
        variants: anyVariants ? variants : null,
        variants_ll: anyVariants && geo ? variantsLl : null,
        probs: anyVariants ? probs : null,
        imm_pos: anyPos ? immPos : null,
        imm_pos_ll: anyPos && geo ? immPosLl : null,
        gate,
        errors: null,
        ade_by_horizon: null,
        err: { imm: errImm, hyb: errHyb },
        ms_total: 0,
        ms_per_scan: 0,
    };
};
