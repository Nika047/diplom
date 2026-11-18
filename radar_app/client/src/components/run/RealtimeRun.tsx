import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { HubConnection } from "@microsoft/signalr";

import { Button, ButtonGroup } from "@progress/kendo-react-buttons";
import { DropDownList } from "@progress/kendo-react-dropdowns";
import { Slider } from "@progress/kendo-react-inputs";
import { Loader } from "@progress/kendo-react-indicators";
import { caretAltLeftIcon, caretAltRightIcon, pauseIcon, playIcon, stopIcon } from "@progress/kendo-svg-icons";

import type { EngineScan, RealtimeArchiveData, RealtimeSessionInfo, RealtimeState, RunRow, ScanEvent, ScanRecord, Track } from "../../data/dataModel";
import { realtimeApi, runsApi, saveBlob } from "../../services/api";
import { clientNowMs, connectRadarHub } from "../../services/radarHub";
import { engineClock, syncServerClock } from "../../services/clockSync";
import { getApiErrorMessage } from "../../helpers/apiError";
import { fmt, fmtDateTime } from "../../helpers/format";
import { latencyCsv } from "../../helpers/latency";
import type { Clocks, LatencyEntry } from "../../helpers/latency";
import { realtimeModels } from "../../helpers/runModels";
import type { ScanSlot } from "../../helpers/runModels";
import LatencyPanel from "../LatencyPanel";
import RunWorkspace from "./RunWorkspace";
import { scanState, SPEEDS } from "./FullRun";

// сколько последних обзоров с метками времени держать (панель задержек)
const LATENCY_KEEP = 1000;

// как часто заново оценивать расхождение часов, мс
const BROWSER_CLOCK_EVERY = 30_000;
const ENGINE_CLOCK_EVERY = 60_000;

// часы сохраненной сессии не оценивались: метки движка и сервера берутся как есть (на одном компьютере - доли мс)
const NO_CLOCKS: Clocks = { browser: null, engine: null };

// время движка по всем сессиям обзора: IMM и сеть - сумма, ожидание замка - у первой сессии
const engineMs = (s: Pick<ScanRecord, "result" | "results">) => {
    const all: EngineScan[] = s.results ? Object.values(s.results) : [s.result];
    return {
        immMs: all.reduce((sum, r) => sum + (r.ms?.imm ?? 0), 0),
        netMs: all.reduce((sum, r) => sum + (r.ms?.net ?? 0), 0),
        waitMs: s.result.ms?.wait ?? 0,
    };
};

const slotsOf = (records: ScanRecord[]): ScanSlot[] => {
    const list: ScanSlot[] = [];
    records.forEach((s) => { list[s.k] = { result: s.result, results: s.results }; });
    return list;
};

interface Props {
    oid: string;
    run: RunRow | null;
    form: ReactNode;
}

