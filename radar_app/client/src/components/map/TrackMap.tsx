import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Gate, Phase, Track, TrackResult } from "../../data/dataModel";
import { useElementSize } from "../../helpers/useElementSize";
import { phaseColor, seriesColors } from "../../theme/colors";
import { emptyScene, fitView, sceneExtent } from "./scene";
import type { MapView } from "./scene";
import { buildBaseScene, buildScanScene, trackCoords, trackExtent } from "./trackScene";
import type { MapMode, SceneSeries } from "./trackScene";
import type { MapSettings } from "./mapSettings";
import { KendoMapView } from "./KendoMapView";
import { YandexMapView } from "./YandexMapView";

// модели со своей оценкой положения (CV, KF, сеть без IMM): их линия прогноза не тянется к оценке IMM
const OWN_START = ["classic", "e2e"];

// модель на карте: прогноз IMM или гибрида из ответа движка, свой цвет; три варианта и строб - только у гибрида
export interface MapSeries {
    id: string;
    label: string;
    color: string;
    result: TrackResult;
    which: "imm" | "hyb";
    gate: Gate | null;
}

interface Props {
    track: Track;
    k: number;
    period: number;
    horizon: number;
    phases: Phase[];
    series: MapSeries[];
    settings: MapSettings;
    fitKey: number;       // изменился - подогнать вид под всю трассу («вся трасса»)
    backKey: number;      // изменился - вернуть вид, который был до «всей трассы»
}

