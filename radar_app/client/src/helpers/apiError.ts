const statusMessage = (status: number): string | null => {
    switch (status) {
        case 400: return 'Запрос отклонен: проверьте параметры';
        case 401: return 'Сессия истекла, войдите заново';
        case 404: return 'Запись не найдена - возможно, она была удалена';
        case 409: return 'Действие невозможно в текущем состоянии';
        case 413: return 'Файл слишком большой';
        case 500: return 'Внутренняя ошибка сервера';
        case 502: return 'Ошибка движка прогноза';
        case 503: return 'Сервис временно недоступен, попробуйте позже';
        case 504: return 'Движок прогноза не ответил вовремя';
        default: return null;
    }
};

// текст ошибки запроса: сообщение сервера ({ message }), иначе - по коду ответа
export function getApiErrorMessage(error: any, fallback = 'Ошибка выполнения запроса'): string {
    const response = error?.response;

    // запрос не дошел до сервера
    if (!response && (error?.request || error?.code)) {
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
            return 'Сервер не ответил вовремя, попробуйте еще раз';
        }
        return 'Нет связи с сервером. Проверьте, что он запущен';
    }

    const data = response?.data ?? error;

    if (typeof data === 'string' && data.trim()) return data;

    if (data && typeof data === 'object') {
        if (typeof data.message === 'string' && data.message.trim()) return data.message;

        // ModelState: { errors: { Field: ["текст"] } }
        if (data.errors && typeof data.errors === 'object') {
            const msgs = Object.values(data.errors).flat().filter(Boolean) as string[];
            if (msgs.length) return msgs.join('; ');
        }

        if (typeof data.title === 'string' && data.title.trim()) return data.title;
    }

    const byStatus = typeof response?.status === 'number' ? statusMessage(response.status) : null;
    if (byStatus) return byStatus;

    if (typeof error?.message === 'string' && error.message.trim()) return error.message;
    return fallback;
}

// ошибки проверки списком ({ message, errors: ["путь поля: текст"] } - сценарии); нет - пустой список
export function getApiErrors(error: any): string[] {
    const errors = error?.response?.data?.errors;
    return Array.isArray(errors) ? errors.filter((x: unknown): x is string => typeof x === 'string') : [];
}
