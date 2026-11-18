import type { ClockEstimate } from "../services/clockSync";

// метки времени одного посчитанного обзора по звеньям, Unix мс, каждая - по своим часам: plotMs и sentMs - сервер,
// engineReceivedMs и engineDoneMs - движок, receivedMs и renderedMs - браузер; immMs, netMs, waitMs - длительности в движке.
// у сохраненной сессии меток браузера нет (null): «всего» тогда - до отправки клиенту. hidden - вкладка была скрыта:
// браузер не рисует кадры, отрисовка не замеряется, «всего» - до получения браузером
export interface LatencyEntry {
    k: number;
    plotMs: number;
    engineReceivedMs: number;
    engineDoneMs: number;
    sentMs: number;
    receivedMs: number | null;
    renderedMs: number | null;
    hidden?: boolean;
    immMs: number;
    netMs: number;
    waitMs: number;
}

export interface Clocks {
    browser: ClockEstimate | null; // сервер - браузер
    engine: ClockEstimate | null; // движок - сервер
}

export type LinkKey = "toEngine" | "wait" | "imm" | "net" | "engineOther" | "toServer" | "toBrowser" | "render";

// звенья пути отметки по порядку; сумма звеньев - от отметки до отрисовки
export const LINKS: { key: LinkKey; title: string; hint: string }[] = [
    { key: "toEngine", title: "сервер - движок", hint: "запрос с отметкой: сервер взял отметку -> движок принял" },
    { key: "wait", title: "очередь движка", hint: "ожидание замка кода диплома (другой запрос считается)" },
    { key: "imm", title: "IMM", hint: "шаг фильтра IMM (OnlinePredictor)" },
    { key: "net", title: "сеть", hint: "окно признаков и нейросеть-корректор, три варианта" },
    { key: "engineOther", title: "движок: прочее", hint: "пересчет отметки в ENU, широта и долгота, JSON" },
    { key: "toServer", title: "движок - сервер - отправка", hint: "ответ движка, разбор на сервере, событие SignalR" },
    { key: "toBrowser", title: "сервер - браузер", hint: "SignalR: сервер отправил -> браузер получил" },
    { key: "render", title: "отрисовка", hint: "браузер получил -> кадр с новым обзором" },
];

export type LinkDurations = Record<LinkKey, number> & { total: number };

// длительности звеньев, мс, на часах сервера: метки движка и браузера переведены поправками; без поправки - 0
export const linkDurations = (e: LatencyEntry, clocks: Clocks): LinkDurations => {
    const toServerFromEngine = (ms: number) => ms - (clocks.engine?.offsetMs ?? 0);
    const toServerFromBrowser = (ms: number) => ms + (clocks.browser?.offsetMs ?? 0);

    const engineReceived = toServerFromEngine(e.engineReceivedMs);
    const engineDone = toServerFromEngine(e.engineDoneMs);
    const inEngine = e.engineDoneMs - e.engineReceivedMs;
    const received = e.receivedMs == null ? NaN : toServerFromBrowser(e.receivedMs);
    const rendered = e.receivedMs == null || e.hidden ? NaN : toServerFromBrowser(e.renderedMs ?? e.receivedMs);

    return {
        toEngine: engineReceived - e.plotMs,
        wait: e.waitMs,
        imm: e.immMs,
        net: e.netMs,
        engineOther: inEngine - e.waitMs - e.immMs - e.netMs,
        toServer: e.sentMs - engineDone,
        toBrowser: received - e.sentMs,
        render: rendered - received,
        total: (e.receivedMs == null ? e.sentMs : e.hidden ? received : rendered) - e.plotMs,
    };
};

export interface LinkStats {
    mean: number;
    p95: number;
    max: number;
}

export const stats = (all: number[]): LinkStats => {
    const values = all.filter(Number.isFinite);
    if (!values.length) return { mean: NaN, p95: NaN, max: NaN };
    const sorted = [...values].sort((a, b) => a - b);
    return {
        mean: values.reduce((s, v) => s + v, 0) / values.length,
        p95: sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)],
        max: sorted[sorted.length - 1],
    };
};

// CSV замеров: сырые метки, поправки часов и длительности звеньев на часах сервера
export const latencyCsv = (entries: LatencyEntry[], clocks: Clocks): string => {
    const head = ["k", "plot_ms", "engine_received_ms", "engine_done_ms", "sent_ms", "browser_received_ms", "browser_rendered_ms",
        "offset_browser_ms", "offset_engine_ms", ...LINKS.map((l) => `${l.key}_ms`), "total_ms"];
    const rows = entries.map((e) => {
        const d = linkDurations(e, clocks);
        return [String(e.k), e.plotMs, e.engineReceivedMs, e.engineDoneMs, e.sentMs, e.receivedMs ?? "", e.renderedMs ?? "",
            clocks.browser?.offsetMs ?? "", clocks.engine?.offsetMs ?? "", ...LINKS.map((l) => (Number.isFinite(d[l.key]) ? d[l.key].toFixed(3) : "")), d.total.toFixed(3)]
            .map((v) => (typeof v === "number" ? v.toFixed(3) : v)).join(",");
    });
    return [head.join(","), ...rows].join("\n") + "\n";
};
