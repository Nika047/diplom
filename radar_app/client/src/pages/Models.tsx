import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@progress/kendo-react-buttons";
import { Dialog, DialogActionsBar } from "@progress/kendo-react-dialogs";
import { Grid, GridColumn } from "@progress/kendo-react-grid";
import type { GridCustomCellProps } from "@progress/kendo-react-grid";
import { Checkbox, TextArea, TextBox } from "@progress/kendo-react-inputs";
import { Label } from "@progress/kendo-react-labels";
import { Loader } from "@progress/kendo-react-indicators";
import { Upload } from "@progress/kendo-react-upload";
import type { UploadFileInfo } from "@progress/kendo-react-upload";
import { pencilIcon, trashIcon } from "@progress/kendo-svg-icons";

import GridToolbar from "../components/GridToolbar";
import { ColumnMenu, DateCell, makeEnumCell, makeEnumColumnMenu, useGridState } from "../components/gridColumns";
import type { ForecastKind, ModelRow } from "../data/dataModel";
import { dopplerCaseOptions, forecastKindOptions, optionText } from "../data/enums";
import { modelsApi } from "../services/api";
import { getApiErrorMessage } from "../helpers/apiError";

const CaseCell = makeEnumCell(dopplerCaseOptions);
const CaseMenu = makeEnumColumnMenu(dopplerCaseOptions);
const SourceMenu = makeEnumColumnMenu([{ value: true, text: "диплом" }, { value: false, text: "загружена" }]);
const SourceCell = makeEnumCell([{ value: true, text: "диплом" }, { value: false, text: "загружена" }]);

// строка таблицы: дата - для фильтра колонки
interface ModelGridRow extends ModelRow {
    createdAt: Date;
}

const SeedsCell = (props: GridCustomCellProps) => {
    const r = props.dataItem as ModelRow;
    return <td {...props.tdProps}>{r.kind === "imm" ? "-" : r.seeds ?? (r.kind === "ens" ? "все" : "первый")}</td>;
};

// как у сервера (ModelsController.MaxZipSize)
const MAX_ZIP_SIZE = 500 * 1024 * 1024;

// окно добавления: zip с папкой пакета (config.json и веса .pt, формат этапа 11 диплома), наименование, примечание, виды
function AddModelDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
    const [files, setFiles] = useState<UploadFileInfo[]>([]);
    const [name, setName] = useState("");
    const [note, setNote] = useState("");
    const [kinds, setKinds] = useState<Set<ForecastKind>>(new Set(["hyb"]));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const file = files[0];
    const ready = !!file && !file.validationErrors?.length && name.trim() !== "" && kinds.size > 0 && !busy;

    const toggle = (k: ForecastKind) => setKinds((prev) => {
        const next = new Set(prev);
        if (next.has(k)) next.delete(k);
        else next.add(k);
        return next;
    });

    const save = async () => {
        const raw = file?.getRawFile?.();
        if (!raw) return;
        setBusy(true);
        setError(null);
        try {
            await modelsApi.upload(raw, name.trim(), note.trim(), forecastKindOptions.map((o) => o.value).filter((k) => kinds.has(k)));
            onAdded();
        }
        catch (e) {
            setError(getApiErrorMessage(e, "Пакет не загружен"));
            setBusy(false);
        }
    };

    return (
        <Dialog title="Добавить модель" onClose={onClose} width={600}>
            <div className="radar-form">
                <Upload autoUpload={false} showActionButtons={false} multiple={false} files={files}
                    restrictions={{ allowedExtensions: [".zip"], maxFileSize: MAX_ZIP_SIZE }}
                    onAdd={(e) => setFiles(e.newState)} onRemove={(e) => setFiles(e.newState)} />
                <div className="radar-hint">Архив zip с папкой пакета модели: config.json и веса сетей (.pt), как в
                    bundles диплома. Пакет проверяет движок: читаются config.json и веса всех сетей.</div>
                <div>
                    <Label>Наименование</Label>
                    <TextBox value={name} onChange={(e) => setName(String(e.value ?? ""))} />
                </div>
                <div>
                    <Label>Примечание</Label>
                    <TextArea rows={3} value={note} onChange={(e) => setNote(String(e.value ?? ""))}
                        placeholder="Что это за модель, из чего сформирована. Пусто - описание вида" />
                </div>
                <div>
                    <Label>Виды прогноза (по модели на каждый)</Label>
                    <div className="radar-row">
                        <Checkbox label="IMM - фильтр с параметрами пакета" checked={kinds.has("imm")} onChange={() => toggle("imm")} />
                        <Checkbox label="гибрид - одна сеть" checked={kinds.has("hyb")} onChange={() => toggle("hyb")} />
                        <Checkbox label="ансамбль - среднее всех сетей" checked={kinds.has("ens")} onChange={() => toggle("ens")} />
                    </div>
                </div>
                {error && <div className="radar-error">{error}</div>}
            </div>
            <DialogActionsBar>
                <Button onClick={onClose}>Отмена</Button>
                <Button themeColor="primary" disabled={!ready} onClick={save}>{busy ? <Loader size="small" /> : "Добавить"}</Button>
            </DialogActionsBar>
        </Dialog>
    );
}

