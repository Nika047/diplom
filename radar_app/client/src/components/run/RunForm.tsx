import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@progress/kendo-react-buttons";
import { ComboBox, DropDownList, MultiSelect } from "@progress/kendo-react-dropdowns";
import { filterBy } from "@progress/kendo-data-query";
import { NumericTextBox, RadioGroup } from "@progress/kendo-react-inputs";
import { Label } from "@progress/kendo-react-labels";
import { Loader } from "@progress/kendo-react-indicators";
import { playIcon } from "@progress/kendo-svg-icons";

import type { FlightRow, ModelRow, ScenarioRow } from "../../data/dataModel";
import { flightOriginOptions, optionText, runModeOptions, splitTitle } from "../../data/enums";
import { realtimeApi, runsApi, scenariosApi, sourceFilesApi } from "../../services/api";
import { getApiErrorMessage } from "../../helpers/apiError";
import { fmtDuration } from "../../helpers/format";

export type RunFormMode = "full" | "realtime";

export interface RunFormValues {
    scenario: string | null;    // OID сценария: поля ниже - из него; правка любого поля сценарий снимает
    flightKey: string | null;   // FlightRow.key: имя лога диплома, OID загруженного файла или <прогон>/<id траектории>
    models: string[];           // OID моделей справочника по порядку выбора
    mode: RunFormMode;
    pd: number | null;
    radarLat: number | null;
    radarLon: number | null;
    radarAlt: number | null;
    piece: number | null;       // кусок для реального времени; null - самый длинный
    speed: number;
}

export const emptyRunForm: RunFormValues = {
    scenario: null, flightKey: null, models: [], mode: "full", pd: 1, radarLat: null, radarLon: null, radarAlt: 0, piece: null, speed: 1,
};

const MODES = [
    { value: "full", label: "прогон целиком" },
    { value: "realtime", label: "реальное время (обзор раз в 2 с)" },
];

const SPEEDS = [1, 2, 5, 10, 25, 50];

// как у сервера (RealtimeService.ManyModels, LimitedSpeed): движок считает модели по очереди
const MANY_MODELS = 5;
const LIMITED_SPEED = 10;

// полётов в списке при поиске: логов и траекторий больше тысячи, список рисуется целиком
const FLIGHT_LIST_LIMIT = 200;

// полёт сценария - ключ строки справочника полётов (FlightRow.key)
export const scenarioFlightKey = (s: ScenarioRow): string | null => (s.flightSource === "log" ? s.logName
    : s.flightSource === "upload" ? s.sourceFileOID : `${s.trackRun}/${s.trackId}`);

// поля запуска из сценария
export const scenarioValues = (s: ScenarioRow): RunFormValues => ({
    scenario: s.oid,
    flightKey: scenarioFlightKey(s),
    models: s.modelOIDs,
    mode: s.mode === "realtime" ? "realtime" : "full",
    pd: s.pd ?? 1,
    radarLat: s.radarLat,
    radarLon: s.radarLon,
    radarAlt: s.radarAlt ?? 0,
    piece: s.piece,
    speed: s.speed ?? 1,
});

interface Props {
    flights: FlightRow[];
    catalog: ModelRow[];
    scenarios: ScenarioRow[];
    initial: RunFormValues;
}

