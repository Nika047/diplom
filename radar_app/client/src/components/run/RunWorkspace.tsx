import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Button, ButtonGroup } from "@progress/kendo-react-buttons";
import { Checkbox } from "@progress/kendo-react-inputs";
import { chevronDoubleLeftIcon, chevronDoubleRightIcon, fullscreenExitIcon, fullscreenIcon } from "@progress/kendo-svg-icons";

import type { ErrorRow, Phase, Track } from "../../data/dataModel";
import { fmt, fmtChange } from "../../helpers/format";
import { modelGate } from "../../helpers/compareModels";
import type { RunModel } from "../../helpers/runModels";
import TrackMap from "../map/TrackMap";
import type { MapSeries } from "../map/TrackMap";
import MapControls from "../map/MapControls";
import { useMapSettings } from "../map/mapSettings";
import { CompareHorizonChart, CompareTimeChart } from "../CompareCharts";

// раскладка страницы запуска: слева - заголовок, плеер, карта и то, что под ней; справа - боковая панель (сворачивается)
export function RunLayout({ aside, children }: { aside: ReactNode; children: ReactNode }) {
    const [collapsed, setCollapsed] = useState(false);

    return (
        <div className={collapsed ? "radar-runpage radar-runpage--collapsed" : "radar-runpage"}>
            <div className="radar-runpage__main">{children}</div>
            <aside className="radar-runpage__side">
                <Button className="radar-runpage__toggle" fillMode="flat" svgIcon={collapsed ? chevronDoubleLeftIcon : chevronDoubleRightIcon}
                    title={collapsed ? "Показать панель" : "Свернуть панель"} onClick={() => setCollapsed(!collapsed)} />
                {!collapsed && <div className="radar-runpage__panel">{aside}</div>}
            </aside>
        </div>
    );
}

const COLUMNS: { key: keyof ErrorRow; title: string }[] = [
    { key: "ade", title: "ADE" },
    { key: "fde", title: "FDE" },
    { key: "straight", title: "прямая" },
    { key: "entry", title: "вход" },
    { key: "turn", title: "маневр" },
    { key: "exit", title: "выход" },
];

interface Props {
    form: ReactNode;            // параметры запуска - верх боковой панели
    head: ReactNode;            // заголовок, сведения и кнопки запуска
    player: ReactNode;          // строка плеера над картой
    bottom?: ReactNode;         // под таблицами и графиками (панель задержек)
    track: Track;
    trackIdx: number;           // кусок у ответов моделей (у реального времени - 0)
    k: number;
    period: number;
    horizon: number;
    phases: Phase[];
    models: RunModel[];
    pieceErrors: boolean;       // таблица ошибок по куску и график по горизонтам (у прогона целиком)
    chartMarker: boolean;       // отметка текущего обзора на графике (не при проигрывании: график перерисовывается долго)
    onScan: (k: number) => void;
}

