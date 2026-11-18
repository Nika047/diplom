import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { Button } from "@progress/kendo-react-buttons";
import { ComboBox, DropDownList, MultiSelect } from "@progress/kendo-react-dropdowns";
import { filterBy } from "@progress/kendo-data-query";
import { Checkbox, NumericTextBox, RadioGroup, TextArea, TextBox } from "@progress/kendo-react-inputs";
import { Label } from "@progress/kendo-react-labels";
import { Loader } from "@progress/kendo-react-indicators";
import { cancelIcon, checkIcon, playIcon, saveIcon, trashIcon } from "@progress/kendo-svg-icons";

import type { FlightRow, FlightSource, ModelRow, RunMode, ScenarioEditModel, ScenarioRow } from "../data/dataModel";
import { basemapTitle, flightOriginOptions, layerTitle, optionText } from "../data/enums";
import { flightsApi, modelsApi, scenariosApi } from "../services/api";
import { getApiErrorMessage, getApiErrors } from "../helpers/apiError";
import { fmtDuration } from "../helpers/format";

const LIST_PATH = "/scenarios";

const MODES = [
    { value: "full", label: "прогон целиком" },
    { value: "realtime", label: "реальное время (обзор раз в 2 с)" },
];

const SPEEDS = [1, 2, 5, 10, 25, 50];
const HORIZONS_S = [2, 4, 6, 8, 10];
const LAYERS = Object.keys(layerTitle);

// полётов в списке при поиске: логов и траекторий больше тысячи, список рисуется целиком
const FLIGHT_LIST_LIMIT = 200;

// выбор «как у зрителя» - значение не задаётся в сценарии
const VIEWER = "как выбрал зритель";
const BASEMAPS = [{ value: null, text: VIEWER }, ...Object.entries(basemapTitle).map(([value, text]) => ({ value, text }))];
// вид карты: фокус на прогнозе и слежение за целью вместе не задаются
type ViewChoice = { value: string | null; text: string; focus: boolean | null; follow: boolean | null };
const VIEWS: ViewChoice[] = [
    { value: null, text: VIEWER, focus: null, follow: null },
    { value: "focus", text: "фокус на прогнозе", focus: true, follow: false },
    { value: "follow", text: "следить за целью", focus: false, follow: true },
    { value: "track", text: "вся трасса", focus: false, follow: false },
];
const viewOf = (focus: boolean | null, follow: boolean | null): ViewChoice =>
    VIEWS.find((v) => v.focus === focus && v.follow === follow) ?? (focus ? VIEWS[1] : follow ? VIEWS[2] : VIEWS[0]);

const emptyScenario: ScenarioEditModel = {
    oid: null, name: "", note: null, flightSource: "log", logName: null, sourceFileOID: null, trackRun: null, trackId: null, piece: null,
    models: [], mode: "full", speed: null, startScan: null, autoplay: true, pd: 1, radarLat: null, radarLon: null, radarAlt: null,
    basemap: null, horizons: null, layers: null, focus: null, follow: null,
};

const fromRow = (s: ScenarioRow): ScenarioEditModel => ({
    oid: s.oid, name: s.name, note: s.note, flightSource: s.flightSource, logName: s.logName, sourceFileOID: s.sourceFileOID,
    trackRun: s.trackRun, trackId: s.trackId, piece: s.piece, models: s.modelOIDs, mode: s.mode, speed: s.speed, startScan: s.startScan,
    autoplay: s.autoplay, pd: s.pd, radarLat: s.radarLat, radarLon: s.radarLon, radarAlt: s.radarAlt, basemap: s.basemap,
    horizons: s.horizons ? s.horizons.split(",").map(Number) : null, layers: s.layers ? s.layers.split(",") : null, focus: s.focus,
    follow: s.follow,
});

// откуда полёт строки справочника полётов: лог диплома, загруженный файл, траектория пакета
const sourceOf = (f: FlightRow): FlightSource => (f.kind === "track" ? "track" : f.origin === "manual" ? "upload" : "log");

