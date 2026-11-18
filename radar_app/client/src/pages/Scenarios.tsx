import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@progress/kendo-react-buttons";
import { Dialog, DialogActionsBar } from "@progress/kendo-react-dialogs";
import { Grid, GridColumn } from "@progress/kendo-react-grid";
import type { GridCustomCellProps } from "@progress/kendo-react-grid";
import { Loader } from "@progress/kendo-react-indicators";
import { Upload } from "@progress/kendo-react-upload";
import type { UploadFileInfo } from "@progress/kendo-react-upload";
import { pencilIcon, playIcon, trashIcon, uploadIcon } from "@progress/kendo-svg-icons";

import GridToolbar from "../components/GridToolbar";
import { ColumnMenu, DateCell, makeEnumCell, makeEnumColumnMenu, useGridState } from "../components/gridColumns";
import type { ScenarioRow } from "../data/dataModel";
import { basemapTitle, flightSourceOptions, layerTitle, runModeOptions } from "../data/enums";
import { scenariosApi } from "../services/api";
import { getApiErrorMessage, getApiErrors } from "../helpers/apiError";
import { fmt } from "../helpers/format";

// полёт сценария одной строкой: лог, загруженный файл или траектория пакета, кусок
export const scenarioFlightText = (s: ScenarioRow): string =>
    (s.flightSource === "log" ? s.logName : s.flightSource === "upload" ? s.sourceFileName : `${s.trackRun}/${s.trackId}`)
    + (s.piece != null ? `, кусок ${s.piece}` : "");

// условия РЛС и режим одной строкой
export const scenarioRadarText = (s: ScenarioRow): string => (s.radarLat != null
    ? `РЛС ${fmt(s.radarLat, 5)}, ${fmt(s.radarLon, 5)}` : s.sourceFileKind === "radar" ? "отметки из файла" : `Pd ${fmt(s.pd ?? 1, 2)}`);

export const scenarioModeText = (s: ScenarioRow): string => (s.mode === "realtime"
    ? `реальное время x${s.speed ?? 1}${s.startScan ? `, с обзора ${s.startScan}` : ""}${s.autoplay ? "" : ", без пуска"}` : "прогон целиком");

// вид карты сценария: заданное в сценарии; остальное - как выбрал зритель
export const scenarioViewText = (s: ScenarioRow): string => [
    s.basemap ? basemapTitle[s.basemap] ?? s.basemap : null,
    s.horizons ? `горизонты ${s.horizons.split(",").join(", ")} с` : null,
    s.layers ? `слои: ${s.layers.split(",").map((l) => layerTitle[l] ?? l).join(", ")}` : null,
    s.focus ? "фокус на прогнозе" : null,
    s.follow ? "следить за целью" : null,
    s.focus === false && s.follow === false ? "вся трасса" : null,
].filter(Boolean).join("; ") || "как у зрителя";

// строка таблицы: тексты колонок и дата - для фильтров
interface ScenarioGridRow extends ScenarioRow {
    flight: string;
    radar: string;
    modeText: string;
    view: string;
    createdAt: Date;
}

const SourceCell = makeEnumCell(flightSourceOptions);
const SourceMenu = makeEnumColumnMenu(flightSourceOptions);
const ModeMenu = makeEnumColumnMenu(runModeOptions.filter((o) => o.value !== "compare"));

const SAMPLE = `{
  "format": "radar_app/scenario",
  "version": 1,
  "scenarios": [{
    "name": "Черника, гибрид и IMM",
    "flight": { "source": "log", "file": "Chernika-2025-05-09-152254.csv" },
    "models": ["merged_x1/dop_traj:imm", { "bundle": "merged_x1/dop_traj", "kind": "hyb", "members": [43] }],
    "mode": { "type": "realtime", "speed": 10 },
    "radar": { "pd": 0.9 },
    "view": { "basemap": "osm", "horizons_s": [2, 10], "layers": ["truth", "plots", "gate"], "focus": true }
  }]
}`;

// окно загрузки файла сценариев: все или ничего, ошибки - списком с путём поля
function UploadScenariosDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
    const [files, setFiles] = useState<UploadFileInfo[]>([]);
    const [busy, setBusy] = useState(false);
    const [errors, setErrors] = useState<string[]>([]);

    const file = files[0];

    const save = async () => {
        const raw = file?.getRawFile?.();
        if (!raw) return;
        setBusy(true);
        setErrors([]);
        try {
            await scenariosApi.upload(raw);
            onAdded();
        }
        catch (e) {
            const list = getApiErrors(e);
            setErrors(list.length ? list : [getApiErrorMessage(e, "Файл не загружен")]);
            setBusy(false);
        }
    };

    return (
        <Dialog title="Загрузить сценарии из файла" onClose={onClose} width={760}>
            <div className="radar-form">
                <Upload autoUpload={false} showActionButtons={false} multiple={false} files={files}
                    restrictions={{ allowedExtensions: [".json"], maxFileSize: 1024 * 1024 }}
                    onAdd={(e) => setFiles(e.newState)} onRemove={(e) => setFiles(e.newState)} />
                <div className="radar-hint">Файл JSON формата radar_app/scenario, версия 1: один или несколько сценариев. Модели -
                    «&lt;пакет&gt;:&lt;вид&gt;» или объект с seed (members); пакет - путь от bundles/ диплома, вид - imm, hyb, ens.
                    Полёт - лог диплома (log), загруженный файл (upload, по имени) или траектория пакета (track: run и id). При
                    любой ошибке ничего не сохраняется. Пример:</div>
                <pre className="radar-code">{SAMPLE}</pre>
                {errors.length > 0 && (
                    <div className="radar-error">
                        <div>Файл не загружен, ошибок {errors.length}:</div>
                        <ul className="radar-errors">{errors.map((x) => <li key={x}>{x}</li>)}</ul>
                    </div>
                )}
            </div>
            <DialogActionsBar>
                <Button onClick={onClose}>Отмена</Button>
                <Button themeColor="primary" disabled={!file || !!file.validationErrors?.length || busy} onClick={save}>
                    {busy ? <Loader size="small" /> : "Загрузить"}
                </Button>
            </DialogActionsBar>
        </Dialog>
    );
}