// общее у прогона целиком и реального времени: модели на карте (свой цвет у каждой), слои и вид в боковой панели,
// ошибки из текущего обзора и по куску, графики
export default function RunWorkspace({ form, head, player, bottom, track, trackIdx, k, period, horizon, phases, models, pieceErrors, chartMarker, onScan }: Props) {
    const { settings, update } = useMapSettings(horizon);
    const [hidden, setHidden] = useState<Set<string>>(new Set());
    const [fitKey, setFitKey] = useState(0);
    const [backKey, setBackKey] = useState(0);
    const [whole, setWhole] = useState(false);
    const [full, setFull] = useState(false);
    const [chartH, setChartH] = useState(horizon - 1);

    const visible = useMemo(() => models.filter((m) => !hidden.has(m.ref.id)), [models, hidden]);

    // график ошибки во времени перерисовывается целиком (сотни мс при нескольких моделях): при проигрывании он держит
    // последний снимок моделей, а на паузе обновляется - в реальном времени модели пересобираются на каждом обзоре
    const chartModels = useRef(visible);
    if (chartMarker) chartModels.current = visible;

    const series = useMemo<MapSeries[]>(() => visible
        .filter((m) => m.results[trackIdx])
        .map((m) => ({ id: m.ref.id, label: m.label, color: m.color, result: m.results[trackIdx], which: m.which, gate: modelGate(m, trackIdx) })),
    [visible, trackIdx]);

    const toggle = (id: string) => setHidden((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
    });

    // во весь экран: плеер и карта - слоем поверх страницы, а сама страница - на весь экран (как F11). Запрет браузера
    // не мешает: слой остается на все окно. Выход - кнопка, Esc или выход браузера из полного экрана
    const enterFull = useCallback(() => {
        setFull(true);
        document.documentElement.requestFullscreen?.().catch(() => { });
    }, []);

    // «вся трасса» - переключатель: включение запоминает фокус и слежение и выключает их, выключение возвращает их и
    // прежний вид карты. Галочка фокуса или слежения, поставленная вручную, тоже выключает «всю трассу»
    const beforeWhole = useRef({ follow: false, focus: false });
    const wholeOn = whole && !settings.follow && !settings.focus;

    const toggleWhole = () => {
        if (wholeOn) {
            setWhole(false);
            setBackKey((x) => x + 1);
            update(beforeWhole.current);
            return;
        }

        beforeWhole.current = { follow: settings.follow, focus: settings.focus };
        setWhole(true);
        update({ follow: false, focus: false });
        setFitKey((x) => x + 1);
    };

    const exitFull = useCallback(() => {
        setFull(false);
        if (document.fullscreenElement) document.exitFullscreen().catch(() => { });
    }, []);

    useEffect(() => {
        if (!full) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") exitFull(); };
        const onChange = () => { if (!document.fullscreenElement) setFull(false); };
        window.addEventListener("keydown", onKey);
        document.addEventListener("fullscreenchange", onChange);
        return () => {
            window.removeEventListener("keydown", onKey);
            document.removeEventListener("fullscreenchange", onChange);
        };
    }, [full, exitFull]);

    // уход со страницы запуска в полном экране
    useEffect(() => () => { if (document.fullscreenElement) document.exitFullscreen().catch(() => { }); }, []);

    const hasTruth = !!track.truth;
    const hasErr = models.some((m) => m.results[trackIdx]?.err);
    const hasVariants = models.some((m) => m.which === "hyb" && m.results[trackIdx]?.variants);
    const hasGate = models.some((m) => m.which === "hyb" && m.results[trackIdx]?.gate);
    const immOf = (m: RunModel) => models.find((x) => x.which === "imm" && x.ref.case === m.ref.case);

    const aside = (
        <>
            {form}

            <section className="radar-side__block">
                <div className="radar-row">
                    <h4>Модели на карте</h4>
                    <Button fillMode="flat" size="small" onClick={() => setHidden(new Set())}>все</Button>
                    <Button fillMode="flat" size="small" onClick={() => setHidden(new Set(models.map((m) => m.ref.id)))}>ни одной</Button>
                </div>
                <div className="radar-side__checks">
                    {models.map((m) => (
                        <label key={m.ref.id} className="radar-compare__model" title={m.ref.model ?? undefined}>
                            <Checkbox checked={!hidden.has(m.ref.id)} onChange={() => toggle(m.ref.id)} />
                            <i className={m.which === "imm" ? "radar-compare__swatch radar-compare__swatch--dash" : "radar-compare__swatch"}
                                style={m.which === "imm" ? { borderColor: m.color } : { background: m.color }} />
                            <span>{m.label}</span>
                        </label>
                    ))}
                </div>
            </section>

            <MapControls settings={settings} update={update} period={period} hasGeo={track.origin != null} hasTruth={hasTruth}
                hasVariants={hasVariants} hasGate={hasGate} whole={wholeOn} onWhole={toggleWhole} />
        </>
    );

    return (
        <RunLayout aside={aside}>
            {head}

            <div className={full ? "radar-stage radar-stage--full" : "radar-stage"}>
                <div className="radar-stage__bar">
                    {player}
                    <Button className="radar-stage__full" svgIcon={full ? fullscreenExitIcon : fullscreenIcon}
                        title={full ? "Свернуть (Esc)" : "Плеер и карта во весь экран; выход - Esc"}
                        onClick={full ? exitFull : enterFull}>{full ? "свернуть" : undefined}</Button>
                </div>

                <div className="radar-runpage__map">
                    <TrackMap track={track} k={k} period={period} horizon={horizon} phases={phases} series={series} settings={settings}
                        fitKey={fitKey} backKey={backKey} />
                </div>
            </div>

            <section className="radar-card">
                <h4>Ошибка прогноза из этого обзора, м</h4>
                {!hasErr ? <div className="radar-hint">Истины нет (файл отметок РЛС) - ошибки не считаются.</div> : (
                    <table className="radar-table radar-table--compact">
                        <thead>
                            <tr><th>модель</th>{Array.from({ length: horizon }, (_, h) => <th key={h}>через {(h + 1) * period} с</th>)}</tr>
                        </thead>
                        <tbody>
                            {visible.map((m) => (
                                <tr key={m.ref.id}>
                                    <td><i className="radar-latency__swatch" style={{ background: m.color }} />{m.label}</td>
                                    {Array.from({ length: horizon }, (_, h) => <td key={h}>{fmt(m.results[trackIdx]?.err?.[m.which][k]?.[h])}</td>)}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </section>

            {pieceErrors && hasErr && (
                <section className="radar-card">
                    <h4>Ошибки прогноза по куску, все горизонты 2-{horizon * period} с, м</h4>
                    <table className="radar-table">
                        <thead>
                            <tr>
                                <th>модель</th>
                                {COLUMNS.map((c) => <th key={c.key}>{c.title}</th>)}
                                <th>пар</th><th>ADE к IMM</th><th>мс на обзор</th>
                            </tr>
                        </thead>
                        <tbody>
                            {models.map((m) => {
                                const own = m.results[trackIdx]?.errors?.[m.which] ?? null;
                                // IMM того же случая доплера; не выбран - IMM из ответа самой модели (он считается всегда)
                                const immAde = (immOf(m) ?? m).results[trackIdx]?.errors?.imm?.ade;
                                return (
                                    <tr key={m.ref.id} className={hidden.has(m.ref.id) ? "radar-compare__hidden" : undefined}>
                                        <td><i className="radar-latency__swatch" style={{ background: m.color }} />{m.label}</td>
                                        {COLUMNS.map((c) => <td key={c.key}>{fmt(own?.[c.key])}</td>)}
                                        <td>{own?.n ?? "-"}</td>
                                        <td>{m.which === "imm" ? "-" : fmtChange(immAde, own?.ade)}</td>
                                        <td>{m.which === "imm" ? "-" : fmt(m.results[trackIdx]?.ms_per_scan, 3)}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                    <div className="radar-hint">ADE - средняя ошибка по горизонтали на всех горизонтах, FDE - на последнем; прямая, вход,
                        маневр, выход - ADE на участках траектории. «ADE к IMM» - изменение ADE модели к IMM того же случая доплера
                        (минус - точнее IMM). «мс на обзор» - прогон куска целиком в движке. Строки скрытых моделей - бледнее.</div>
                </section>
            )}

            {hasErr && (
                <div className={pieceErrors ? "radar-run__charts" : undefined}>
                    <div className="radar-card">
                        <div className="radar-row">
                            <span>Ошибка во времени, горизонт:</span>
                            <ButtonGroup>
                                {Array.from({ length: horizon }, (_, h) => (
                                    <Button key={h} togglable selected={chartH === h} onClick={() => setChartH(h)}>{(h + 1) * period} с</Button>
                                ))}
                            </ButtonGroup>
                            <span className="radar-hint">щелчок по графику - перейти к обзору</span>
                        </div>
                        <CompareTimeChart models={chartModels.current} trackIdx={trackIdx} track={track} phases={phases} h={chartH}
                            period={period} k={chartMarker ? k : null} onScan={onScan} />
                    </div>
                    {pieceErrors && (
                        <div className="radar-card">
                            <CompareHorizonChart models={visible} trackIdx={trackIdx} period={period} horizon={horizon} />
                        </div>
                    )}
                </div>
            )}

            {bottom}
        </RunLayout>
    );
}
