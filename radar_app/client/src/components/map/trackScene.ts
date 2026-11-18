// сцена трассы: постоянная часть (buildBaseScene) и обзор k (buildScanScene) - отметки, истина, прогнозы моделей, три варианта и
// строб - из трассы и ответов движка как есть
import type { P2, P3, Phase, Track, TrackResult } from "../../data/dataModel";
import type { SeriesColors } from "../../theme/colors";
import { phaseColor } from "../../theme/colors";
import { emptyScene, planeLatLon } from "./scene";
import type { LatLon, Scene } from "./scene";

export type MapMode = "osm" | "yandex" | "plane";

// слои карты; прогнозы моделей включаются выбором моделей на странице запуска
export interface SceneLayers {
    plots: boolean;
    truth: boolean;
    phases: boolean;
    variants: boolean;
    gate: boolean;
}

export const defaultLayers: SceneLayers = {
    plots: true,
    truth: true,
    phases: true,
    variants: false,
    gate: true,
};

// сколько прошлых отметок показывать
const PLOTS_TAIL = 30;

// фокус на прогнозе: сколько обзоров траектории до текущего показывать (30 с)
export const FOCUS_TAIL = 15;

// шаг колец дальности на плоскости, м
const RING_STEP_M = 1000;

// координаты трассы в выбранной подложке: на карте - широта и долгота от движка, на плоскости - метры от РЛС
export interface TrackCoords {
    meas: (k: number) => LatLon | null;
    truth: (k: number) => LatLon | null;
    imm: (k: number, h: number) => LatLon | null;
    hyb: (k: number, h: number) => LatLon | null;
    variant: (k: number, v: number, h: number) => LatLon | null;
    immPos: (k: number) => LatLon | null; // оценка фильтра IMM в момент обзора
    radar: () => LatLon | null;
}

const ll = (p: P2 | undefined): LatLon | null => (p ? [p[0], p[1]] : null);

export const trackCoords = (track: Track, result: TrackResult | null, mode: MapMode): TrackCoords => {
    if (mode !== "plane") {
        return {
            meas: (k) => ll(track.meas_ll?.[k]),
            truth: (k) => ll(track.truth_ll?.[k]),
            imm: (k, h) => ll(result?.imm_ll?.[k]?.[h]),
            hyb: (k, h) => ll(result?.hyb_ll?.[k]?.[h]),
            variant: (k, v, h) => ll(result?.variants_ll?.[k]?.[v]?.[h]),
            immPos: (k) => ll(result?.imm_pos_ll?.[k] ?? undefined),
            radar: () => ll(track.radar_ll ?? undefined),
        };
    }

    const [re, rn] = track.radar_pos;
    const rel = (p: P3 | P2 | undefined): LatLon | null => (p ? planeLatLon(p[0] - re, p[1] - rn) : null);

    return {
        meas: (k) => rel(track.meas[k]),
        truth: (k) => rel(track.truth?.[k]),
        imm: (k, h) => rel(result?.imm[k]?.[h]),
        hyb: (k, h) => rel(result?.hyb[k]?.[h]),
        variant: (k, v, h) => rel(result?.variants?.[k]?.[v]?.[h]),
        immPos: (k) => rel(result?.imm_pos?.[k] ?? undefined),
        radar: () => planeLatLon(0, 0),
    };
};

// все точки трассы - для подгонки масштаба. На плоскости центр - РЛС (начало координат): к точкам добавляются отражённые
// через РЛС, и трасса целиком помещается в окно вокруг неё
export const trackExtent = (track: Track, coords: TrackCoords, plane: boolean): LatLon[] => {
    const points: LatLon[] = [];

    for (let k = 0; k < track.t.length; k++) {
        const p = coords.truth(k) ?? coords.meas(k);
        if (p) points.push(p);
    }

    if (!plane) return points;

    const radar = coords.radar() ?? [0, 0];
    return [...points, ...points.map((p): LatLon => [2 * radar[0] - p[0], 2 * radar[1] - p[1]]), radar];
};