// сценарии: готовые наборы параметров запуска; создание и правка - на своей странице, загрузка - файлом, запуск - в историю
export default function ScenariosPage() {
    const navigate = useNavigate();
    const [rows, setRows] = useState<ScenarioRow[] | null>(null);
    const [search, setSearch] = useState("");
    const [uploading, setUploading] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(() => {
        setError(null);
        scenariosApi.list().then(setRows).catch((e) => { setRows([]); setError(getApiErrorMessage(e)); });
    }, []);

    useEffect(load, [load]);

    const shown = useMemo<ScenarioGridRow[]>(() => {
        const text = search.trim().toLowerCase();
        return (rows ?? [])
            .map((s) => ({ ...s, flight: scenarioFlightText(s), radar: scenarioRadarText(s), modeText: scenarioModeText(s),
                view: scenarioViewText(s), createdAt: new Date(s.created) }))
            .filter((s) => !text || [s.name, s.note ?? "", s.flight, s.models].some((x) => x.toLowerCase().includes(text)));
    }, [rows, search]);

    const { data, gridProps } = useGridState(shown);

    const run = async (s: ScenarioRow) => {
        setError(null);
        setBusy(`Запуск сценария «${s.name}»...`);
        try {
            const started = await scenariosApi.run(s.oid);
            navigate(`/runs/${started.oid}?scenario=${s.oid}`);
        }
        catch (e) {
            setError(getApiErrorMessage(e, "Сценарий не запущен"));
            setBusy(null);
        }
    };

    const remove = async (s: ScenarioRow) => {
        if (!window.confirm(`Удалить сценарий «${s.name}»? Запуски по нему останутся в истории.`)) return;
        try {
            await scenariosApi.remove(s.oid);
            load();
        }
        catch (e) {
            setError(getApiErrorMessage(e, "Сценарий не удалён"));
        }
    };

    const CommandCell = (props: GridCustomCellProps) => {
        const s = props.dataItem as ScenarioRow;
        return (
            <td {...props.tdProps}>
                <Button fillMode="flat" themeColor="primary" svgIcon={playIcon} title="Запустить" disabled={!!busy} onClick={() => run(s)} />
                <Button fillMode="flat" themeColor="primary" svgIcon={pencilIcon} title="Изменить" onClick={() => navigate(`/scenarios/edit/${s.oid}`)} />
                <Button fillMode="flat" themeColor="error" svgIcon={trashIcon} title="Удалить" onClick={() => remove(s)} />
            </td>
        );
    };

    return (
        <div className="radar-page radar-page--fill">
            <GridToolbar title="Сценарии" search={search} onSearch={setSearch} onCreate={() => navigate("/scenarios/create")} onLoad={load}
                count={{ shown: data.length, total: rows?.length ?? 0 }}
                extra={<Button svgIcon={uploadIcon} onClick={() => setUploading(true)}>Загрузить файл</Button>} />
            {error && <div className="radar-error">{error}</div>}
            {busy && <div className="radar-row"><Loader size="small" /> <span className="radar-hint">{busy}</span></div>}
            {rows == null ? <Loader /> : (
                <Grid data={data} className="radar-grid--fill" {...gridProps} onRowDoubleClick={(e) => navigate(`/scenarios/edit/${(e.dataItem as ScenarioRow).oid}`)}>
                    <GridColumn field="name" title="Наименование" width={280} columnMenu={ColumnMenu} />
                    <GridColumn field="flightSource" title="Полёт: откуда" width={170} cells={{ data: SourceCell }} columnMenu={SourceMenu} />
                    <GridColumn field="flight" title="Полёт" width={300} columnMenu={ColumnMenu} />
                    <GridColumn field="models" title="Модели" width={420} columnMenu={ColumnMenu} />
                    <GridColumn field="mode" title="Режим" width={150} cells={{ data: makeEnumCell(runModeOptions) }} columnMenu={ModeMenu} />
                    <GridColumn field="modeText" title="Режим подробно" width={230} columnMenu={ColumnMenu} />
                    <GridColumn field="radar" title="Условия РЛС" width={170} columnMenu={ColumnMenu} />
                    <GridColumn field="view" title="Вид карты" width={300} columnMenu={ColumnMenu} />
                    <GridColumn field="note" title="Примечание" width={300} columnMenu={ColumnMenu} />
                    <GridColumn field="runCount" title="Запусков" width={110} filter="numeric" columnMenu={ColumnMenu} />
                    <GridColumn field="createdAt" title="Создан" width={170} filter="date" cells={{ data: DateCell }} columnMenu={ColumnMenu} />
                    <GridColumn title="" width={140} locked sortable={false} filterable={false} cells={{ data: CommandCell }} />
                </Grid>
            )}
            <div className="radar-hint">Сценарий - готовый набор параметров запуска: полёт, модели, режим, условия РЛС и, по желанию,
                вид карты. Запуск сценария пишется в историю запусков с его наименованием; в панели запуска сценарий можно выбрать
                и поменять поля перед запуском. «Добавить» - сценарий полями на странице, «Загрузить файл» - сценарии из JSON.
                Двойной щелчок - изменить.</div>
            {uploading && <UploadScenariosDialog onClose={() => setUploading(false)} onAdded={() => { setUploading(false); load(); }} />}
        </div>
    );
}
