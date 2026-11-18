// адрес сервера - public/config.js (window.APP_CONFIG), меняется без пересборки
declare global {
    interface Window {
        APP_CONFIG?: { API_URL?: string };
    }
}

export const baseUrl = window.APP_CONFIG?.API_URL || "http://localhost:5080";

export const baseApiUrl = baseUrl + "/api";

// плитки подложки OpenStreetMap (Kendo Map)
export const osmTileUrl = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

export const API_CONFIG = {

    signalR: {
        radar: baseUrl + "/hub/radar",
    },

    apiData: {
        baseURL: baseApiUrl,
        endpoints: {
            authLogin: "/Auth/Login",
            authLogout: "/Auth/Logout",
            authRefresh: "/Auth/Refresh",
            authGetUser: "/Auth/GetUser",

            clientSettingsMap: "/ClientSettings/Map",

            engineInfo: "/Engine/Info",
            engineClock: "/Engine/Clock",

            runs: "/Runs",
            runResult: "/Runs/Result",
            runExportForecast: "/Runs/ExportForecast",
            runRadarFile: "/Runs/RadarFile",

            realtime: "/Realtime",
            realtimeGet: "/Realtime/Get",
            realtimePlay: "/Realtime/Play",
            realtimePause: "/Realtime/Pause",
            realtimeStep: "/Realtime/Step",
            realtimeSeek: "/Realtime/Seek",
            realtimeSpeed: "/Realtime/Speed",

            flights: "/Flights",

            scenarios: "/Scenarios",
            scenariosGet: "/Scenarios/Get",
            scenariosSave: "/Scenarios/Save",
            scenariosUpload: "/Scenarios/Upload",
            scenariosRun: "/Scenarios/Run",

            models: "/Models",
            modelsUpload: "/Models/Upload",
            modelsUpdate: "/Models/Update",

            sourceFiles: "/SourceFiles",
            sourceFilesDiplomLogs: "/SourceFiles/DiplomLogs",
            sourceFilesUpload: "/SourceFiles/Upload",
            sourceFilesImportDiplomLog: "/SourceFiles/ImportDiplomLog",
        }
    }
};
