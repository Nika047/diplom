import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@progress/kendo-react-buttons";
import { Grid, GridColumn } from "@progress/kendo-react-grid";
import type { GridCustomCellProps } from "@progress/kendo-react-grid";
import { eyeIcon, trashIcon } from "@progress/kendo-svg-icons";

import GridToolbar from "../components/GridToolbar";
import { ColumnMenu, DateCell, makeEnumCell, makeEnumColumnMenu, useGridState } from "../components/gridColumns";
import type { RunRow } from "../data/dataModel";
import { dopplerCaseOptions, optionText, runModeOptions, sourceKindOptions } from "../data/enums";
import { realtimeApi, runsApi } from "../services/api";
import { getApiErrorMessage } from "../helpers/apiError";
import { fmt, fmtChange, fmtDateTime } from "../helpers/format";

// ячейка с подписью вместо значения
const textCell = <T,>(text: (row: T) => string) => (props: GridCustomCellProps) => (
    <td {...props.tdProps}>{text(props.dataItem as T)}</td>
);

// модели запуска: перечень из записи (у старых сравнений - число моделей), у старых одиночных -
// IMM и гибрид случая
const modelsText = (r: RunRow): string => (r.modelOIDs.length || r.mode === "compare" ? r.model ?? ""
    : `IMM и ${r.model ?? "гибрид"}${r.ensemble ? ", ансамбль" : ""}, ${optionText(dopplerCaseOptions, r.case)}`);

// строка таблицы: дата, подпись моделей и время расчёта - для фильтров колонок
interface RunGridRow extends RunRow {
    createdAt: Date;
    models: string;
    durationS: number;
}

const KindCell = makeEnumCell(sourceKindOptions);
const KindMenu = makeEnumColumnMenu(sourceKindOptions);
const ModeMenu = makeEnumColumnMenu(runModeOptions);
const PdCell = textCell<RunRow>((r) => (r.pd == null ? "-" : fmt(r.pd, 2)));
const AdeImmCell = textCell<RunRow>((r) => fmt(r.adeImm));
const AdeHybCell = textCell<RunRow>((r) => fmt(r.adeHyb));
const AdeModelCell = textCell<RunRow>((r) => (r.adeHyb == null ? "-" : r.adeModel ?? "гибрид"));
const ChangeCell = textCell<RunRow>((r) => fmtChange(r.adeImm, r.adeHyb));
const DurationCell = textCell<RunRow>((r) => fmt(r.durationMs / 1000, 2));

const runPath = (r: RunRow) => `/runs/${r.oid}`;

