import type { HubConnection } from "@microsoft/signalr";

import { client } from "./client";
import { API_CONFIG } from "../data/settings";
import { clientNowMs } from "./radarHub";

// оценка расхождения двух часов, мс: offsetMs - «другие часы минус наши», погрешность не больше rttMs / 2
export interface ClockEstimate {
    offsetMs: number;
    rttMs: number;
    samples: number;
    at: number; // когда оценено, часы браузера
}

// часы браузера против часов сервера (offsetMs = сервер - браузер): несколько пингов через RadarHub, берется самый быстрый -
// у него меньше всего неизвестной несимметричности пути туда и обратно (так же, как у NTP). первый пинг не учитывается
export const syncServerClock = async (connection: HubConnection, samples = 8): Promise<ClockEstimate> => {
    await connection.invoke<number>("Ping");

    let best: ClockEstimate | null = null;

    for (let i = 0; i < samples; i++) {
        const sent = clientNowMs();
        const server = await connection.invoke<number>("Ping");
        const received = clientNowMs();
        const rtt = received - sent;

        if (!best || rtt < best.rttMs) {
            best = { offsetMs: server - (sent + rtt / 2), rttMs: rtt, samples, at: received };
        }
    }

    return best!;
};

// часы движка против часов сервера (offsetMs = движок - сервер): оценивает сервер (Engine/Clock)
export const engineClock = (): Promise<ClockEstimate> => client
    .get<{ offsetMs: number; rttMs: number; samples: number }>(API_CONFIG.apiData.endpoints.engineClock)
    .then((r) => ({ ...r.data, at: clientNowMs() }));