// реальное время: открытая сессия - обзоры идут с сервера по таймеру (SignalR), плеер управляет сессией на сервере;
// закрытая - сохраненные обзоры из файла запуска
export default function RealtimeRun({ oid, run, form }: Props) {
    const navigate = useNavigate();

    const [session, setSession] = useState<RealtimeSessionInfo | null>(null);
    const [track, setTrack] = useState<Track | null>(null);
    const [scans, setScans] = useState<ScanSlot[]>([]);
    const [state, setState] = useState<RealtimeState | null>(null);
    const [latency, setLatency] = useState<LatencyEntry[]>([]);
    const [seekTarget, setSeekTarget] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [closed, setClosed] = useState(false);
    const [connection, setConnection] = useState<HubConnection | null>(null);
    const [clocks, setClocks] = useState<Clocks>({ browser: null, engine: null });

    const pendingRender = useRef<LatencyEntry | null>(null);
    const seekTimer = useRef<number | null>(null);

    // сессия целиком (трасса и посчитанные обзоры): при открытии и после переподключения
    const load = useCallback(async () => {
        try {
            const info = await realtimeApi.get(oid);
            setSession(info);
            setTrack(info.track ?? null);
            setScans(slotsOf(info.scans ?? []));
            setState(info.state);
        }
        catch (e: any) {
            if (e?.response?.status === 404) setClosed(true);
            else setError(getApiErrorMessage(e, "Сессия не загружена"));
        }
    }, [oid]);

    useEffect(() => {
        let connection: HubConnection | null = null;
        let alive = true;

        load().then(() => connectRadarHub(oid, {
            onScan: (e: ScanEvent, receivedMs: number) => {
                setScans((prev) => {
                    const next = prev.slice();
                    next[e.k] = { result: e.result, results: e.results };
                    return next;
                });
                setState(e.state);

                if (!e.replay && e.stamps) {
                    pendingRender.current = {
                        k: e.k,
                        plotMs: e.stamps.plotMs,
                        engineReceivedMs: e.stamps.engineReceivedMs,
                        engineDoneMs: e.stamps.engineDoneMs,
                        sentMs: e.stamps.sentMs ?? e.stamps.engineDoneMs,
                        receivedMs,
                        renderedMs: null,
                        ...engineMs(e),
                    };
                }
            },
            onScans: (items: ScanRecord[]) => setScans((prev) => {
                const next = prev.slice();
                items.forEach((s) => { next[s.k] = { result: s.result, results: s.results }; });
                return next;
            }),
            onState: (s: RealtimeState) => {
                if (s.stopped) setClosed(true);
                else setState(s);
            },
            onReconnected: () => { load(); },
        })).then((c) => {
            if (alive) {
                connection = c;
                setConnection(c);
            }
            else c.stop();
        }).catch((e) => setError(getApiErrorMessage(e, "Нет связи с каналом реального времени")));

        return () => {
            alive = false;
            connection?.invoke("Leave", oid).catch(() => { }).finally(() => connection?.stop());
        };
    }, [oid, load]);

    // расхождение часов браузер - сервер (пинг по хабу) и движок - сервер (оценивает сервер); часы плывут - повторять
    useEffect(() => {
        if (!connection) return;
        const browser = () => syncServerClock(connection)
            .then((c) => setClocks((prev) => ({ ...prev, browser: c })))
            .catch(() => { });
        const engine = () => engineClock()
            .then((c) => setClocks((prev) => ({ ...prev, engine: c })))
            .catch(() => { });

        browser();
        engine();
        const t1 = window.setInterval(browser, BROWSER_CLOCK_EVERY);
        const t2 = window.setInterval(engine, ENGINE_CLOCK_EVERY);

        return () => { window.clearInterval(t1); window.clearInterval(t2); };
    }, [connection]);

    const position = state?.position ?? -1;
    const total = track?.t.length ?? 0;
    const period = session?.info.period_s ?? 2;
    const horizon = session?.info.horizon ?? 5;

    // отрисовано: следующий кадр после того, как карта получила новый обзор
    useEffect(() => {
        const entry = pendingRender.current;
        if (!entry || entry.k !== position) return;
        pendingRender.current = null;

        const record = (done: LatencyEntry) => setLatency((prev) => [...prev.slice(-(LATENCY_KEEP - 1)), done]);

        // скрытая вкладка не рисует кадры: requestAnimationFrame не сработает до ее показа
        if (document.visibilityState === "hidden") record({ ...entry, hidden: true });
        else requestAnimationFrame(() => record({ ...entry, renderedMs: clientNowMs() }));
    }, [position, scans]);

    const models = useMemo(() => (session && track ? realtimeModels(session, scans, total, horizon) : []), [session, track, scans, total, horizon]);

    const control = async (action: () => Promise<RealtimeState>) => {
        setError(null);
        try {
            setState(await action());
        }
        catch (e) {
            setError(getApiErrorMessage(e));
        }
    };

    // перемотка ползунком: запрос - когда ползунок остановился
    const seek = (k: number) => {
        setSeekTarget(k);
        if (seekTimer.current) window.clearTimeout(seekTimer.current);
        seekTimer.current = window.setTimeout(() => {
            control(() => realtimeApi.seek(oid, k)).finally(() => setSeekTarget(null));
        }, 250);
    };

    const jump = useCallback((k: number) => { control(() => realtimeApi.seek(oid, k)); }, [oid]);

    const stop = async () => {
        if (!window.confirm("Закрыть сессию реального времени? Посчитанные обзоры останутся в истории.")) return;
        try {
            await realtimeApi.stop(oid);
        }
        finally {
            navigate("/history");
        }
    };

    if (closed) return <RealtimeArchive oid={oid} run={run} form={form} />;
    if (error && !session) return <div className="radar-page"><div className="radar-error">{error}</div></div>;
    if (!session || !track || !state) return <div className="radar-center"><Loader size="large" type="converging-spinner" /></div>;

    const k = Math.max(position, 0);
    const maxSpeed = session.maxSpeed ?? 50;
    const speeds = SPEEDS.filter((s) => s <= maxSpeed);

    const exportLatency = () => saveBlob(new Blob([latencyCsv(latency, clocks)], { type: "text/csv" }),
        `${session.fileName.replace(/\.csv$/i, "")}_latency_x${state.speed}.csv`);

    const head = (
        <>
            <div className="radar-run__head">
                <div>
                    <h3 className="radar-page__title">{session.fileName} - реальное время</h3>
                    <div className="radar-hint">
                        {track.name}; моделей {models.length}{session.pd != null && `; вероятность обнаружения ${fmt(session.pd, 2)}`}
                        ; обзор раз в {fmt(period, 0)} с{maxSpeed < 50 && `; ускорение не выше x${maxSpeed} (много моделей)`}
                    </div>
                </div>
                <Button svgIcon={stopIcon} onClick={stop}>Закрыть сессию</Button>
            </div>
            {error && <div className="radar-error">{error}</div>}
        </>
    );

    const player = (
        <div className="radar-run__player">
            <ButtonGroup>
                <Button svgIcon={state.playing ? pauseIcon : playIcon} title={state.playing ? "Пауза" : "Пуск"} themeColor="primary"
                    onClick={() => control(() => (state.playing ? realtimeApi.pause(oid) : realtimeApi.play(oid)))} />
                <Button svgIcon={caretAltRightIcon} title="Следующий обзор" disabled={state.ended}
                    onClick={() => control(() => realtimeApi.step(oid))} />
            </ButtonGroup>
            <DropDownList className="radar-run__speed" data={speeds} value={state.speed}
                onChange={(e) => control(() => realtimeApi.speed(oid, e.value))}
                itemRender={(li, p) => ({ ...li, props: { ...li.props, children: `x${p.dataItem}` } })}
                valueRender={(el) => ({ ...el, props: { ...el.props, children: `x${state.speed}` } })} />
            <Slider className="radar-run__slider" min={0} max={Math.max(total - 1, 1)} step={1} value={seekTarget ?? k} buttons={false}
                onChange={(e) => seek(Math.round(e.value))} />
            <span className="radar-run__state">
                {position < 0 ? "обзоров ещё не было" : scanState(track, k, session.info.phases)}
                ; посчитано {state.computed}{state.ended && "; трасса пройдена"}{seekTarget != null && "; перемотка..."}
            </span>
        </div>
    );

    return (
        <RunWorkspace form={form} head={head} player={player} track={track} trackIdx={0} k={k} period={period} horizon={horizon}
            phases={session.info.phases} models={models} pieceErrors={false} chartMarker={!state.playing} onScan={jump}
            bottom={<LatencyPanel entries={latency} clocks={clocks} intervalMs={(period * 1000) / state.speed}
                onExport={exportLatency} onClear={() => setLatency([])} />} />
    );
}

