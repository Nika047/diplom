// числа по-русски: десятичная запятая, нет значения - дефис
export const fmt = (value: number | null | undefined, digits = 1): string =>
    value == null || !Number.isFinite(value) ? "-" : value.toFixed(digits).replace(".", ",");

// изменение b относительно a, %: «-26,3%»
export const fmtChange = (a: number | null | undefined, b: number | null | undefined): string =>
    a == null || b == null || !a ? "-" : `${b >= a ? "+" : ""}${fmt((b / a - 1) * 100, 1)}%`;

export const fmtDateTime = (iso: string): string => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "medium" });
};

export const fmtSize = (bytes: number): string =>
    bytes < 1024 * 1024 ? `${fmt(bytes / 1024, 0)} КБ` : `${fmt(bytes / 1024 / 1024, 1)} МБ`;

// длительность: «18 мин 40 с», от часа - «1 ч 05 мин»
export const fmtDuration = (seconds: number | null | undefined): string => {
    if (seconds == null || !Number.isFinite(seconds)) return "-";
    const s = Math.round(seconds);
    if (s < 3600) return `${Math.floor(s / 60)} мин ${String(s % 60).padStart(2, "0")} с`;
    return `${Math.floor(s / 3600)} ч ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} мин`;
};