function EditModelDialog({ model, onClose, onSaved }: { model: ModelRow; onClose: () => void; onSaved: () => void }) {
    const [name, setName] = useState(model.name);
    const [note, setNote] = useState(model.note ?? "");
    const [error, setError] = useState<string | null>(null);

    const save = async () => {
        try {
            await modelsApi.update(model.oid, name.trim(), note.trim());
            onSaved();
        }
        catch (e) {
            setError(getApiErrorMessage(e, "Модель не сохранена"));
        }
    };

    return (
        <Dialog title="Модель" onClose={onClose} width={600}>
            <div className="radar-form">
                <div>
                    <Label>Наименование</Label>
                    <TextBox value={name} onChange={(e) => setName(String(e.value ?? ""))} />
                </div>
                <div>
                    <Label>Примечание</Label>
                    <TextArea rows={4} value={note} onChange={(e) => setNote(String(e.value ?? ""))} />
                </div>
                <div className="radar-hint">Пакет: {model.bundle}; {optionText(forecastKindOptions, model.kind)},
                    {" "}{optionText(dopplerCaseOptions, model.case)}{model.label ? `, ${model.label}` : ""}.</div>
                {error && <div className="radar-error">{error}</div>}
            </div>
            <DialogActionsBar>
                <Button onClick={onClose}>Отмена</Button>
                <Button themeColor="primary" disabled={!name.trim()} onClick={save}>Сохранить</Button>
            </DialogActionsBar>
        </Dialog>
    );
}

