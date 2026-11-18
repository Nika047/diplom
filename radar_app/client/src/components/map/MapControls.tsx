import { Button, ButtonGroup } from "@progress/kendo-react-buttons";
import { Checkbox } from "@progress/kendo-react-inputs";
import { zoomBestFitIcon } from "@progress/kendo-svg-icons";

import type { MapSettings } from "./mapSettings";
import { FOCUS_TAIL } from "./trackScene";
import type { MapMode, SceneLayers } from "./trackScene";

const MODES: { value: MapMode; text: string; geo: boolean }[] = [
    { value: "osm", text: "OpenStreetMap", geo: true },
    { value: "yandex", text: "Яндекс", geo: true },
    { value: "plane", text: "Плоскость", geo: false },
];

const LAYERS: { key: keyof SceneLayers; text: string }[] = [
    { key: "plots", text: "отметки РЛС" },
    { key: "truth", text: "истина (GPS)" },
    { key: "phases", text: "участки" },
    { key: "variants", text: "три варианта" },
    { key: "gate", text: "строб" },
];

interface Props {
    settings: MapSettings;
    update: (patch: Partial<MapSettings>) => void;
    period: number;
    hasGeo: boolean;
    hasTruth: boolean;
    hasVariants: boolean;
    hasGate: boolean;
    whole: boolean;       // включена «вся трасса»
    onWhole: () => void;  // включить или вернуть прежний вид
}

// управление картой в боковой панели: подложка, горизонты, слои, вид
export default function MapControls({ settings, update, period, hasGeo, hasTruth, hasVariants, hasGate, whole, onWhole }: Props) {
    return (
        <>
            <section className="radar-side__block">
                <h4>Подложка</h4>
                <ButtonGroup>
                    {MODES.map((m) => (
                        <Button key={m.value} togglable selected={(hasGeo ? settings.mode : "plane") === m.value} disabled={m.geo && !hasGeo}
                            title={m.geo && !hasGeo ? "У файла отметок не заданы координаты РЛС - только плоскость" : undefined}
                            onClick={() => update({ mode: m.value })}>{m.text}</Button>
                    ))}
                </ButtonGroup>
            </section>

            <section className="radar-side__block">
                <h4>Горизонты прогноза</h4>
                <ButtonGroup>
                    {settings.horizons.map((on, h) => (
                        <Button key={h} togglable selected={on} title={`прогноз на ${h + 1} обзор(а) вперёд: точки и строб`}
                            onClick={() => update({ horizons: settings.horizons.map((v, i) => (i === h ? !v : v)) })}>
                            {`${(h + 1) * period} с`}
                        </Button>
                    ))}
                </ButtonGroup>
            </section>

            <section className="radar-side__block">
                <h4>Слои</h4>
                <div className="radar-side__checks">
                    {LAYERS.map((l) => {
                        const disabled = (l.key === "variants" && !hasVariants) || (l.key === "gate" && !hasGate)
                            || ((l.key === "truth" || l.key === "phases") && !hasTruth);
                        return (
                            <Checkbox key={l.key} label={l.text} disabled={disabled} checked={settings.layers[l.key] && !disabled}
                                onChange={(e) => update({ layers: { ...settings.layers, [l.key]: !!e.value } })} />
                        );
                    })}
                </div>
            </section>

            <section className="radar-side__block">
                <h4>Вид</h4>
                <div className="radar-side__checks">
                    <Checkbox label={`фокус на прогнозе: прогнозы и последние ${FOCUS_TAIL} обзоров`} checked={settings.focus}
                        onChange={(e) => update({ focus: !!e.value })} />
                    <Checkbox label="следить за целью" checked={settings.follow} disabled={settings.focus}
                        onChange={(e) => update({ follow: !!e.value })} />
                </div>
                <div className="radar-row">
                    <Button svgIcon={zoomBestFitIcon} togglable selected={whole}
                        title={whole ? "Вернуть прежний вид: фокус, слежение, масштаб" : "Показать всю трассу; повторное нажатие вернёт прежний вид"}
                        onClick={onWhole}>вся трасса</Button>
                </div>
            </section>
        </>
    );
}
