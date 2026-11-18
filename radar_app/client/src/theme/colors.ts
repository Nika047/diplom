// цвета - из переменных темы Kendo. В теме они заданы через oklch(...), а Kendo Drawing и Яндекс Карты понимают только
// sRGB: браузер считает цвет на пробном элементе, холст переводит его в #rrggbb (подход ggnp.ofd.client, themeColors.ts)
const cache = new Map<string, string>();

let probe: HTMLElement | null = null;
let canvas: CanvasRenderingContext2D | null = null;

const hex = (v: number) => v.toString(16).padStart(2, "0");

export const resolveColor = (name: string): string => {
    const cached = cache.get(name);
    if (cached) return cached;

    if (!probe) {
        probe = document.createElement("span");
        probe.style.display = "none";
        document.body.appendChild(probe);
    }
    canvas ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });

    probe.style.color = `var(${name})`;
    const computed = getComputedStyle(probe).color;
    let result = computed;

    if (canvas) {
        canvas.clearRect(0, 0, 1, 1);
        canvas.fillStyle = computed;
        canvas.fillRect(0, 0, 1, 1);
        const [r, g, b] = canvas.getImageData(0, 0, 1, 1).data;
        result = `#${hex(r)}${hex(g)}${hex(b)}`;
    }

    cache.set(name, result);
    return result;
};

export interface SeriesColors {
    imm: string;
    hyb: string;
    truth: string;
    plots: string;
    variant: string;
    radar: string;
    grid: string;
    marker: string;
}

export const seriesColors = (): SeriesColors => ({
    imm: resolveColor("--kendo-color-error"),
    hyb: resolveColor("--kendo-color-success"),
    truth: resolveColor("--kendo-color-on-app-surface"),
    plots: resolveColor("--kendo-color-subtle"),
    variant: resolveColor("--kendo-color-tertiary"),
    radar: resolveColor("--kendo-color-secondary"),
    // у --kendo-color-border прозрачность 8%: на карте без фона кольца не видны, берется приглушенный текст
    grid: resolveColor("--kendo-color-base-emphasis"),
    marker: resolveColor("--kendo-color-primary"),
});

// цвета моделей в сравнении: у каждой модели свой, по порядку в списке моделей (не зависит от того, какие показаны)
const MODEL_COLORS = [
    "--kendo-color-series-a", "--kendo-color-series-b", "--kendo-color-series-c",
    "--kendo-color-series-d", "--kendo-color-series-e", "--kendo-color-series-f",
    "--kendo-color-error", "--kendo-color-success", "--kendo-color-info",
];

export const modelColor = (index: number): string => resolveColor(MODEL_COLORS[index % MODEL_COLORS.length]);

// участки траектории (имена - config.PHASES диплома): прямая - цветом истины
export const phaseColor = (name: string, colors: SeriesColors): string => {
    switch (name) {
        case "entry": return resolveColor("--kendo-color-warning");
        case "turn": return resolveColor("--kendo-color-info");
        case "exit": return resolveColor("--kendo-color-primary");
        case "slow": return colors.plots;
        default: return colors.truth;
    }
};
