import axios from 'axios';
import type { AxiosError, AxiosInstance } from 'axios';

import { API_CONFIG } from '../data/settings';

// страницы без входа: 401 на них не уводит на /login
const PUBLIC_PATHS = ['/login'];

// клиент API: токены в HttpOnly cookie; на 401 - одно обновление токена (Auth/Refresh) и повтор запросов, по образцу ggnp.ofd
const createClient = (): AxiosInstance => {
    const instance = axios.create({
        baseURL: API_CONFIG.apiData.baseURL,
        withCredentials: true,
        headers: { 'Content-Type': 'application/json' },
    });

    let isRefreshing = false;
    let failedQueue: Array<{ resolve: (value: unknown) => void; reject: (error: AxiosError) => void; }> = [];

    const processQueue = (error: AxiosError | null) => {
        failedQueue.forEach((prom) => (error ? prom.reject(error) : prom.resolve(true)));
        failedQueue = [];
    };

    instance.interceptors.response.use(
        (response) => response,
        async (error: AxiosError) => {
            if (axios.isCancel(error) || error.code === 'ERR_CANCELED') {
                return Promise.reject(error);
            }

            const originalRequest = error.config;
            const reqUrl = (originalRequest?.url ?? '').toLowerCase();

            if (error.response?.status === 401
                && originalRequest && !PUBLIC_PATHS.includes(window.location.pathname)
                && !reqUrl.includes('/auth/login')
                && !reqUrl.includes('/auth/refresh')
                && !reqUrl.includes('/auth/getuser')) {
                if (isRefreshing) {
                    return new Promise((resolve, reject) => {
                        failedQueue.push({ resolve, reject });
                    }).then(() => instance(originalRequest));
                }

                isRefreshing = true;

                try {
                    await instance.post(API_CONFIG.apiData.endpoints.authRefresh);
                    processQueue(null);

                    return instance(originalRequest);
                } catch (refreshError) {
                    console.error("Ошибка обновления токена, переход на страницу входа");
                    processQueue(refreshError as AxiosError);
                    window.location.href = '/login';

                    return Promise.reject(refreshError);
                } finally {
                    isRefreshing = false;
                }
            }

            if (error.response?.status !== 401) {
                console.error('Ошибка запроса к серверу', error.response?.data || error.message);
            }

            return Promise.reject(error);
        }
    );

    return instance;
};

export const client = createClient();
