import { useCallback, useState } from "react";

import { defaultLayers } from "./trackScene";
import type { MapMode, SceneLayers } from "./trackScene";
import type { ScenarioRow } from "../../data/dataModel";

// выбор подложки, слоев и вида - удобство одного зрителя, хранится в браузере
const STORAGE_KEY = "radar-map";

export interface MapSettings {
    mode: MapMode;
    layers: SceneLayers;
    horizons: boolean[];
    follow: boolean;
    focus: boolean;
}

const load = (horizon: number): MapSettings => {
    const fallback: MapSettings = {
        mode: "osm", layers: defaultLayers, horizons: Array.from({ length: horizon }, (_, h) => h === horizon - 1), follow: false, focus: false,
    };

    try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<MapSettings> | null;
        if (!parsed) return fallback;

        return {
            mode: parsed.mode ?? fallback.mode,
            layers: { ...defaultLayers, ...parsed.layers },
            horizons: parsed.horizons?.length === horizon ? parsed.horizons : fallback.horizons,
            follow: parsed.follow ?? false,
            focus: parsed.focus ?? false,
        };
    } catch {
        return fallback;
    }
};

// вид карты из сценария (подложка, горизонты, слои, фокус) - до открытия запуска: заданное в сценарии заменяет выбор зрителя.
// Горизонты сценария - секунды; в выборе зрителя - по обзорам (обзор 2 с, 5 горизонтов - как у моделей диплома)
const SCENARIO_PERIOD_S = 2;
const SCENARIO_HORIZON = 5;

export const applyScenarioView = (s: ScenarioRow): void => {
    const current = load(SCENARIO_HORIZON);
    const seconds = s.horizons?.split(",").map(Number) ?? null;
    const layers = s.layers?.split(",") ?? null;
    const next: MapSettings = {
        ...current,
        mode: (s.basemap as MapMode | null) ?? current.mode,
        horizons: seconds ? Array.from({ length: SCENARIO_HORIZON }, (_, h) => seconds.includes((h + 1) * SCENARIO_PERIOD_S)) : current.horizons,
        layers: layers ? (Object.fromEntries(Object.keys(defaultLayers).map((k) => [k, layers.includes(k)])) as unknown as SceneLayers) : current.layers,
        focus: s.focus ?? current.focus,
        follow: s.follow ?? current.follow,
    };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* без хранилища вид сценария не применится */ }
};

export function useMapSettings(horizon: number) {
    const [settings, setSettings] = useState<MapSettings>(() => load(horizon));

    const update = useCallback((patch: Partial<MapSettings>) => setSettings((prev) => {
        const next = { ...prev, ...patch };
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* без хранилища - только на эту страницу */ }
        return next;
    }), []);

    return { settings, update };
}