// закрытая сессия: посчитанные обзоры из файла запуска, плеер - в браузере, без движка
function RealtimeArchive({ oid, run, form }: Props) {
    const [data, setData] = useState<RealtimeArchiveData | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [k, setK] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState(5);

    useEffect(() => {
        runsApi.anyResult(oid)
            .then((result) => {
                const saved = result as RealtimeArchiveData;
                setData(saved);
                setK(Math.max(0, (saved.realtime?.scans.length ?? 1) - 1));
            })
            .catch((e) => setError(e?.response?.status === 404
                ? "Сессия закрыта, но её обзоры не сохранились: сервер был остановлен аварийно (закрыто окно или снят процесс), пока сессия была открыта."
                : getApiErrorMessage(e, "Сохраненная сессия не загружена")));
    }, [oid]);

    const track = data?.tracks[0] ?? null;
    const total = track?.t.length ?? 0;
    const period = data?.info.period_s ?? 2;
    const horizon = data?.info.horizon ?? 5;
    const computed = data?.realtime?.scans.length ?? 0;

    const scans = useMemo(() => slotsOf(data?.realtime?.scans ?? []), [data]);
    const models = useMemo(() => (data && track ? realtimeModels(data, scans, total, horizon) : []), [data, track, scans, total, horizon]);

    // метки браузера не сохраняются - только путь до отправки клиенту
    const latency = useMemo<LatencyEntry[]>(() => (data?.realtime?.scans ?? [])
        .filter((s) => s.stamps?.plotMs != null)
        .map((s) => ({
            k: s.k,
            plotMs: s.stamps.plotMs,
            engineReceivedMs: s.stamps.engineReceivedMs,
            engineDoneMs: s.stamps.engineDoneMs,
            sentMs: s.stamps.sentMs ?? NaN,
            receivedMs: null,
            renderedMs: null,
            ...engineMs(s),
        })), [data]);

    // проигрывание по посчитанным обзорам
    useEffect(() => {
        if (!playing || !computed) return;
        const timer = window.setInterval(() => setK((prev) => Math.min(prev + 1, computed - 1)), (period * 1000) / speed);
        return () => window.clearInterval(timer);
    }, [playing, speed, period, computed]);

    useEffect(() => {
        if (playing && k >= computed - 1) setPlaying(false);
    }, [playing, k, computed]);

    const jump = useCallback((kk: number) => { setPlaying(false); setK(Math.min(kk, Math.max(computed - 1, 0))); }, [computed]);

    if (error) return <div className="radar-page"><div className="radar-error">{error}</div></div>;
    if (!data || !track) return <div className="radar-center"><Loader size="large" type="converging-spinner" /></div>;

    const exportLatency = () => saveBlob(new Blob([latencyCsv(latency, NO_CLOCKS)], { type: "text/csv" }),
        `${(run?.fileName ?? "session").replace(/\.csv$/i, "")}_latency_saved.csv`);

    const head = (
        <>
            <div className="radar-run__head">
                <div>
                    <h3 className="radar-page__title">{run?.fileName ?? "Сессия"} - реальное время, сохраненная сессия</h3>
                    <div className="radar-hint">
                        {run && `${fmtDateTime(run.created)}; `}{track.name}; моделей {models.length}
                        {data.pd != null && `; вероятность обнаружения ${fmt(data.pd, 2)}`}; посчитано обзоров {computed} из {total}
                    </div>
                </div>
            </div>
            <div className="radar-info">Сессия закрыта: показаны сохраненные обзоры, движок не участвует. Новый запуск - в панели справа.</div>
        </>
    );

    if (computed === 0) {
        return (
            <RunWorkspace form={form} head={<>{head}<div className="radar-hint">В сессии не было посчитанных обзоров.</div></>} player={null}
                track={track} trackIdx={0} k={0} period={period} horizon={horizon} phases={data.info.phases} models={[]} pieceErrors={false}
                chartMarker={false} onScan={jump} />
        );
    }

    const player = (
        <div className="radar-run__player">
            <ButtonGroup>
                <Button svgIcon={caretAltLeftIcon} title="Предыдущий обзор" disabled={k <= 0} onClick={() => setK(k - 1)} />
                <Button svgIcon={playing ? pauseIcon : playIcon} title={playing ? "Пауза" : "Проиграть"} onClick={() => setPlaying(!playing)} />
                <Button svgIcon={caretAltRightIcon} title="Следующий обзор" disabled={k >= computed - 1} onClick={() => setK(k + 1)} />
            </ButtonGroup>
            <DropDownList className="radar-run__speed" data={SPEEDS} value={speed} onChange={(e) => setSpeed(e.value)}
                itemRender={(li, p) => ({ ...li, props: { ...li.props, children: `x${p.dataItem}` } })}
                valueRender={(el) => ({ ...el, props: { ...el.props, children: `x${speed}` } })} />
            <Slider className="radar-run__slider" min={0} max={Math.max(computed - 1, 1)} step={1} value={k} buttons={false}
                onChange={(e) => setK(Math.round(e.value))} />
            <span className="radar-run__state">{scanState(track, k, data.info.phases)}; посчитано {computed}</span>
        </div>
    );

    return (
        <RunWorkspace form={form} head={head} player={player} track={track} trackIdx={0} k={k} period={period} horizon={horizon}
            phases={data.info.phases} models={models} pieceErrors={false} chartMarker={!playing} onScan={jump}
            bottom={<LatencyPanel entries={latency} clocks={NO_CLOCKS} intervalMs={null} liveClocks={false} onExport={exportLatency}
                note="Сохраненная сессия: метки браузера не сохраняются, «всего» - от отметки до отправки события клиенту; поправка на часы движка не сохранена (на одном компьютере - доли миллисекунды)." />} />
    );
}