// карта трассы: подложка (OpenStreetMap, Яндекс или плоскость в метрах вокруг РЛС), модели, слои, слежение и фокус.
// Управление - в боковой панели страницы (MapControls)
export default function TrackMap({ track, k, period, horizon, phases, series, settings, fitKey, backKey }: Props) {
    const hasGeo = track.origin != null;
    const mode: MapMode = hasGeo ? settings.mode : "plane";

    const boxRef = useRef<HTMLDivElement>(null);
    const { width, height } = useElementSize(boxRef);

    const colors = useMemo(() => seriesColors(), []);
    // трасса без прогнозов: от обзора не зависит - постоянная часть сцены и подгонка вида не пересчитываются
    const trackOnly = useMemo(() => trackCoords(track, null, mode), [track, mode]);

    const [view, setView] = useState<MapView>({ center: [0, 0], zoom: 12 });

    const plane = mode === "plane";
    const sized = width > 0 && height > 0;
    const latest = useRef({ track, trackOnly, width, height });
    latest.current = { track, trackOnly, width, height };

    // вид «вся трасса» держится, пока его не сменил пользователь (сдвиг, масштаб), слежение или фокус
    const fitted = useRef(false);

    const fit = useCallback(() => {
        const now = latest.current;
        if (now.width <= 0 || now.height <= 0) return;
        fitted.current = true;
        setView(fitView(trackExtent(now.track, now.trackOnly, plane), now.width, now.height));
    }, [plane]);

    // вид до «всей трассы»: запоминается до подгонки (эффект стоит раньше), возвращается по backKey. Фокус после возврата
    // подгонит вид сам, слежение возьмет возвращенный масштаб
    const viewRef = useRef(view);
    viewRef.current = view;
    const beforeFit = useRef<MapView | null>(null);

    useEffect(() => { beforeFit.current = null; }, [track, plane]);
    useEffect(() => { if (fitKey > 0) beforeFit.current = viewRef.current; }, [fitKey]);

    // подгонка под всю трассу: при смене трассы, переходе между картой и плоскостью (другие координаты) и по кнопке
    // «вся трасса». OpenStreetMap и Яндекс - одни координаты: вид при переключении остается
    useEffect(() => { if (sized) fit(); }, [fit, track, fitKey, sized]);

    // размер окна карты (панель справа, во весь экран): вид пользователя остается на месте, а «вся трасса» подгоняется заново
    useEffect(() => { if (fitted.current) fit(); }, [fit, width, height]);

    useEffect(() => {
        const back = beforeFit.current;
        if (backKey <= 0 || !back) return;

        fitted.current = false;
        setView(back);
    }, [backKey]);

    const onUserView = useCallback((next: MapView) => {
        fitted.current = false;
        setView(next);
    }, []);

    // слежение: центр - текущее положение цели, масштаб - как выбрал пользователь (в фокусе вид задает фокус).
    // Центр - истина, без нее - оценка фильтра первой модели: отметка с шумом измерения дергала бы карту на каждом обзоре
    const seriesRef = useRef(series);
    seriesRef.current = series;

    useEffect(() => {
        if (!settings.follow || settings.focus) return;
        const first = seriesRef.current[0];
        const p = trackOnly.truth(k) ?? (first ? trackCoords(track, first.result, mode).immPos(k) : null) ?? trackOnly.meas(k);
        if (!p) return;

        fitted.current = false;
        setView((prev) => ({ center: p, zoom: prev.zoom }));
    }, [k, settings.follow, settings.focus, track, trackOnly, mode]);

    // постоянная часть не пересчитывается на каждом обзоре: Kendo Map перерисует только слои текущего обзора
    const base = useMemo(() => buildBaseScene({ track, coords: trackOnly, mode, layers: settings.layers, phases, colors, focus: settings.focus }),
        [track, trackOnly, mode, settings.layers, phases, colors, settings.focus]);

    const sceneSeries = useMemo<SceneSeries[]>(() => series.map((s) => {
        const c = trackCoords(track, s.result, mode);
        const hyb = s.which === "hyb";
        return {
            color: s.color,
            width: hyb ? 3 : 2,
            dash: !hyb,
            point: hyb ? c.hyb : c.imm,
            start: c.immPos,
            fromStart: !hyb || !OWN_START.includes(s.result.model_type ?? ""),
            variant: hyb && s.result.variants ? c.variant : null,
            probs: hyb && s.result.probs ? (kk: number) => s.result.probs?.[kk] ?? null : null,
            gate: hyb ? s.gate?.r_one ?? null : null,
            gateMulti: hyb ? s.gate?.r_multi ?? null : null,
        };
    }), [series, track, mode]);

    const current = useMemo(() => buildScanScene({
        track, coords: trackOnly, k, layers: settings.layers, horizons: settings.horizons, colors, phases, focus: settings.focus, series: sceneSeries,
    }), [track, trackOnly, k, settings.layers, settings.horizons, colors, phases, settings.focus, sceneSeries]);

    // фокус на прогнозе: при включении вид подгоняется под все, что нарисовано для текущего обзора (прогнозы, строб,
    // хвост траектории); дальше центр следует за прогнозом только при смене обзора, а масштаб - как выбрал пользователь.
    // Галочки слоев, горизонты и модели вид не трогают: иначе карта скачет от каждого щелчка в панели
    const currentRef = useRef(current);
    currentRef.current = current;
    const focusFitted = useRef(false);
    useEffect(() => { focusFitted.current = false; }, [settings.focus, mode]);

    useEffect(() => {
        if (!settings.focus || width <= 0 || height <= 0) return;
        const points = sceneExtent(currentRef.current);
        if (points.length < 2) return;

        const focused = fitView(points, width, height);
        fitted.current = false;
        if (focusFitted.current) setView((prev) => ({ center: focused.center, zoom: prev.zoom }));
        else {
            focusFitted.current = true;
            setView(focused);
        }
    }, [settings.focus, k, track, mode, width, height]);

    const gate = series.find((s) => s.which === "hyb" && s.gate)?.gate ?? null;
    const legendPhases = phases.filter((p) => p.name === "entry" || p.name === "turn" || p.name === "exit");

    return (
        <div className="radar-map">
            <div ref={boxRef} className="radar-map__box">
                {width > 0 && (mode === "yandex"
                    ? <YandexMapView base={base} current={current} view={view} onViewChange={onUserView} />
                    : <KendoMapView key={`${mode}:${Math.round(width)}x${Math.round(height)}`} base={base} current={current} view={view}
                        tiles={mode === "osm"} onViewChange={onUserView} />)}
                {mode === "plane" && <div className="radar-map__note">плоскость вокруг РЛС, кольца через 1 км</div>}
            </div>

            <div className="radar-map__legend">
                {series.map((s) => (
                    <span key={s.id}><i className={s.which === "imm" ? "radar-map__dash" : undefined}
                        style={s.which === "imm" ? { borderColor: s.color } : { background: s.color }} />{s.label}</span>
                ))}
                {track.truth && <span><b style={{ background: colors.truth }} />истина в момент прогноза</span>}
                {track.truth && <span><i className="radar-map__dash" style={{ borderColor: colors.truth }} />истина через 2-{horizon * period} с</span>}
                {series.some((s) => s.result.imm_pos) &&<span><b className="radar-map__start" style={{ borderColor: colors.truth }} />начало прогноза - оценка фильтра</span>}
                <span><b style={{ background: colors.plots }} />отметки РЛС</span>
                <span><b style={{ background: colors.radar }} />РЛС</span>
                {track.truth && settings.layers.phases && legendPhases.map((p) => (
                    <span key={p.code}><i style={{ background: phaseColor(p.name, colors) }} />{p.title}</span>
                ))}
                {gate && settings.layers.gate && <span>строб - {Math.round(gate.coverage * 100)}% целей на выбранных горизонтах</span>}
            </div>
        </div>
    );
}

// карта без трассы: Россия на OpenStreetMap (страница нового запуска)
const RUSSIA: MapView = { center: [61, 95], zoom: 3 };

export function EmptyMap() {
    const boxRef = useRef<HTMLDivElement>(null);
    const { width, height } = useElementSize(boxRef);
    const [view, setView] = useState<MapView>(RUSSIA);
    const scene = useMemo(() => emptyScene(), []);

    return (
        <div className="radar-map">
            <div ref={boxRef} className="radar-map__box">
                {width > 0 && <KendoMapView key={`${Math.round(width)}x${Math.round(height)}`} base={scene} current={scene} view={view}
                    tiles onViewChange={setView} />}
            </div>
        </div>
    );
}
