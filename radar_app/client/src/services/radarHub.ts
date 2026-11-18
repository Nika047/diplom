import { HubConnectionBuilder, LogLevel } from "@microsoft/signalr";
import type { HubConnection } from "@microsoft/signalr";

import { API_CONFIG } from "../data/settings";
import type { RealtimeState, ScanEvent, ScanRecord } from "../data/dataModel";

export interface RadarHubHandlers {
    onScan: (e: ScanEvent, receivedMs: number) => void;
    onScans: (items: ScanRecord[]) => void;
    onState: (state: RealtimeState) => void;
    onReconnected: () => void;
}

// время по часам браузера, Unix мс с долями: метки «клиент получил» и «отрисовано»
export const clientNowMs = (): number => performance.timeOrigin + performance.now();

// канал RadarHub одной сессии реального времени: события Scan, Scans, State (Hubs/RadarHub.cs на сервере)
export const connectRadarHub = async (sessionId: string, handlers: RadarHubHandlers): Promise<HubConnection> => {
    const connection = new HubConnectionBuilder()
        .withUrl(API_CONFIG.signalR.radar, { withCredentials: true })
        .withAutomaticReconnect()
        .configureLogging(LogLevel.Warning)
        .build();

    connection.on("Scan", (e: ScanEvent) => {
        if (e.sessionId === sessionId) handlers.onScan(e, clientNowMs());
    });
    connection.on("Scans", (e: { sessionId: string; items: ScanRecord[] }) => {
        if (e.sessionId === sessionId) handlers.onScans(e.items);
    });
    connection.on("State", (state: RealtimeState) => {
        if (state.sessionId === sessionId) handlers.onState(state);
    });

    // после переподключения группа на сервере потеряна - вступить заново
    connection.onreconnected(async () => {
        await connection.invoke("Join", sessionId);
        handlers.onReconnected();
    });

    await connection.start();
    await connection.invoke("Join", sessionId);

    return connection;
};
