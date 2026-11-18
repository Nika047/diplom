import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button, ButtonGroup } from "@progress/kendo-react-buttons";
import { Dialog, DialogActionsBar } from "@progress/kendo-react-dialogs";
import { Grid, GridColumn } from "@progress/kendo-react-grid";
import type { GridCustomCellProps } from "@progress/kendo-react-grid";
import { Checkbox, RadioGroup } from "@progress/kendo-react-inputs";
import { Loader } from "@progress/kendo-react-indicators";
import { Upload } from "@progress/kendo-react-upload";
import type { UploadFileInfo } from "@progress/kendo-react-upload";
import { playIcon, trashIcon } from "@progress/kendo-svg-icons";

import GridToolbar from "../components/GridToolbar";
import { ColumnMenu, DateCell, makeEnumCell, makeEnumColumnMenu, useGridState } from "../components/gridColumns";
import type { EnumOption } from "../components/gridColumns";
import type { FlightRow, SourceKind } from "../data/dataModel";
import { flightOriginOptions, sourceKindOptions, splitTitle } from "../data/enums";
import { flightsApi, sourceFilesApi } from "../services/api";
import { getApiErrorMessage } from "../helpers/apiError";
import { fmtDuration, fmtSize } from "../helpers/format";

// строка таблицы: даты и длительность - для фильтров колонок (дата, минуты); выборка прогона - поле split_<прогон>
interface FlightGridRow extends FlightRow {
    createdAt: Date | null;
    durationMin: number | null;
    splitOwn: string | null; // выборка траектории в её прогоне
    [split: `split_${string}`]: string | null;
}

// что показывает таблица: логи диплома и загруженные файлы или траектории пакетов прогонов
type FlightsView = "logs" | "tracks";

// адрес запуска с выбранным полётом (RunPage: ?log, ?file, ?track)
export const flightRunPath = (r: FlightRow): string => (r.kind === "track" ? `/runs?track=${encodeURIComponent(r.key)}`
    : r.origin === "manual" ? `/runs?file=${r.sourceFileOID}` : `/runs?log=${encodeURIComponent(r.fileName)}`);

const textCell = (text: (row: FlightGridRow) => string, hint?: (row: FlightGridRow) => string | undefined) => (props: GridCustomCellProps) => {
    const row = props.dataItem as FlightGridRow;
    return <td {...props.tdProps} title={hint?.(row)}>{text(row)}</td>;
};

const SPLIT_OPTIONS: EnumOption[] = Object.entries(splitTitle).map(([value, text]) => ({ value, text }));

const KindCell = makeEnumCell(sourceKindOptions);
const OriginCell = makeEnumCell(flightOriginOptions);
const SplitCell = makeEnumCell(SPLIT_OPTIONS);
const KindMenu = makeEnumColumnMenu(sourceKindOptions);
const OriginMenu = makeEnumColumnMenu(flightOriginOptions);
const SplitMenu = makeEnumColumnMenu(SPLIT_OPTIONS);

const DetailCell = textCell((r) => r.detail ?? "-", (r) => (r.origin === "aug" ? "вид расширения: speed - скорость, radar - другое место РЛС, ..." : undefined));

const PiecesCell = textCell((r) => (r.error ? "-" : r.pieces === 0 ? "0, запускать нечего" : String(r.pieces ?? "-")),
    (r) => r.error ?? (r.pieces === 0 ? "После очистки лога (стоянка, скачки, короткие участки) не осталось ни одного куска" : undefined));
const DurationCell = textCell((r) => fmtDuration(r.durationS));
const SizeCell = textCell((r) => fmtSize(r.size));

// как у сервера (SourceFilesController.MaxFileSize)
const MAX_FILE_SIZE = 50 * 1024 * 1024;

const UPLOAD_KINDS = [
    { value: "log", label: "лог полёта (EdgeTX / OpenTX): отметки РЛС смоделирует движок" },
    { value: "radar", label: "отметки РЛС: t, range_m, az_deg, el_deg[, vr_mps], шаг 2 с" },
];

// окно добавления: файл перетащить или выбрать в папке (Upload, как FormUpload в ggnp.ofd.client), указать вид
function AddFlightDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
    const [files, setFiles] = useState<UploadFileInfo[]>([]);
    const [kind, setKind] = useState<SourceKind>("log");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const file = files[0];
    const invalid = !!file?.validationErrors?.length;

    const save = async () => {
        const raw = file?.getRawFile?.();
        if (!raw) return;
        setBusy(true);
        setError(null);
        try {
            await sourceFilesApi.upload(raw, kind);
            onAdded();
        }
        catch (e) {
            setError(getApiErrorMessage(e, "Файл не загружен"));
            setBusy(false);
        }
    };

    return (
        <Dialog title="Добавить полёт" onClose={onClose} width={560}>
            <div className="radar-form">
                <Upload autoUpload={false} showActionButtons={false} multiple={false} files={files}
                    restrictions={{ allowedExtensions: [".csv"], maxFileSize: MAX_FILE_SIZE }}
                    onAdd={(e) => setFiles(e.newState)} onRemove={(e) => setFiles(e.newState)} />
                <RadioGroup data={UPLOAD_KINDS} value={kind} onChange={(e) => setKind(e.value as SourceKind)} />
                {error && <div className="radar-error">{error}</div>}
            </div>
            <DialogActionsBar>
                <Button onClick={onClose}>Отмена</Button>
                <Button themeColor="primary" disabled={!file || invalid || busy} onClick={save}>
                    {busy ? <Loader size="small" /> : "Добавить"}
                </Button>
            </DialogActionsBar>
        </Dialog>
    );
}

