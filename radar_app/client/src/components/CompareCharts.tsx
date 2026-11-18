import { memo, useMemo } from "react";

import {
    Chart, ChartCategoryAxis, ChartCategoryAxisItem, ChartLegend, ChartSeries, ChartSeriesItem, ChartTitle, ChartTooltip,
    ChartValueAxis, ChartValueAxisItem, ChartXAxis, ChartXAxisItem, ChartYAxis, ChartYAxisItem,
} from "@progress/kendo-react-charts";
import type { SeriesClickEvent } from "@progress/kendo-react-charts";

import type { Phase, Track } from "../data/dataModel";
import type { CompareModel } from "../helpers/compareModels";
import { phaseColor, seriesColors } from "../theme/colors";

// подсветка участков на оси времени: вход, маневр, выход
export const phaseBands = (track: Track, phases: Phase[]) => {
    if (!track.phase) return [];

    const colors = seriesColors();
    const names = new Map(phases.map((p) => [p.code, p.name]));
    const t0 = track.t[0];
    const bands: { from: number; to: number; color: string; opacity: number }[] = [];
    let start = 0;

    for (let i = 1; i <= track.phase.length; i++) {
        if (i < track.phase.length && track.phase[i] === track.phase[start]) continue;
        const name = names.get(track.phase[start]) ?? "straight";
        if (name === "entry" || name === "turn" || name === "exit") {
            bands.push({ from: track.t[start] - t0, to: track.t[i - 1] - t0, color: phaseColor(name, colors), opacity: 0.18 });
        }
        start = i;
    }

    return bands;
};

interface TimeProps {
    models: CompareModel[];
    trackIdx: number;
    track: Track;
    phases: Phase[];
    h: number;
    period: number;
    k: number | null; // отметка текущего обзора; null - без отметки (во время проигрывания график не перерисовывается)
    onScan: (k: number) => void;
}

// ошибка во времени на одном горизонте: линия на модель, полосы участков, отметка текущего обзора
export const CompareTimeChart = memo(function CompareTimeChart({ models, trackIdx, track, phases, h, period, k, onScan }: TimeProps) {
    const t0 = track.t[0];
    const bands = useMemo(() => phaseBands(track, phases), [track, phases]);
    const marker = k == null ? [] : [{ from: track.t[k] - t0 - period * 0.3, to: track.t[k] - t0 + period * 0.3, color: seriesColors().marker, opacity: 0.9 }];

    const series = useMemo(() => models.map((m) => {
        const r = m.results[trackIdx];
        const err = r?.err?.[m.which];
        return {
            m,
            data: (r?.ks ?? []).map((kk) => ({ k: kk, t: track.t[kk] - t0, e: err?.[kk]?.[h] ?? null })).filter((p) => p.e != null),
        };
    }), [models, trackIdx, track, t0, h]);

    return (
        <Chart className="radar-chart" transitions={false} onSeriesClick={(e: SeriesClickEvent) => onScan((e.dataItem as { k: number }).k)}>
            <ChartTitle text={`Ошибка прогноза на ${(h + 1) * period} с вперед`} font="14px sans-serif" />
            <ChartLegend position="bottom" />
            <ChartTooltip format="{1:n1} м" />
            <ChartXAxis>
                <ChartXAxisItem title={{ text: "время выдачи прогноза, с" }} min={0} plotBands={[...bands, ...marker]} />
            </ChartXAxis>
            <ChartYAxis>
                <ChartYAxisItem title={{ text: "ошибка, м" }} min={0} />
            </ChartYAxis>
            <ChartSeries>
                {series.map(({ m, data }) => (
                    <ChartSeriesItem key={m.ref.id} type="scatterLine" data={data} xField="t" yField="e" name={m.label}
                        color={m.color} width={m.which === "imm" ? 1 : 1.5} dashType={m.which === "imm" ? "dash" : "solid"}
                        markers={{ visible: false }} />
                ))}
            </ChartSeries>
        </Chart>
    );
});

interface HorizonProps {
    models: CompareModel[];
    trackIdx: number;
    period: number;
    horizon: number;
}

// средняя ошибка на каждом горизонте: столбцы моделей рядом
export const CompareHorizonChart = memo(function CompareHorizonChart({ models, trackIdx, period, horizon }: HorizonProps) {
    const categories = Array.from({ length: horizon }, (_, h) => `${(h + 1) * period} с`);

    return (
        <Chart className="radar-chart radar-chart--small" transitions={false}>
            <ChartTitle text="Средняя ошибка по горизонтам" font="14px sans-serif" />
            <ChartLegend position="bottom" />
            <ChartTooltip format="{0:n1} м" />
            <ChartCategoryAxis>
                <ChartCategoryAxisItem categories={categories} title={{ text: "горизонт" }} />
            </ChartCategoryAxis>
            <ChartValueAxis>
                <ChartValueAxisItem title={{ text: "ошибка, м" }} min={0} />
            </ChartValueAxis>
            <ChartSeries>
                {models.map((m) => (
                    <ChartSeriesItem key={m.ref.id} type="column" name={m.label} color={m.color}
                        data={m.results[trackIdx]?.ade_by_horizon?.[m.which] ?? []} />
                ))}
            </ChartSeries>
        </Chart>
    );
});