export interface BaseSceneInput {
    track: Track;
    coords: TrackCoords;
    mode: MapMode;
    layers: SceneLayers;
    phases: Phase[];
    colors: SeriesColors;
    focus: boolean; // фокус на прогнозе: вся траектория не рисуется, ее хвост - в сцене обзора
}

// ряд прогноза одной модели: точка горизонта h из обзора k, начало линии (оценка фильтра), стиль линии, три варианта и
// радиусы строба по горизонтам
export interface SceneSeries {
    color: string;
    width: number;
    dash?: boolean;
    point: (k: number, h: number) => LatLon | null;
    start: (k: number) => LatLon | null;
    fromStart: boolean; // false - у модели своя оценка положения (CV, KF, сеть без IMM): линия с первой точки прогноза
    variant?: ((k: number, v: number, h: number) => LatLon | null) | null;
    probs?: ((k: number) => (number | null)[] | null) | null;
    gate?: number[] | null;
    gateMulti?: number[] | null;
}

export interface ScanSceneInput {
    track: Track;
    coords: TrackCoords;
    k: number;
    layers: SceneLayers;
    horizons: boolean[]; // какие горизонты 1..H отмечать точками и стробом
    colors: SeriesColors;
    phases: Phase[];
    focus: boolean; // фокус на прогнозе: траектория и отметки - только последние FOCUS_TAIL обзоров
    series: SceneSeries[];
}

// истина обзоров from..to-1: с участками - куски своим цветом, без них - бледная линия
const drawTruth = (scene: Scene, track: Track, coords: TrackCoords, layers: SceneLayers, phases: Phase[], colors: SeriesColors,
    from: number, to: number) => {
    if (!layers.truth || !track.truth) return;

    const names = new Map(phases.map((p) => [p.code, p.name]));
    let segment: LatLon[] = [];
    let segmentPhase = layers.phases ? track.phase?.[from] ?? 0 : 0;

    const flush = () => {
        if (segment.length > 1) {
            const color = layers.phases ? phaseColor(names.get(segmentPhase) ?? "straight", colors) : colors.truth;
            scene.lines.push({ points: segment, color, width: layers.phases ? 2 : 1, opacity: layers.phases ? 0.75 : 0.35 });
        }
    };

    for (let i = from; i < to; i++) {
        const p = coords.truth(i);
        const phase = layers.phases ? track.phase?.[i] ?? 0 : 0;
        if (!p) continue;
        if (phase !== segmentPhase) {
            segment.push(p);
            flush();
            segment = [];
            segmentPhase = phase;
        }
        segment.push(p);
    }
    flush();
};

// постоянная часть сцены (от обзора не зависит): РЛС, кольца дальности на плоскости, вся истина по участкам
export const buildBaseScene = ({ track, coords, mode, layers, phases, colors, focus }: BaseSceneInput): Scene => {
    const scene = emptyScene();
    const total = track.t.length;

    // РЛС и кольца дальности на плоскости
    const radar = coords.radar();
    if (radar && mode === "plane") {
        let maxRange = 0;
        for (let i = 0; i < total; i++) {
            const p = track.meas[i] ?? track.truth?.[i];
            if (p) maxRange = Math.max(maxRange, Math.hypot(p[0] - track.radar_pos[0], p[1] - track.radar_pos[1]));
        }
        for (let r = RING_STEP_M; r <= maxRange + RING_STEP_M; r += RING_STEP_M) {
            scene.circles.push({ center: radar, radius: r, color: colors.grid, width: 1 });
        }
        scene.lines.push({ points: [planeLatLon(0, -maxRange - RING_STEP_M), planeLatLon(0, maxRange + RING_STEP_M)], color: colors.grid, width: 1 });
        scene.lines.push({ points: [planeLatLon(-maxRange - RING_STEP_M, 0), planeLatLon(maxRange + RING_STEP_M, 0)], color: colors.grid, width: 1 });
    }
    if (radar) scene.dots.push({ at: radar, radius: 6, color: colors.radar, stroke: colors.truth });

    if (!focus) drawTruth(scene, track, coords, layers, phases, colors, 0, total);

    return scene;
};

