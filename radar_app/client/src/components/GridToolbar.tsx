import type { ReactNode } from "react";

import { Button, ButtonGroup } from "@progress/kendo-react-buttons";
import { InputSuffix, TextBox } from "@progress/kendo-react-inputs";
import { arrowRotateCwIcon, plusIcon, xIcon } from "@progress/kendo-svg-icons";

interface GridToolbarProps {
    title: string;
    search?: string;
    onSearch?: (text: string) => void;
    onCreate?: () => void;
    createLabel?: string;
    createDisabled?: string; // причина, по которой добавить нельзя (подсказка кнопки)
    onLoad?: () => void;
    extra?: ReactNode;
    options?: ReactNode; // настройки списка рядом с поиском (как searchExtra в образце)
    count?: { shown: number; total: number }; // записей после поиска и фильтров колонок и всего в списке
}

// заголовок страницы-таблицы, как GridPageToolbar в ggnp.ofd.client: название, поиск, «Добавить» и «Обновить» справа
export default function GridToolbar({ title, search, onSearch, onCreate, createLabel = "Добавить", createDisabled, onLoad, extra, options, count }: GridToolbarProps) {
    return (
        <div className="radar-toolbar">
            <div className="radar-toolbar__title">{title}</div>
            {count && (
                <div className="radar-toolbar__count">
                    {count.shown === count.total ? `записей: ${count.total}` : `записей: ${count.shown} из ${count.total}`}
                </div>
            )}

            {onSearch && (
                <TextBox style={{ width: 260 }} placeholder="Поиск..." value={search ?? ""}
                    onChange={(e) => onSearch(String(e.value ?? ""))}
                    onKeyDown={(e) => { if (e.key === "Escape") onSearch(""); }}
                    suffix={() => (search ? (
                        <InputSuffix orientation="horizontal">
                            <Button type="button" fillMode="flat" size="small" svgIcon={xIcon} title="Очистить поиск"
                                onClick={() => onSearch("")} />
                        </InputSuffix>
                    ) : null)} />
            )}

            {options}

            <div className="radar-toolbar__actions">
                <ButtonGroup>
                    {onCreate && (
                        <Button svgIcon={plusIcon} themeColor="primary" disabled={!!createDisabled} title={createDisabled}
                            onClick={onCreate}>{createLabel}</Button>
                    )}
                    {onLoad && <Button svgIcon={arrowRotateCwIcon} onClick={onLoad}>Обновить</Button>}
                    {extra}
                </ButtonGroup>
            </div>
        </div>
    );
}