// сценарий полями на своей странице (как FormView в ggnp.ofd.client): слева поля, справа действия
export default function ScenarioFormPage() {
    const navigate = useNavigate();
    const { oid } = useParams<{ oid: string }>();
    const isEdit = !!oid;

    const [flights, setFlights] = useState<FlightRow[] | null>(null);
    const [catalog, setCatalog] = useState<ModelRow[] | null>(null);
    const [values, setValues] = useState<ScenarioEditModel | null>(isEdit ? null : emptyScenario);
    const [saved, setSaved] = useState<ScenarioRow | null>(null);
    const [flightFilter, setFlightFilter] = useState("");
    const [modelFilter, setModelFilter] = useState("");
    const [busy, setBusy] = useState<string | null>(null);
    const [errors, setErrors] = useState<string[]>([]);

    useEffect(() => {
        flightsApi.list().then(setFlights).catch((e) => { setFlights([]); setErrors([getApiErrorMessage(e, "Полёты не загружены")]); });
        modelsApi.list().then(setCatalog).catch((e) => { setCatalog([]); setErrors([getApiErrorMessage(e, "Модели не загружены")]); });
        if (oid) {
            scenariosApi.get(oid)
                .then((s) => { setSaved(s); setValues(fromRow(s)); })
                .catch((e) => setErrors([getApiErrorMessage(e, "Сценарий не загружен")]));
        }
    }, [oid]);

    const set = (patch: Partial<ScenarioEditModel>) => setValues((prev) => (prev ? { ...prev, ...patch } : prev));

    const runnable = useMemo(() => (flights ?? []).filter((f) => (f.pieces ?? 0) > 0 && !f.error), [flights]);
    const flightList = useMemo(() => filterBy(runnable, { field: "fileName", operator: "contains", value: flightFilter, ignoreCase: true })
        .slice(0, FLIGHT_LIST_LIMIT), [runnable, flightFilter]);

    if (!values || !flights || !catalog) {
        return (
            <div className="radar-page">
                {errors.map((x) => <div key={x} className="radar-error">{x}</div>)}
                {!errors.length && <Loader />}
            </div>
        );
    }

    const flightKey = values.flightSource === "log" ? values.logName : values.flightSource === "upload" ? values.sourceFileOID
        : values.trackRun ? `${values.trackRun}/${values.trackId}` : null;
    const flight = runnable.find((f) => f.key === flightKey) ?? null;
    const selected = values.models.map((m) => catalog.find((x) => x.oid === m)).filter((m): m is ModelRow => !!m);
    const radarFile = flight?.kind === "radar";
    // без широты и долготы (траектория, файл отметок без координат РЛС) подложка - только плоскость
    const planeOnly = values.flightSource === "track" || (radarFile && (values.radarLat == null || values.radarLon == null));

    const chooseFlight = (f: FlightRow | null) => {
        if (!f) {
            set({ logName: null, sourceFileOID: null, trackRun: null, trackId: null, piece: null });
            return;
        }
        const source = sourceOf(f);
        set({
            flightSource: source,
            logName: source === "log" ? f.fileName : null,
            sourceFileOID: source === "upload" ? f.sourceFileOID : null,
            trackRun: source === "track" ? f.run : null,
            trackId: source === "track" ? f.trackId : null,
            piece: null,
            // у траектории нет широты и долготы - подложка только плоскость
            basemap: source === "track" && values.basemap && values.basemap !== "plane" ? "plane" : values.basemap,
            // у файла отметок вероятность не задаётся, у лога и траектории - координаты РЛС
            pd: f.kind === "radar" ? null : values.pd ?? 1,
            radarLat: f.kind === "radar" ? values.radarLat : null,
            radarLon: f.kind === "radar" ? values.radarLon : null,
            radarAlt: f.kind === "radar" ? values.radarAlt : null,
        });
    };

    const toggle = <T,>(list: T[] | null, item: T): T[] => (list?.includes(item) ? list.filter((x) => x !== item) : [...(list ?? []), item]);

    const save = async (then: "stay" | "close" | "run") => {
        setErrors([]);
        setBusy("Сохранение...");
        try {
            const row = await scenariosApi.save({ ...values, name: values.name.trim() });
            setSaved(row);
            setValues(fromRow(row));

            if (then === "close") {
                navigate(LIST_PATH);
                return;
            }
            if (then === "run") {
                setBusy(`Запуск сценария «${row.name}»...`);
                const started = await scenariosApi.run(row.oid);
                navigate(`/runs/${started.oid}?scenario=${row.oid}`);
                return;
            }
            if (!isEdit) navigate(`/scenarios/edit/${row.oid}`, { replace: true });
        }
        catch (e) {
            const list = getApiErrors(e);
            setErrors(list.length ? list : [getApiErrorMessage(e, "Сценарий не сохранён")]);
        }
        finally {
            setBusy(null);
        }
    };

    const remove = async () => {
        if (!saved || !window.confirm(`Удалить сценарий «${saved.name}»? Запуски по нему останутся в истории.`)) return;
        try {
            await scenariosApi.remove(saved.oid);
            navigate(LIST_PATH);
        }
        catch (e) {
            setErrors([getApiErrorMessage(e, "Сценарий не удалён")]);
        }
    };

    const flightText = (f: FlightRow) => [
        optionText(flightOriginOptions, f.origin), f.kind === "track" ? f.run : f.aircraft, f.detail, fmtDuration(f.durationS),
        (f.pieces ?? 0) > 1 ? `кусков ${f.pieces}` : null,
    ].filter(Boolean).join(", ");

    const ready = !busy && values.name.trim() !== "" && !!flight && selected.length > 0;

    return (
        <div className="radar-page">
            <div className="radar-formpage">
                <div className="radar-formpage__fields radar-form">
                    <h3 className="radar-page__title">Сценарий {isEdit ? "(модификация)" : "(создание)"}</h3>

                    <div>
                        <Label>Наименование</Label>
                        <TextBox value={values.name} maxLength={200} onChange={(e) => set({ name: String(e.value ?? "") })} />
                    </div>
                    <div>
                        <Label>Примечание</Label>
                        <TextArea rows={2} value={values.note ?? ""} onChange={(e) => set({ note: String(e.value ?? "") || null })} />
                    </div>

                    <h4>Полёт</h4>
                    <div>
                        <ComboBox data={flightList} textField="fileName" dataItemKey="key" value={flight} filterable
                            onFilterChange={(e) => setFlightFilter(e.filter.value)} placeholder="лог диплома, загруженный файл или траектория пакета"
                            onChange={(e) => chooseFlight(e.value as FlightRow | null)}
                            itemRender={(li, p) => ({ ...li, props: { ...li.props, children: (
                                <span className="radar-side__option">
                                    <span>{(p.dataItem as FlightRow).fileName}</span>
                                    <span className="radar-hint">{flightText(p.dataItem as FlightRow)}</span>
                                </span>
                            ) } })} />
                        {flight && <div className="radar-hint">{flightText(flight)}</div>}
                        {!flight && flightKey && <div className="radar-error">Полёта сценария {flightKey} нет среди тех, что можно запустить</div>}
                    </div>
                    {flight && (flight.pieces ?? 0) > 1 && (
                        <div>
                            <Label>Кусок лога</Label>
                            <DropDownList data={[null, ...Array.from({ length: flight.pieces ?? 0 }, (_, i) => i)]} value={values.piece}
                                onChange={(e) => set({ piece: e.value })}
                                itemRender={(li, p) => ({ ...li, props: { ...li.props, children: p.dataItem == null ? "все (реальное время - самый длинный)" : `кусок ${p.dataItem}` } })}
                                valueRender={(el) => ({ ...el, props: { ...el.props, children: values.piece == null ? "все (реальное время - самый длинный)" : `кусок ${values.piece}` } })} />
                        </div>
                    )}

                    <h4>Модели</h4>
                    <MultiSelect data={filterBy(catalog, { field: "name", operator: "contains", value: modelFilter, ignoreCase: true })}
                        textField="name" dataItemKey="oid" value={selected} filterable onFilterChange={(e) => setModelFilter(e.filter.value)}
                        placeholder="одна или несколько - сравнение на одной трассе" onChange={(e) => set({ models: (e.value as ModelRow[]).map((m) => m.oid) })} />

                    <h4>Режим</h4>
                    <RadioGroup data={MODES} value={values.mode} onChange={(e) => set({
                        mode: e.value as RunMode, speed: e.value === "realtime" ? values.speed ?? 1 : null, startScan: null,
                    })} />
                    {values.mode === "realtime" && (
                        <div className="radar-row">
                            <div>
                                <Label>Ускорение</Label>
                                <DropDownList data={SPEEDS} value={values.speed ?? 1} onChange={(e) => set({ speed: e.value })}
                                    itemRender={(li, p) => ({ ...li, props: { ...li.props, children: `x${p.dataItem}` } })}
                                    valueRender={(el) => ({ ...el, props: { ...el.props, children: `x${values.speed ?? 1}` } })} />
                            </div>
                            <div>
                                <Label>С обзора</Label>
                                <NumericTextBox value={values.startScan} min={0} format="n0" placeholder="0"
                                    onChange={(e) => set({ startScan: e.value })} />
                            </div>
                            <Checkbox label="пуск сразу" checked={values.autoplay} onChange={(e) => set({ autoplay: !!e.value })} />
                        </div>
                    )}

                    <h4>Условия РЛС</h4>
                    {!flight && <div className="radar-hint">Сначала выберите полёт.</div>}
                    {flight && !radarFile && (
                        <div>
                            <Label>Вероятность обнаружения цели РЛС за обзор</Label>
                            <NumericTextBox value={values.pd} min={0.05} max={1} step={0.05} format="n2" onChange={(e) => set({ pd: e.value })} />
                            <div className="radar-hint">Отметки РЛС моделирует код диплома: 1 - отметка на каждом обзоре, 0,9 - каждая
                                десятая пропущена.</div>
                        </div>
                    )}
                    {flight && radarFile && (
                        <div>
                            <Label>Где стоит РЛС (для показа на карте)</Label>
                            <div className="radar-row">
                                <NumericTextBox placeholder="широта" value={values.radarLat} format="n6" onChange={(e) => set({ radarLat: e.value })} />
                                <NumericTextBox placeholder="долгота" value={values.radarLon} format="n6" onChange={(e) => set({ radarLon: e.value })} />
                                <NumericTextBox placeholder="высота, м" value={values.radarAlt} format="n1" onChange={(e) => set({ radarAlt: e.value })} />
                            </div>
                            <div className="radar-hint">Необязательно: без координат - только плоскость, прогноз и ошибки от них не зависят.
                                Высота - только вместе с широтой и долготой. Пропуски отметок - уже в файле.</div>
                        </div>
                    )}

                    <h4>Вид карты (необязательно)</h4>
                    <div className="radar-row">
                        <div>
                            <Label>Подложка</Label>
                            <DropDownList data={planeOnly ? BASEMAPS.filter((b) => b.value == null || b.value === "plane") : BASEMAPS}
                                textField="text" dataItemKey="text" value={BASEMAPS.find((b) => b.value === values.basemap)}
                                onChange={(e) => set({ basemap: e.value.value })} />
                        </div>
                        <div>
                            <Label>Вид</Label>
                            <DropDownList data={VIEWS} textField="text" dataItemKey="text" value={viewOf(values.focus, values.follow)}
                                onChange={(e) => set({ focus: (e.value as ViewChoice).focus, follow: (e.value as ViewChoice).follow })} />
                        </div>
                    </div>
                    <div>
                        <Checkbox label="задать горизонты" checked={values.horizons != null}
                            onChange={(e) => set({ horizons: e.value ? [HORIZONS_S[HORIZONS_S.length - 1]] : null })} />
                        {values.horizons != null && (
                            <div className="radar-row">
                                {HORIZONS_S.map((h) => (
                                    <Checkbox key={h} label={`${h} с`} checked={values.horizons!.includes(h)}
                                        onChange={() => set({ horizons: toggle(values.horizons, h) })} />
                                ))}
                            </div>
                        )}
                    </div>
                    <div>
                        <Checkbox label="задать слои" checked={values.layers != null}
                            onChange={(e) => set({ layers: e.value ? ["plots", "truth", "phases", "gate"] : null })} />
                        {values.layers != null && (
                            <div className="radar-row">
                                {LAYERS.map((l) => (
                                    <Checkbox key={l} label={layerTitle[l]} checked={values.layers!.includes(l)}
                                        onChange={() => set({ layers: toggle(values.layers, l) })} />
                                ))}
                            </div>
                        )}
                    </div>
                    <div className="radar-hint">Не заданное в сценарии остаётся, как выбрал зритель в панели запуска. У траектории
                        пакета подложка - только плоскость.</div>
                </div>

                <aside className="radar-formpage__actions">
                    {saved && (
                        <div className="radar-hint">Создан {new Date(saved.created).toLocaleString("ru-RU")}; запусков {saved.runCount}.</div>
                    )}
                    <Button themeColor="primary" svgIcon={saveIcon} disabled={!ready} onClick={() => save("stay")}>Сохранить</Button>
                    <Button svgIcon={checkIcon} disabled={!ready} onClick={() => save("close")}>Сохранить и закрыть</Button>
                    <Button svgIcon={playIcon} disabled={!ready} onClick={() => save("run")}>Сохранить и запустить</Button>
                    <Button svgIcon={cancelIcon} onClick={() => navigate(LIST_PATH)}>Отмена</Button>
                    {isEdit && <Button themeColor="error" fillMode="outline" svgIcon={trashIcon} disabled={!!busy} onClick={remove}>Удалить</Button>}
                    {busy && <div className="radar-row"><Loader size="small" /> <span className="radar-hint">{busy}</span></div>}
                    {errors.length > 0 && (
                        <div className="radar-error">
                            <ul className="radar-errors">{errors.map((x) => <li key={x}>{x}</li>)}</ul>
                        </div>
                    )}
                    {!ready && !busy && <div className="radar-hint">Нужны наименование, полёт и хотя бы одна модель.</div>}
                </aside>
            </div>
        </div>
    );
}