// часть сцены обзора k: истина сейчас и через 2-10 с, отметки, прогнозы моделей, три варианта, строб
export const buildScanScene = ({ track, coords, k, layers, horizons, colors, phases, focus, series }: ScanSceneInput): Scene => {
    const scene = emptyScene();
    const total = track.t.length;
    const H = horizons.length;
    const shown = (h: number) => horizons[h];
    const tail = focus ? FOCUS_TAIL : PLOTS_TAIL;

    if (focus) drawTruth(scene, track, coords, layers, phases, colors, Math.max(0, k - FOCUS_TAIL), k + 1);

    if (layers.truth && track.truth) {
        // истина через 2-10 с - с чем сравнивается прогноз
        const future: LatLon[] = [];
        for (let h = 0; h <= H && k + h < total; h++) {
            const p = coords.truth(k + h);
            if (p) future.push(p);
            if (p && h > 0 && shown(h - 1)) scene.dots.push({ at: p, radius: 3, color: colors.truth });
        }
        if (future.length > 1) scene.lines.push({ points: future, color: colors.truth, width: 2, dash: true });
    }

    // отметки: хвост и текущая (с шумом измерения - поэтому не совпадает с истиной и с оценкой фильтра)
    if (layers.plots) {
        for (let i = Math.max(0, k - tail); i < k; i++) {
            const p = coords.meas(i);
            if (p) scene.dots.push({ at: p, radius: 2.5, color: colors.plots, opacity: 0.4 + 0.6 * (i - k + tail) / tail });
        }
        const current = coords.meas(k);
        if (current) scene.dots.push({ at: current, radius: 4.5, color: colors.plots, stroke: colors.truth });
    }

    // истинное положение сейчас
    const now = layers.truth ? coords.truth(k) : null;
    if (now) scene.dots.push({ at: now, radius: 4, color: colors.truth });

    // последняя полученная отметка (при пропуске обнаружения - более ранняя)
    let lastMark: LatLon | null = null;
    for (let i = k; i >= Math.max(0, k - tail) && !lastMark; i--) lastMark = coords.meas(i);

    // линия прогноза - от оценки фильтра IMM в момент обзора (точка с обводкой); без неё - от
    // последней отметки, чтобы между отметкой и прогнозом не было разрыва. У CV, KF и сети без IMM своя оценка положения,
    // кода диплома для неё нет: их линия идёт с первой точки прогноза, иначе в начале излом к оценке IMM
    const forecastLine = (start: LatLon | null, fromStart: boolean, point: (h: number) => LatLon | null, color: string, width: number,
        dash = false, opacity = 1) => {
        const origin = fromStart ? start ?? lastMark : null;
        const points: LatLon[] = origin ? [origin] : [];
        for (let h = 0; h < H; h++) {
            const p = point(h);
            if (!p) continue;
            points.push(p);
            if (shown(h)) scene.dots.push({ at: p, radius: width + 1.5, color, opacity });
        }
        if (points.length > 1) scene.lines.push({ points, color, width, dash, opacity });
        if (start && fromStart) scene.dots.push({ at: start, radius: width + 1, color, stroke: colors.truth });
    };

    for (const s of series) {
        const start = s.start(k);

        // три варианта: прозрачность - по вероятности варианта
        const probs = s.probs?.(k);
        if (layers.variants && s.variant && probs) {
            for (let v = 0; v < 3; v++) {
                forecastLine(start, s.fromStart, (h) => s.variant!(k, v, h), s.color, 1.5, true, 0.25 + 0.6 * (probs[v] ?? 0));
            }
        }

        forecastLine(start, s.fromStart, (h) => s.point(k, h), s.color, s.width, s.dash);

        if (!layers.gate || !s.gate) continue;
        for (let h = 0; h < H; h++) {
            const center = shown(h) ? s.point(k, h) : null;
            if (center) scene.circles.push({ center, radius: s.gate[h], color: s.color, width: 1, dash: true, fillOpacity: 0.04 });
            if (shown(h) && layers.variants && s.variant && s.gateMulti && probs) {
                for (let v = 0; v < 3; v++) {
                    const c = s.variant(k, v, h);
                    if (c) scene.circles.push({ center: c, radius: s.gateMulti[h], color: s.color, width: 1, dash: true });
                }
            }
        }
    }

    return scene;
};
