import { client } from "./client";
import { API_CONFIG } from "../data/settings";

// параметры карты с сервера (раздел Map в appsettings), читаются один раз на загрузку страницы
export interface MapSettings {
    yandexMapsKey: string | null;
}

let request: Promise<MapSettings> | null = null;

export const getMapSettings = (): Promise<MapSettings> => {
    request ??= client
        .get<Partial<MapSettings>>(API_CONFIG.apiData.endpoints.clientSettingsMap)
        .then((response) => ({ yandexMapsKey: response.data?.yandexMapsKey || null }))
        .catch((e: unknown) => {
            // следующая попытка - при следующем открытии карты
            request = null;
            throw e;
        });

    return request;
};
