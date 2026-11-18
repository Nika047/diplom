import { useMemo } from "react";

import { Button } from "@progress/kendo-react-buttons";
import {
    Chart, ChartCategoryAxis, ChartCategoryAxisItem, ChartLegend, ChartSeries, ChartSeriesItem, ChartTooltip,
    ChartValueAxis, ChartValueAxisItem,
} from "@progress/kendo-react-charts";
import { downloadIcon, trashIcon } from "@progress/kendo-svg-icons";

import { fmt } from "../helpers/format";
import { LINKS, linkDurations, stats } from "../helpers/latency";
import type { Clocks, LatencyEntry, LinkKey } from "../helpers/latency";
import { resolveColor } from "../theme/colors";

// обзоров на графике
const CHART_LAST = 120;

const LINK_COLORS: Record<LinkKey, string> = {
    toEngine: "--kendo-color-series-a",
    wait: "--kendo-color-subtle",
    imm: "--kendo-color-error",
    net: "--kendo-color-success",
    engineOther: "--kendo-color-series-b",
    toServer: "--kendo-color-series-c",
    toBrowser: "--kendo-color-series-d",
    render: "--kendo-color-series-e",
};

const clockText = (title: string, c: { offsetMs: number; rttMs: number } | null) =>
    c ? `${title}: ${c.offsetMs >= 0 ? "+" : ""}${fmt(c.offsetMs, 2)} мс ± ${fmt(c.rttMs / 2, 2)}` : `${title}: оценивается...`;

interface Props {
    entries: LatencyEntry[];
    clocks: Clocks;
    intervalMs: number | null; // время между обзорами при текущем ускорении; null - неизвестно (сохраненная сессия)
    note?: string;
    liveClocks?: boolean; // false - часы не оцениваются (сохраненная сессия), строки о часах нет
    onExport: () => void;
    onClear?: () => void; // нет - кнопки очистки нет (сохраненная сессия)
}

// задержки по звеньям пути отметки: от момента, когда сервер взял отметку, до кадра с прогнозом в браузере.
// метки движка и браузера переведены на часы сервера оценками расхождения часов (clockSync)
export default function LatencyPanel({ entries, clocks, intervalMs, note, liveClocks = true, onExport, onClear }: Props) {
    const rows = useMemo(() => entries.map((e) => ({ k: e.k, d: linkDurations(e, clocks) })), [entries, clocks]);
    const hiddenCount = entries.filter((e) => e.hidden).length;
    const last = rows[rows.length - 1];

    const table = useMemo(() => [
        ...LINKS.map((l) => ({ key: l.key as string, title: l.title, hint: l.hint, s: stats(rows.map((r) => r.d[l.key])) })),
        { key: "total", title: "всего", hint: "от отметки до кадра", s: stats(rows.map((r) => r.d.total)) },
    ], [rows]);

    const chartRows = rows.slice(-CHART_LAST);
    const categories = chartRows.map((r) => r.k + 1);
    const colors = useMemo(() => Object.fromEntries(LINKS.map((l) => [l.key, resolveColor(LINK_COLORS[l.key])])) as Record<LinkKey, string>, []);
    const totalStats = table[table.length - 1].s;

    return (
        <section className="radar-card radar-latency">
            <div className="radar-row radar-latency__head">
                <h4>Задержки по звеньям, мс</h4>
                <span className="radar-hint">
                    посчитанных обзоров: {rows.length}
                    {liveClocks && <>; {clockText("часы браузера к серверу", clocks.browser)}; {clockText("часы движка к серверу", clocks.engine)}</>}
                </span>
                <span className="radar-latency__spacer" />
                <Button svgIcon={downloadIcon} disabled={!rows.length} onClick={onExport}>Замеры CSV</Button>
                {onClear && <Button svgIcon={trashIcon} fillMode="flat" title="Очистить замеры" disabled={!rows.length} onClick={onClear} />}
            </div>
            {note && <div className="radar-info">{note}</div>}
            {hiddenCount > 0 && <div className="radar-info">Вкладка браузера была скрыта на {hiddenCount} обзорах: у них отрисовка
                не замерялась, «всего» - до получения браузером. Для замера отрисовки держите вкладку видимой.</div>}

            {!rows.length ? (
                <div className="radar-hint">Замеры появятся с первым посчитанным обзором (пуск или «Следующий обзор»).
                    Показ из памяти (перемотка назад) не замеряется.</div>
            ) : (
                <div className="radar-latency__body">
                    <div>
                        <table className="radar-table radar-table--compact">
                            <thead>
                                <tr><th>звено</th><th>последний</th><th>среднее</th><th>95%</th><th>макс.</th></tr>
                            </thead>
                            <tbody>
                                {table.map((t) => (
                                    <tr key={t.key} title={t.hint} className={t.key === "total" ? "radar-table__total" : undefined}>
                                        <td>
                                            {t.key !== "total" && <i className="radar-latency__swatch" style={{ background: colors[t.key as LinkKey] }} />}
                                            {t.title}
                                        </td>
                                        <td>{fmt(t.key === "total" ? last.d.total : last.d[t.key as LinkKey], 2)}</td>
                                        <td>{fmt(t.s.mean, 2)}</td>
                                        <td>{fmt(t.s.p95, 2)}</td>
                                        <td>{fmt(t.s.max, 2)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        <div className="radar-hint">
                            {intervalMs != null && <>Между обзорами {fmt(intervalMs, 0)} мс: всего в среднем {fmt(totalStats.mean / intervalMs * 100, 1)}% интервала
                                {totalStats.max > intervalMs && ", худший обзор не уложился в интервал"}. </>}
                            Звенья внутри движка - по его часам, переходы между частями - с поправкой на расхождение часов.
                        </div>
                    </div>

                    <Chart className="radar-latency__chart" transitions={false}>
                        <ChartLegend position="bottom" />
                        <ChartTooltip format="{0:n2} мс" />
                        <ChartCategoryAxis>
                            <ChartCategoryAxisItem categories={categories} title={{ text: "обзор" }}
                                labels={{ step: Math.max(1, Math.ceil(categories.length / 12)) }} />
                        </ChartCategoryAxis>
                        <ChartValueAxis>
                            <ChartValueAxisItem title={{ text: "мс" }} min={0} />
                        </ChartValueAxis>
                        <ChartSeries>
                            {LINKS.map((l) => (
                                <ChartSeriesItem key={l.key} type="column" stack={true} gap={0.15} name={l.title} color={colors[l.key]}
                                    data={chartRows.map((r) => (Number.isFinite(r.d[l.key]) ? Math.max(0, r.d[l.key]) : 0))} />
                            ))}
                        </ChartSeries>
                    </Chart>
                </div>
            )}
        </section>
    );
}
