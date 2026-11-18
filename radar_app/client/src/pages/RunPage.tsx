import { useEffect, useMemo, useState } from "react";
import { Navigate, useParams, useSearchParams } from "react-router-dom";

import { Loader } from "@progress/kendo-react-indicators";

import type { FlightRow, ModelRow, RunRow, ScenarioRow } from "../data/dataModel";
import { engineCaseName } from "../data/enums";
import { flightsApi, modelsApi, runsApi, scenariosApi } from "../services/api";
import { applyScenarioView } from "../components/map/mapSettings";
import { getApiErrorMessage } from "../helpers/apiError";
import { fullRunData } from "../helpers/runModels";
import type { FullRunData } from "../helpers/runModels";
import { EmptyMap } from "../components/map/TrackMap";
import RunForm, { emptyRunForm } from "../components/run/RunForm";
import type { RunFormValues } from "../components/run/RunForm";
import { RunLayout } from "../components/run/RunWorkspace";
import FullRun from "../components/run/FullRun";
import RealtimeRun from "../components/run/RealtimeRun";

// полёт запуска в справочнике: траектория - по прогону и id, загруженный файл - по OID, копия лога диплома - по имени
const flightOf = (run: RunRow, flights: FlightRow[]): string | null => (run.kind === "track"
    ? flights.find((f) => f.kind === "track" && f.run === run.trackRun && f.trackId === run.trackId)
    : flights.find((f) => f.origin === "manual" && f.sourceFileOID === run.sourceFileOID)
        ?? flights.find((f) => (f.origin === "real" || f.origin === "sim") && f.fileName === run.fileName))?.key ?? null;

// модели запуска: из записи; у старых запусков - модели диплома того же случая (IMM и гибрид или ансамбль)
const modelsOf = (run: RunRow, catalog: ModelRow[]): string[] => {
    if (run.modelOIDs.length) return run.modelOIDs.filter((oid) => catalog.some((m) => m.oid === oid));
    if (run.mode === "compare") return [];

    const own = catalog.filter((m) => m.fromDiplom && m.bundle.endsWith(`/${engineCaseName[run.case]}`));
    const net = own.find((m) => m.kind === (run.ensemble ? "ens" : "hyb"));
    const imm = own.find((m) => m.kind === "imm");
    return [run.mode === "full" ? imm : undefined, net].filter((m): m is ModelRow => !!m).map((m) => m.oid);
};

// запуск: без параметров - карта России и параметры запуска; /runs/<OID> - прогон целиком или реальное время со всеми
// моделями на одной трассе, параметры в панели заполнены значениями запуска (изменить и запустить - новый запуск)
export default function RunPage() {
    const { oid } = useParams<{ oid: string }>();
    // из справочника полётов: ?log=<имя лога диплома>, ?file=<OID загруженного файла>, ?track=<прогон>/<id траектории>;
    // после запуска сценария - ?scenario=<OID>: вид карты из сценария
    const [params] = useSearchParams();
    const scenarioOid = params.get("scenario");

    const [flights, setFlights] = useState<FlightRow[] | null>(null);
    const [catalog, setCatalog] = useState<ModelRow[] | null>(null);
    const [scenarios, setScenarios] = useState<ScenarioRow[] | null>(null);
    // вид из сценария записывается до открытия запуска: карта читает выбор зрителя при создании
    const [viewApplied, setViewApplied] = useState(!scenarioOid);
    const [run, setRun] = useState<RunRow | null | undefined>(undefined);
    const [data, setData] = useState<FullRunData | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        flightsApi.list().then(setFlights).catch((e) => { setFlights([]); setError(getApiErrorMessage(e, "Полёты не загружены")); });
        modelsApi.list().then(setCatalog).catch((e) => { setCatalog([]); setError(getApiErrorMessage(e, "Модели не загружены")); });
        scenariosApi.list().then(setScenarios).catch(() => setScenarios([]));
    }, []);

    useEffect(() => {
        if (!scenarioOid) return;
        scenariosApi.get(scenarioOid).then(applyScenarioView).catch(() => undefined).finally(() => setViewApplied(true));
    }, [scenarioOid]);

    useEffect(() => {
        setRun(undefined);
        setData(null);
        if (!oid) return;

        runsApi.list()
            .then((runs) => {
                const found = runs.find((r) => r.oid === oid) ?? null;
                setRun(found);
                if (found && found.mode !== "realtime") {
                    runsApi.anyResult(oid).then((d) => setData(fullRunData(d))).catch((e) => setError(getApiErrorMessage(e, "Запуск не загружен")));
                }
            })
            .catch((e) => setError(getApiErrorMessage(e, "Запуск не загружен")));
    }, [oid]);

    const initial = useMemo<RunFormValues | null>(() => {
        if (!flights || !catalog || !scenarios) return null;
        if (!oid) {
            const log = params.get("log");
            const file = params.get("file");
            const track = params.get("track");
            const key = flights.find((f) => (log && (f.origin === "real" || f.origin === "sim") && f.fileName === log)
                || (file && f.sourceFileOID === file) || (track && f.key === track))?.key ?? null;
            return { ...emptyRunForm, flightKey: key };
        }
        if (!run) return null;
        // запуск по сценарию: сценарий выбран, если он есть с тем же наименованием
        const scenario = run.scenarioName ? scenarios.find((s) => s.name === run.scenarioName) ?? null : null;
        return {
            ...emptyRunForm,
            scenario: scenario?.oid ?? null,
            flightKey: flightOf(run, flights),
            models: modelsOf(run, catalog),
            mode: run.mode === "realtime" ? "realtime" : "full",
            pd: run.pd ?? 1,
            radarLat: run.radarLat,
            radarLon: run.radarLon,
            radarAlt: run.radarAlt ?? 0,
        };
    }, [flights, catalog, scenarios, oid, run, params]);

    const form = initial && flights && catalog && scenarios
        ? <RunForm key={`${oid ?? "new"}:${params.toString()}`} flights={flights} catalog={catalog} scenarios={scenarios} initial={initial} />
        : <Loader />;

    if (!oid) {
        return (
            <RunLayout aside={form}>
                <div className="radar-run__head">
                    <div>
                        <h3 className="radar-page__title">Новый запуск</h3>
                        <div className="radar-hint">Выберите в панели справа полёт и модели и нажмите «Запустить»: прогноз появится
                            на карте и в истории запусков.</div>
                    </div>
                </div>
                {error && <div className="radar-error">{error}</div>}
                <div className="radar-runpage__map"><EmptyMap /></div>
            </RunLayout>
        );
    }

    if (run === null) return <div className="radar-page"><div className="radar-error">Запуск не найден</div></div>;
    if (error && !data && run?.mode !== "realtime") return <div className="radar-page"><div className="radar-error">{error}</div></div>;
    if (run === undefined || (run.mode !== "realtime" && !data) || !viewApplied) {
        return <div className="radar-center"><Loader size="large" type="converging-spinner" /></div>;
    }

    return run.mode === "realtime"
        ? <RealtimeRun key={oid} oid={oid} run={run} form={form} />
        : <FullRun key={oid} run={run} data={data!} form={form}
            piece={run.scenarioName ? scenarios?.find((s) => s.name === run.scenarioName)?.piece : null} />;
}

// прежние адреса экранов запуска (/realtime/<OID>, /compare/<OID>) ведут на общую страницу запуска
export function RunRedirect() {
    const { oid } = useParams<{ oid: string }>();
    return <Navigate to={`/runs/${oid}`} replace />;
}