// история запусков: открыть - двойной щелчок по строке или кнопка в колонке действий
export default function RunsPage() {
    const navigate = useNavigate();
    const [rows, setRows] = useState<RunRow[]>([]);
    const [open, setOpen] = useState<Set<string>>(new Set());
    const [search, setSearch] = useState("");
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(() => {
        setError(null);
        runsApi.list().then(setRows).catch((e) => setError(getApiErrorMessage(e)));
        realtimeApi.list().then((sessions) => setOpen(new Set(sessions.map((s) => s.oid)))).catch(() => { });
    }, []);

    useEffect(load, [load]);

    const shown = useMemo<RunGridRow[]>(() => {
        const text = search.trim().toLowerCase();
        return rows
            .map((r) => ({ ...r, createdAt: new Date(r.created), models: modelsText(r), durationS: r.durationMs / 1000 }))
            .filter((r) => !text || r.fileName.toLowerCase().includes(text) || r.models.toLowerCase().includes(text));
    }, [rows, search]);

    const { data, gridProps } = useGridState(shown);

    const removeRun = async (row: RunRow) => {
        const active = open.has(row.oid) ? " Сессия реального времени ещё открыта - она будет закрыта." : "";
        if (!window.confirm(`Удалить запуск ${row.fileName} от ${fmtDateTime(row.created)}?${active}`)) return;
        try {
            await runsApi.remove(row.oid);
            load();
        }
        catch (e) {
            setError(getApiErrorMessage(e));
        }
    };

    // строки реального времени: открытая сессия - «идёт», число обзоров записывается при закрытии
    const ModeCell = useMemo(() => textCell<RunRow>((r) => optionText(runModeOptions, r.mode) + (open.has(r.oid) ? ", идёт" : "")), [open]);
    const ScansCell = useMemo(() => textCell<RunRow>((r) => (open.has(r.oid) ? "-" : String(r.scanCount))), [open]);

    const CommandCell = (props: GridCustomCellProps) => {
        const row = props.dataItem as RunRow;
        return (
            <td {...props.tdProps}>
                <Button fillMode="flat" themeColor="primary" svgIcon={eyeIcon} title="Открыть" onClick={() => navigate(runPath(row))} />
                <Button fillMode="flat" themeColor="error" svgIcon={trashIcon} title="Удалить" onClick={() => removeRun(row)} />
            </td>
        );
    };

    return (
        <div className="radar-page radar-page--fill">
            <GridToolbar title="История запусков" search={search} onSearch={setSearch} onCreate={() => navigate("/runs")} onLoad={load}
                count={{ shown: data.length, total: rows.length }} />
            {error && <div className="radar-error">{error}</div>}
            <Grid data={data} className="radar-grid--fill" {...gridProps} onRowDoubleClick={(e) => navigate(runPath(e.dataItem as RunRow))}>
                <GridColumn field="createdAt" title="Дата" width={160} filter="date" cells={{ data: DateCell }} columnMenu={ColumnMenu} />
                <GridColumn field="fileName" title="Полёт" width={260} columnMenu={ColumnMenu} />
                <GridColumn field="scenarioName" title="Сценарий" width={200} columnMenu={ColumnMenu} />
                <GridColumn field="kind" title="Источник" width={130} cells={{ data: KindCell }} columnMenu={KindMenu} />
                <GridColumn field="mode" title="Режим" width={160} cells={{ data: ModeCell }} columnMenu={ModeMenu} />
                <GridColumn field="models" title="Модели" width={360} columnMenu={ColumnMenu} />
                <GridColumn field="pd" title="Pd" width={80} filter="numeric" cells={{ data: PdCell }} columnMenu={ColumnMenu} />
                <GridColumn field="scanCount" title="Обзоров" width={110} filter="numeric" cells={{ data: ScansCell }} columnMenu={ColumnMenu} />
                <GridColumn field="adeImm" title="ADE IMM, м" width={120} filter="numeric" cells={{ data: AdeImmCell }} columnMenu={ColumnMenu} />
                <GridColumn field="adeModel" title="Модель ADE" width={260} cells={{ data: AdeModelCell }} columnMenu={ColumnMenu} />
                <GridColumn field="adeHyb" title="ADE модели, м" width={130} filter="numeric" cells={{ data: AdeHybCell }} columnMenu={ColumnMenu} />
                <GridColumn title="Модель к IMM" width={120} sortable={false} filterable={false} cells={{ data: ChangeCell }} />
                <GridColumn field="durationS" title="Расчёт, с" width={110} filter="numeric" cells={{ data: DurationCell }} columnMenu={ColumnMenu} />
                <GridColumn title="" width={100} locked sortable={false} filterable={false} cells={{ data: CommandCell }} />
            </Grid>
            <div className="radar-hint">
                Полёт - файл или траектория пакета прогона; сценарий - наименование сценария на момент запуска.
                Pd - вероятность, что РЛС обнаружит цель на обзоре (при 0,9 каждая десятая отметка пропущена; задаётся для
                лога и траектории - отметки моделируются). Обзоров - число обзоров РЛС во всех кусках. ADE - средняя ошибка прогноза
                по горизонтали на всех горизонтах 2-10 с; у сравнения и реального времени здесь не считается (ошибки - на
                экране запуска). ADE IMM - у выбранной модели IMM (не выбрана - пусто); модель ADE - первая выбранная модель не-IMM
                (гибрид, сеть без IMM, линейная экстраполяция, фильтр Калмана, ансамбль). Модель к IMM - насколько её ADE меньше
                (минус) или больше ADE IMM. Расчёт - время
                прогноза в движке на весь запуск. Открыть - двойной щелчок по строке.
            </div>
        </div>
    );
}