// справочник полётов: логи диплома и загруженные файлы; запуск - из колонки действий
export default function FlightsPage() {
    const navigate = useNavigate();
    const [rows, setRows] = useState<FlightRow[] | null>(null);
    const [search, setSearch] = useState("");
    const [showEmpty, setShowEmpty] = useState(false);
    const [view, setView] = useState<FlightsView>("logs");
    const [adding, setAdding] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(() => {
        setError(null);
        flightsApi.list().then(setRows).catch((e) => { setRows([]); setError(getApiErrorMessage(e)); });
    }, []);

    useEffect(load, [load]);

    const runnable = (r: FlightRow) => !r.error && (r.pieces ?? 0) > 0;

    // прогоны диплома с выборками: колонка выборки на каждый
    const runs = useMemo(() => [...new Set((rows ?? []).flatMap((r) => Object.keys(r.splits ?? {})))].sort(), [rows]);

    // строки выбранного списка (логи и файлы или траектории) до поиска и фильтров колонок
    const listed = useMemo(() => (rows ?? [])
        .filter((r) => (view === "tracks") === (r.kind === "track"))
        .filter((r) => showEmpty || runnable(r)), [rows, view, showEmpty]);

    const shown = useMemo<FlightGridRow[]>(() => {
        const text = search.trim().toLowerCase();
        return listed
            .filter((r) => !text || r.fileName.toLowerCase().includes(text) || (r.aircraft ?? "").toLowerCase().includes(text)
                || (r.detail ?? "").toLowerCase().includes(text))
            .map((r) => ({
                ...r,
                ...Object.fromEntries(runs.map((run) => [`split_${run}`, r.splits?.[run] ?? null])),
                splitOwn: r.run ? r.splits?.[r.run] ?? null : null,
                createdAt: r.created ? new Date(r.created) : null,
                durationMin: r.durationS == null ? null : Math.round(r.durationS / 6) / 10,
            }) as FlightGridRow);
    }, [listed, search, runs]);

    const { data, gridProps } = useGridState(shown);

    const run = (r: FlightRow) => navigate(flightRunPath(r));

    const remove = async (r: FlightRow) => {
        if (!window.confirm(`Удалить файл ${r.fileName}?`)) return;
        try {
            await sourceFilesApi.remove(r.sourceFileOID!);
            load();
        }
        catch (e) {
            setError(getApiErrorMessage(e, "Файл не удален"));
        }
    };

    const CommandCell = (props: GridCustomCellProps) => {
        const r = props.dataItem as FlightGridRow;
        const cannotDelete = r.runCount > 0 ? "По файлу есть запуски - сначала удалите их в истории" : undefined;
        return (
            <td {...props.tdProps}>
                {runnable(r) && <Button fillMode="flat" themeColor="primary" svgIcon={playIcon} title="Запустить прогноз" onClick={() => run(r)} />}
                {r.origin === "manual" && (
                    <Button fillMode="flat" themeColor="error" svgIcon={trashIcon} disabled={!!cannotDelete} title={cannotDelete ?? "Удалить"}
                        onClick={() => remove(r)} />
                )}
            </td>
        );
    };

    const all = rows ?? [];
    const tracks = all.filter((r) => r.kind === "track");
    const diplom = all.filter((r) => r.origin === "real" || r.origin === "sim");
    const diplomRunnable = diplom.filter(runnable);
    const inSplits = diplomRunnable.filter((r) => Object.values(r.splits ?? {}).some((s) => s === "train" || s === "val" || s === "test")).length;
    const uploaded = all.filter((r) => r.origin === "manual").length;
    const splitColumns = runs.map((run) => (
        <GridColumn key={run} field={`split_${run}`} title={`Выборка ${run}`} width={170} cells={{ data: SplitCell }} columnMenu={SplitMenu} />
    ));

    return (
        <div className="radar-page radar-page--fill">
            <GridToolbar title="Полёты" search={search} onSearch={setSearch} onCreate={() => setAdding(true)} onLoad={load}
                count={{ shown: data.length, total: listed.length }}
                options={(
                    <>
                        <ButtonGroup>
                            <Button togglable selected={view === "logs"} onClick={() => setView("logs")}>логи и файлы ({all.length - tracks.length})</Button>
                            <Button togglable selected={view === "tracks"} onClick={() => setView("tracks")}>траектории пакетов ({tracks.length})</Button>
                        </ButtonGroup>
                        {view === "logs" && <Checkbox label={`показать логи без кусков (${diplom.length - diplomRunnable.length})`}
                            checked={showEmpty} onChange={(e) => setShowEmpty(!!e.value)} />}
                    </>
                )} />
            {error && <div className="radar-error">{error}</div>}
            {rows == null ? <Loader /> : view === "logs" ? (
                <Grid key="logs" data={data} className="radar-grid--fill" {...gridProps}>
                    <GridColumn field="fileName" title="Файл" width={300} columnMenu={ColumnMenu} />
                    <GridColumn field="aircraft" title="Аппарат" width={130} columnMenu={ColumnMenu} />
                    <GridColumn field="origin" title="Источник" width={160} cells={{ data: OriginCell }} columnMenu={OriginMenu} />
                    <GridColumn field="kind" title="Вид" width={130} cells={{ data: KindCell }} columnMenu={KindMenu} />
                    {splitColumns}
                    <GridColumn field="pieces" title="Кусков" width={150} filter="numeric" cells={{ data: PiecesCell }} columnMenu={ColumnMenu} />
                    <GridColumn field="durationMin" title="Длительность" width={150} filter="numeric" cells={{ data: DurationCell }} columnMenu={ColumnMenu} />
                    <GridColumn field="rows" title="Записей в логе" width={150} filter="numeric" columnMenu={ColumnMenu} />
                    <GridColumn field="size" title="Размер" width={110} filter="numeric" cells={{ data: SizeCell }} columnMenu={ColumnMenu} />
                    <GridColumn field="runCount" title="Запусков" width={110} filter="numeric" columnMenu={ColumnMenu} />
                    <GridColumn field="createdAt" title="Добавлен" width={170} filter="date" cells={{ data: DateCell }} columnMenu={ColumnMenu} />
                    <GridColumn title="" width={100} locked sortable={false} filterable={false} cells={{ data: CommandCell }} />
                </Grid>
            ) : (
                <Grid key="tracks" data={data} className="radar-grid--fill" {...gridProps}>
                    <GridColumn field="fileName" title="Траектория" width={330} columnMenu={ColumnMenu} />
                    <GridColumn field="run" title="Прогон" width={120} columnMenu={ColumnMenu} />
                    <GridColumn field="origin" title="Источник" width={160} cells={{ data: OriginCell }} columnMenu={OriginMenu} />
                    <GridColumn field="detail" title="Сценарий / расширение" width={200} cells={{ data: DetailCell }} columnMenu={ColumnMenu} />
                    <GridColumn field="splitOwn" title="Выборка" width={190} cells={{ data: SplitCell }} columnMenu={SplitMenu} />
                    <GridColumn field="aircraft" title="Исходный лог" width={260} columnMenu={ColumnMenu} />
                    <GridColumn field="durationMin" title="Длительность" width={150} filter="numeric" cells={{ data: DurationCell }} columnMenu={ColumnMenu} />
                    <GridColumn field="rows" title="Точек" width={110} filter="numeric" columnMenu={ColumnMenu} />
                    <GridColumn field="runCount" title="Запусков" width={110} filter="numeric" columnMenu={ColumnMenu} />
                    <GridColumn title="" width={70} locked sortable={false} filterable={false} cells={{ data: CommandCell }} />
                </Grid>
            )}
            {view === "logs" ? (
                <div className="radar-hint">
                    В flight_logs диплома {diplom.length} логов; запустить можно {diplomRunnable.length}: {inSplits} реальных полётов из
                    выборок диплома (обучение, валидация, тест), остальные - исключённые из выборок и симулятор. У остальных
                    {" "}{diplom.length - diplomRunnable.length} после очистки (стоянка, скачки, короткие записи) ничего не остаётся.
                    Загружено вручную: {uploaded}. Длительность - сумма кусков после очистки (фильтр - в минутах);
                    записей в логе - строк телеметрии (точек GPS), не обзоров РЛС. Выборка - разбиение диплома в каждом прогоне
                    (bundles/&lt;прогон&gt;/splits.json): base - сгенерированные траектории только в обучении, merged - во всех выборках.
                </div>
            ) : (
                <div className="radar-hint">
                    Траектории из пакетов прогонов диплома (bundles/&lt;прогон&gt;/tracks): сгенерированные генератором (сценарий -
                    прямая, разворот, змейка, ...) и расширения - копии реальных полётов обучения с изменением (скорость, место РЛС, ...).
                    У траекторий только метры от начала, без широты и долготы: прогноз показывается на плоскости вокруг РЛС, отметки
                    РЛС моделирует код диплома. Выборка «анализ» у base_x1 - траектории для анализа, в обучение не входят.
                </div>
            )}
            {adding && <AddFlightDialog onClose={() => setAdding(false)} onAdded={() => { setAdding(false); load(); }} />}
        </div>
    );
}