// справочник моделей: модели диплома (заводятся сервером из пакетов) и загруженные пакеты
export default function ModelsPage() {
    const [rows, setRows] = useState<ModelRow[] | null>(null);
    const [search, setSearch] = useState("");
    const [adding, setAdding] = useState(false);
    const [editing, setEditing] = useState<ModelRow | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(() => {
        setError(null);
        modelsApi.list().then(setRows).catch((e) => { setRows([]); setError(getApiErrorMessage(e)); });
    }, []);

    useEffect(load, [load]);

    const shown = useMemo<ModelGridRow[]>(() => {
        const text = search.trim().toLowerCase();
        return (rows ?? [])
            .filter((r) => !text || r.name.toLowerCase().includes(text) || (r.note ?? "").toLowerCase().includes(text)
                || r.bundle.toLowerCase().includes(text) || r.composition.toLowerCase().includes(text))
            .map((r) => ({ ...r, createdAt: new Date(r.created) }));
    }, [rows, search]);

    const { data, gridProps } = useGridState(shown);

    // вид входных данных - прогон диплома: фильтр выпадающим списком из прогонов справочника
    const RunMenu = useMemo(() => makeEnumColumnMenu([...new Set((rows ?? []).map((r) => r.runTitle))].sort()
        .map((t) => ({ value: t, text: t }))), [rows]);
    // вид модели: IMM, гибрид, сеть без IMM, фильтр Калмана, линейная экстраполяция, жадный ансамбль
    const TypeMenu = useMemo(() => makeEnumColumnMenu([...new Set((rows ?? []).map((r) => r.typeTitle))].sort()
        .map((t) => ({ value: t, text: t }))), [rows]);

    const remove = async (r: ModelRow) => {
        if (!window.confirm(`Удалить модель «${r.name}»?`)) return;
        try {
            await modelsApi.remove(r.oid);
            load();
        }
        catch (e) {
            setError(getApiErrorMessage(e, "Модель не удалена"));
        }
    };

    const CommandCell = (props: GridCustomCellProps) => {
        const r = props.dataItem as ModelRow;
        const cannotDelete = r.fromDiplom ? "Модели диплома не удаляются: они заводятся из пакетов диплома"
            : r.runCount > 0 ? "По модели есть запуски - сначала удалите их в истории" : undefined;
        return (
            <td {...props.tdProps}>
                <Button fillMode="flat" themeColor="primary" svgIcon={pencilIcon} title="Изменить наименование и примечание"
                    onClick={() => setEditing(r)} />
                <Button fillMode="flat" themeColor="error" svgIcon={trashIcon} disabled={!!cannotDelete} title={cannotDelete ?? "Удалить"}
                    onClick={() => remove(r)} />
            </td>
        );
    };

    return (
        <div className="radar-page radar-page--fill">
            <GridToolbar title="Модели" search={search} onSearch={setSearch} onCreate={() => setAdding(true)} onLoad={load}
                count={{ shown: data.length, total: rows?.length ?? 0 }} />
            {error && <div className="radar-error">{error}</div>}
            {rows == null ? <Loader /> : (
                <Grid data={data} className="radar-grid--fill" {...gridProps} onRowDoubleClick={(e) => setEditing(e.dataItem as ModelRow)}>
                    <GridColumn field="name" title="Наименование" width={380} columnMenu={ColumnMenu} />
                    <GridColumn field="runTitle" title="Данные обучения" width={300} columnMenu={RunMenu} />
                    <GridColumn field="typeTitle" title="Вид" width={190} columnMenu={TypeMenu} />
                    <GridColumn field="case" title="Случай доплера" width={190} cells={{ data: CaseCell }} columnMenu={CaseMenu} />
                    <GridColumn field="seeds" title="Seed" width={100} cells={{ data: SeedsCell }} columnMenu={ColumnMenu} />
                    <GridColumn field="composition" title="Состав" width={520} columnMenu={ColumnMenu} />
                    <GridColumn field="note" title="Примечание" width={520} columnMenu={ColumnMenu} />
                    <GridColumn field="bundle" title="Пакет" width={300} columnMenu={ColumnMenu} />
                    <GridColumn field="fromDiplom" title="Откуда" width={120} cells={{ data: SourceCell }} columnMenu={SourceMenu} />
                    <GridColumn field="runCount" title="Запусков" width={110} filter="numeric" columnMenu={ColumnMenu} />
                    <GridColumn field="createdAt" title="Добавлена" width={170} filter="date" cells={{ data: DateCell }} columnMenu={ColumnMenu} />
                    <GridColumn title="" width={100} locked sortable={false} filterable={false} cells={{ data: CommandCell }} />
                </Grid>
            )}
            <div className="radar-hint">IMM - фильтр без поправки сети (база для сравнения); гибрид - прогноз IMM и поправка одной
                нейросети: у моделей диплома по модели на каждый seed (сети одного устройства, обученные с разным начальным
                случайным числом); ансамбль - среднее поправок всех сетей пакета. Для сравнения есть и модели без IMM:
                линейная экстраполяция и фильтр Калмана (без сети), сеть без IMM, жадный ансамбль этапа 8. «Данные обучения» - прогон диплома: base -
                сгенерированные траектории только в обучении, merged - во всех выборках; x1 - объём сгенерированных траекторий.
                «Состав» - из config.json пакета. Двойной щелчок - изменить наименование и примечание (после правки модель диплома
                больше не обновляется из пакета).</div>
            {adding && <AddModelDialog onClose={() => setAdding(false)} onAdded={() => { setAdding(false); load(); }} />}
            {editing && <EditModelDialog model={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
        </div>
    );
}
