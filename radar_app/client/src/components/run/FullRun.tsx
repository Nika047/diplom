import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";

import { Button, ButtonGroup } from "@progress/kendo-react-buttons";
import { DropDownList } from "@progress/kendo-react-dropdowns";
import { Slider } from "@progress/kendo-react-inputs";
import { caretAltLeftIcon, caretAltRightIcon, downloadIcon, pauseIcon, playIcon } from "@progress/kendo-svg-icons";

import type { RunRow, Track } from "../../data/dataModel";
import { runsApi, saveBlob } from "../../services/api";
import { getApiErrorMessage } from "../../helpers/apiError";
import { fmt, fmtDateTime } from "../../helpers/format";
import type { FullRunData } from "../../helpers/runModels";
import RunWorkspace from "./RunWorkspace";

export const SPEEDS = [1, 2, 5, 10, 25, 50];

// состояние плеера: обзор, кусок, участок, пропуск отметки
export const scanState = (track: Track, k: number, phases: FullRunData["info"]["phases"]) =>
    `обзор ${k + 1} из ${track.t.length}, t = ${fmt(track.t[k] - track.t[0], 0)} с`
    + (track.phase ? `, ${phases.find((p) => p.code === track.phase![k])?.title ?? ""}` : "")
    + (track.detected[k] ? "" : ", пропуск отметки");

interface Props {
    run: RunRow | null;
    data: FullRunData;
    form: ReactNode;
    piece?: number | null; // кусок, на котором открыть (сценарий); нет - самый длинный
}

// прогон целиком: плеер в браузере по посчитанным прогнозам, все модели запуска на одной трассе, экспорт
export default function FullRun({ run, data, form, piece }: Props) {
    const longest = data.tracks.reduce((best, t, i) => (t.t.length > data.tracks[best].t.length ? i : best), 0);
    const [trackIdx, setTrackIdx] = useState(piece != null && piece >= 0 && piece < data.tracks.length ? piece : longest);
    const [k, setK] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState(5);
    const [message, setMessage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const track = data.tracks[trackIdx];
    const total = track.t.length;
    const period = data.info.period_s;
    const horizon = data.info.horizon;

    // начало - первый обзор с прогнозом у первой модели
    useEffect(() => {
        setK(data.models[0]?.results[trackIdx]?.ks[0] ?? 0);
    }, [data, trackIdx]);

    useEffect(() => {
        if (!playing) return;
        const timer = window.setInterval(() => setK((prev) => Math.min(prev + 1, total - 1)), (period * 1000) / speed);
        return () => window.clearInterval(timer);
    }, [playing, speed, period, total]);

    useEffect(() => {
        if (playing && k >= total - 1) setPlaying(false);
    }, [playing, k, total]);

    const jump = useCallback((kk: number) => { setPlaying(false); setK(kk); }, []);

    const exportForecast = async () => {
        if (!run) return;
        try {
            const response = await runsApi.exportForecast(run.oid);
            saveBlob(response.data, `${run.fileName.replace(/\.csv$/i, "")}_forecast.csv`);
        }
        catch (e) {
            setError(getApiErrorMessage(e, "Экспорт не выполнен"));
        }
    };

    const exportRadar = async () => {
        if (!run) return;
        try {
            const file = await runsApi.radarFile(run.oid, trackIdx);
            saveBlob(new Blob([file.text], { type: "text/csv" }), file.fileName);
            setMessage(`Сохранен ${file.fileName}. Координаты РЛС: широта ${file.radar.lat.toFixed(7)}, долгота ${file.radar.lon.toFixed(7)}, `
                + `высота ${file.radar.alt.toFixed(1)} м.`);
        }
        catch (e) {
            setError(getApiErrorMessage(e, "Выгрузка отметок не выполнена"));
        }
    };

    const head = (
        <>
            <div className="radar-run__head">
                <div>
                    <h3 className="radar-page__title">{run?.fileName ?? "Запуск"} - прогон целиком</h3>
                    <div className="radar-hint">
                        {run && `${fmtDateTime(run.created)}; `}моделей {data.models.length}; кусков {data.tracks.length}
                        {data.pd != null && `; вероятность обнаружения ${fmt(data.pd, 2)}`}
                    </div>
                </div>
                <div className="radar-row">
                    <Button svgIcon={downloadIcon} title="Прогноз всех моделей на каждом обзоре и горизонте (как forecast.csv у predict.py)"
                        onClick={exportForecast}>Прогноз CSV</Button>
                    {track.source === "log" && (
                        <Button svgIcon={downloadIcon} title="Отметки куска в формате файла РЛС - для запуска по ним"
                            onClick={exportRadar}>Отметки в формате РЛС</Button>
                    )}
                </div>
            </div>
            {message && <div className="radar-info">{message}</div>}
            {error && <div className="radar-error">{error}</div>}
        </>
    );

    const player = (
        <div className="radar-run__player">
            {data.tracks.length > 1 && (
                <DropDownList className="radar-run__chunk" value={trackIdx} data={data.tracks.map((_, i) => i)}
                    itemRender={(li, p) => ({ ...li, props: { ...li.props, children: `${data.tracks[p.dataItem].name}: ${data.tracks[p.dataItem].t.length} обзоров` } })}
                    valueRender={(el) => ({ ...el, props: { ...el.props, children: `${track.name}: ${total} обзоров` } })}
                    onChange={(e) => { setPlaying(false); setTrackIdx(e.value); }} />
            )}
            <ButtonGroup>
                <Button svgIcon={caretAltLeftIcon} title="Предыдущий обзор" disabled={k <= 0} onClick={() => setK(k - 1)} />
                <Button svgIcon={playing ? pauseIcon : playIcon} title={playing ? "Пауза" : "Проиграть"} onClick={() => setPlaying(!playing)} />
                <Button svgIcon={caretAltRightIcon} title="Следующий обзор" disabled={k >= total - 1} onClick={() => setK(k + 1)} />
            </ButtonGroup>
            <DropDownList className="radar-run__speed" data={SPEEDS} value={speed} onChange={(e) => setSpeed(e.value)}
                itemRender={(li, p) => ({ ...li, props: { ...li.props, children: `x${p.dataItem}` } })}
                valueRender={(el) => ({ ...el, props: { ...el.props, children: `x${speed}` } })} />
            <Slider className="radar-run__slider" min={0} max={Math.max(total - 1, 1)} step={1} value={k} buttons={false}
                onChange={(e) => setK(Math.round(e.value))} />
            <span className="radar-run__state">{scanState(track, k, data.info.phases)}</span>
        </div>
    );

    return (
        <RunWorkspace form={form} head={head} player={player} track={track} trackIdx={trackIdx} k={k} period={period} horizon={horizon}
            phases={data.info.phases} models={data.models} pieceErrors chartMarker={!playing} onScan={jump} />
    );
}