// параметры запуска в боковой панели: сценарий, полёт, модели, режим, условия РЛС; каждый запуск пишется в историю
export default function RunForm({ flights, catalog, scenarios, initial }: Props) {
    const navigate = useNavigate();
    const [values, setValues] = useState<RunFormValues>(initial);
    const [flightFilter, setFlightFilter] = useState("");
    const [modelFilter, setModelFilter] = useState("");
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    // правка поля - уже не сценарий, а свои параметры
    const set = (patch: Partial<RunFormValues>) => setValues((prev) => ({ ...prev, ...patch, scenario: null }));
    const scenario = scenarios.find((s) => s.oid === values.scenario) ?? null;

    // запускать можно только полёты, у которых после очистки остались куски
    const runnable = useMemo(() => flights.filter((f) => (f.pieces ?? 0) > 0 && !f.error), [flights]);
    const flight = runnable.find((f) => f.key === values.flightKey) ?? null;
    const selected = values.models.map((oid) => catalog.find((m) => m.oid === oid)).filter((m): m is ModelRow => !!m);

    const maxSpeed = selected.length >= MANY_MODELS ? LIMITED_SPEED : 50;
    const speeds = SPEEDS.filter((s) => s <= maxSpeed);
    // вероятность обнаружения - у лога и траектории (отметки моделирует код диплома), координаты РЛС - у файла отметок
    const isLog = flight?.kind !== "radar";

    // сценарий проверен при сохранении: запускается как есть
    const ready = !busy && (!!scenario || (!!flight && selected.length > 0
        && (!isLog || (values.pd != null && values.pd > 0 && values.pd <= 1))
        && (isLog || (values.radarLat == null) === (values.radarLon == null))));

    const start = async () => {
        setError(null);

        if (scenario) {
            try {
                setBusy(`Запуск сценария «${scenario.name}»...`);
                const run = await scenariosApi.run(scenario.oid);
                navigate(`/runs/${run.oid}?scenario=${scenario.oid}`);
            }
            catch (e) {
                setError(getApiErrorMessage(e, "Сценарий не запущен"));
            }
            finally {
                setBusy(null);
            }
            return;
        }

        if (!flight) return;

        try {
            setBusy("Подготовка файла...");
            // лог диплома копируется в хранилище при первом запуске; дальше используется та же копия. У траектории файла нет
            const sourceFileOID = flight.kind === "track" ? null : flight.sourceFileOID ?? (await sourceFilesApi.importDiplomLog(flight.fileName)).oid;
            const model = {
                sourceFileOID,
                trackRun: flight.kind === "track" ? flight.run : null,
                trackId: flight.kind === "track" ? flight.trackId : null,
                models: selected.map((m) => m.oid),
                pd: values.pd ?? 1,
                radarLat: values.radarLat,
                radarLon: values.radarLon,
                radarAlt: values.radarAlt ?? 0,
            };

            if (values.mode === "full") {
                setBusy(`Прогноз в движке: моделей ${selected.length}...`);
                const run = await runsApi.create(model);
                navigate(`/runs/${run.oid}`);
            }
            else {
                setBusy("Сессия реального времени...");
                const session = await realtimeApi.create({ ...model, track: values.piece, speed: Math.min(values.speed, maxSpeed) });
                navigate(`/runs/${session.oid}`);
            }
        }
        catch (e) {
            setError(getApiErrorMessage(e, "Запуск не выполнен"));
        }
        finally {
            setBusy(null);
        }
    };

    // подпись полёта: у лога - аппарат и выборки по прогонам, у траектории - прогон, источник, сценарий или вид расширения
    const flightText = (f: FlightRow) => [
        f.kind === "track" ? `${f.run}, ${optionText(flightOriginOptions, f.origin)}` : f.aircraft,
        f.detail,
        f.kind === "track"
            ? (f.run && f.splits?.[f.run] ? splitTitle[f.splits[f.run]!] ?? f.splits[f.run] : null)
            : Object.entries(f.splits ?? {}).filter(([, s]) => s).map(([run, s]) => `${run}: ${splitTitle[s!] ?? s}`).join(", ") || null,
        fmtDuration(f.durationS),
        (f.pieces ?? 0) > 1 ? `кусков ${f.pieces}` : null,
    ].filter(Boolean).join(", ");

    const flightList = useMemo(() => filterBy(runnable, { field: "fileName", operator: "contains", value: flightFilter, ignoreCase: true })
        .slice(0, FLIGHT_LIST_LIMIT), [runnable, flightFilter]);

    return (
        <section className="radar-side__block radar-side__form">
            <h4>Параметры запуска</h4>

            <div>
                <Label>Сценарий</Label>
                <DropDownList data={scenarios} textField="name" dataItemKey="oid" value={scenario} disabled={!scenarios.length}
                    defaultItem={{ oid: null, name: scenarios.length ? "без сценария" : "сценариев пока нет" }}
                    onChange={(e) => {
                        const s = e.value as ScenarioRow | null;
                        setValues(s?.oid ? scenarioValues(s) : { ...values, scenario: null });
                    }} />
                <div className="radar-hint">{scenario
                    ? `${optionText(runModeOptions, scenario.mode)}; поля ниже - из сценария, правка любого из них снимает сценарий.`
                    : "Сценарий заполнит поля ниже. Сценарии - в меню «Запуск», «Сценарии»."}</div>
            </div>

            <hr className="radar-side__sep" />

            <div>
                <Label>Полёт</Label>
                <ComboBox data={flightList}
                    textField="fileName" dataItemKey="key" value={flight} filterable onFilterChange={(e) => setFlightFilter(e.filter.value)}
                    placeholder="лог, файл отметок или траектория пакета" onChange={(e) => set({ flightKey: (e.value as FlightRow | null)?.key ?? null, piece: null })}
                    itemRender={(li, p) => ({ ...li, props: { ...li.props, children: (
                        <span className="radar-side__option">
                            <span>{(p.dataItem as FlightRow).fileName}</span>
                            <span className="radar-hint">{flightText(p.dataItem as FlightRow)}</span>
                        </span>
                    ) } })} />
                {flight && <div className="radar-hint">{flightText(flight)}</div>}
            </div>

            <div>
                <Label>Модели (одна или несколько - сравнение на одной трассе)</Label>
                <MultiSelect data={filterBy(catalog, { field: "name", operator: "contains", value: modelFilter, ignoreCase: true })}
                    textField="name" dataItemKey="oid" value={selected} filterable onFilterChange={(e) => setModelFilter(e.filter.value)}
                    placeholder="выберите модели" onChange={(e) => set({ models: (e.value as ModelRow[]).map((m) => m.oid) })} />
            </div>

            <div>
                <Label>Режим</Label>
                <RadioGroup data={MODES} value={values.mode} onChange={(e) => set({ mode: e.value as RunFormMode })} />
            </div>

            {values.mode === "realtime" && (
                <div className="radar-row">
                    <div>
                        <Label>Ускорение</Label>
                        <DropDownList data={speeds} value={Math.min(values.speed, maxSpeed)} onChange={(e) => set({ speed: e.value })}
                            itemRender={(li, p) => ({ ...li, props: { ...li.props, children: `x${p.dataItem}` } })}
                            valueRender={(el) => ({ ...el, props: { ...el.props, children: `x${Math.min(values.speed, maxSpeed)}` } })} />
                    </div>
                    {flight && (flight.pieces ?? 0) > 1 && (
                        <div>
                            <Label>Кусок лога</Label>
                            <DropDownList data={[null, ...Array.from({ length: flight.pieces ?? 0 }, (_, i) => i)]} value={values.piece}
                                onChange={(e) => set({ piece: e.value })}
                                itemRender={(li, p) => ({ ...li, props: { ...li.props, children: p.dataItem == null ? "самый длинный" : `кусок ${p.dataItem}` } })}
                                valueRender={(el) => ({ ...el, props: { ...el.props, children: values.piece == null ? "самый длинный" : `кусок ${values.piece}` } })} />
                        </div>
                    )}
                    {selected.length >= MANY_MODELS && (
                        <div className="radar-hint">При {MANY_MODELS} и больше моделях ускорение - не выше x{LIMITED_SPEED}: движок считает модели по очереди.</div>
                    )}
                </div>
            )}

            {flight && isLog && (
                <div>
                    <Label>Вероятность обнаружения цели РЛС за обзор</Label>
                    <NumericTextBox value={values.pd} min={0.05} max={1} step={0.05} format="n2" onChange={(e) => set({ pd: e.value })} />
                    <div className="radar-hint">Отметки РЛС для {flight.kind === "track" ? "траектории" : "лога"} моделирует движок: 1 -
                        отметка на каждом обзоре, 0,9 - каждая десятая пропущена.{flight.kind === "track"
                            ? " У траектории нет широты и долготы - только плоскость." : ""}</div>
                </div>
            )}

            {flight && !isLog && (
                <div>
                    <Label>Где стоит РЛС (для показа на карте)</Label>
                    <div className="radar-row">
                        <NumericTextBox placeholder="широта" value={values.radarLat} format="n6" onChange={(e) => set({ radarLat: e.value })} />
                        <NumericTextBox placeholder="долгота" value={values.radarLon} format="n6" onChange={(e) => set({ radarLon: e.value })} />
                        <NumericTextBox placeholder="высота, м" value={values.radarAlt} format="n1" onChange={(e) => set({ radarAlt: e.value })} />
                    </div>
                    <div className="radar-hint">Отметки в файле - относительно РЛС; без её координат - только плоскость.</div>
                </div>
            )}

            {error && <div className="radar-error">{error}</div>}

            <Button themeColor="primary" svgIcon={playIcon} disabled={!ready} onClick={start}>Запустить</Button>
            {busy && <div className="radar-row"><Loader size="small" /> <span className="radar-hint">{busy}</span></div>}
            {!flight && !scenario && <div className="radar-hint">Выберите сценарий или полёт и хотя бы одну модель. Запуск появится в
                истории запусков.</div>}
        </section>
    );
}
