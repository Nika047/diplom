import { useMemo, useState } from "react";

import { DropDownList } from "@progress/kendo-react-dropdowns";
import { GridColumnMenuFilter, GridColumnMenuSort } from "@progress/kendo-react-grid";
import type { GridColumnMenuFilterUIProps, GridColumnMenuProps, GridCustomCellProps, GridFilterChangeEvent, GridSortChangeEvent } from "@progress/kendo-react-grid";
import { filterBy, orderBy } from "@progress/kendo-data-query";
import type { CompositeFilterDescriptor, SortDescriptor } from "@progress/kendo-data-query";

import { fmtDateTime } from "../helpers/format";

// меню колонок таблиц, как GridPage.tsx в ggnp.ofd.client: сортировка и фильтр в заголовке, у перечислений -
// выпадающий список значений

const columnFilterKey = (props: GridColumnMenuProps): string => {
    try { return JSON.stringify((props as { filter?: unknown }).filter ?? null); } catch { return ""; }
};

export const ColumnMenu = (props: GridColumnMenuProps) => (
    <div>
        <GridColumnMenuSort {...props} />
        <GridColumnMenuFilter key={columnFilterKey(props)} {...props} />
    </div>
);

export interface EnumOption {
    value: string | number | boolean;
    text: string;
}

// меню колонки перечисления: в данных хранится значение, пользователь выбирает подпись
export const makeEnumColumnMenu = (options: EnumOption[]) => {
    const FilterUI = (props: GridColumnMenuFilterUIProps) => {
        const { value, onChange } = props.firstFilterProps;
        return (
            <DropDownList data={options} textField="text" dataItemKey="text" value={options.find((o) => o.value === value) ?? null}
                onChange={(e) => onChange({ value: (e.value as EnumOption | null)?.value ?? null, operator: "eq", syntheticEvent: e.syntheticEvent })} />
        );
    };

    return (props: GridColumnMenuProps) => (
        <div>
            <GridColumnMenuSort {...props} />
            <GridColumnMenuFilter key={columnFilterKey(props)} {...props} filterUI={FilterUI} />
        </div>
    );
};

// ячейка перечисления: в данных значение, в таблице подпись
export const makeEnumCell = (options: EnumOption[]) => (props: GridCustomCellProps) => {
    const value = props.dataItem?.[props.field ?? ""];
    return <td {...props.tdProps}>{options.find((o) => o.value === value)?.text ?? (value == null ? "-" : String(value))}</td>;
};

// ячейка даты (поле - Date)
export const DateCell = (props: GridCustomCellProps) => {
    const value = props.dataItem?.[props.field ?? ""] as Date | null | undefined;
    return <td {...props.tdProps}>{value ? fmtDateTime(value.toISOString()) : "-"}</td>;
};

const EMPTY_FILTER: CompositeFilterDescriptor = { logic: "and", filters: [] };

// сортировка и фильтры колонок таблицы поверх данных в памяти
export function useGridState<T>(rows: T[]) {
    const [sort, setSort] = useState<SortDescriptor[]>([]);
    const [filter, setFilter] = useState<CompositeFilterDescriptor>(EMPTY_FILTER);

    const data = useMemo(() => orderBy(filterBy(rows, filter), sort), [rows, filter, sort]);

    return {
        data,
        gridProps: {
            sortable: true,
            sort,
            onSortChange: (e: GridSortChangeEvent) => setSort(e.sort),
            filter,
            onFilterChange: (e: GridFilterChangeEvent) => setFilter(e.filter ?? EMPTY_FILTER),
        },
        resetFilter: () => setFilter(EMPTY_FILTER),
        filtered: filter.filters.length > 0,
    };
}
