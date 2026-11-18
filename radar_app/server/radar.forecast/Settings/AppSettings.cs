namespace radar.forecast.Settings;

public class MapSettings
{
    public string? YandexMapsKey { get; set; }
}

// движок прогноза (engine/, FastAPI)
public class EngineSettings
{
    public string Url { get; set; } = "http://127.0.0.1:8765";

    public int TimeoutSeconds { get; set; } = 120; // прогон длинного лога целиком - секунды
}

// реальное время: таймер обзоров (служба RealtimeClock) и сессии
public class RealtimeSettings
{
    public int TickMilliseconds { get; set; } = 5; // шаг проверки таймера; у Windows таймер точнее ~15 мс не будет

    public int IdleMinutes { get; set; } = 60; // сессия на паузе без действий дольше - закрывается

    public int CatchUpBatch { get; set; } = 200; // перемотка вперед: обзоров в одном запросе к движку
}

// хранилище файлов; относительные пути - от папки веб-проекта
public class StorageSettings
{
    public string Root { get; set; } = "App_Data"; // files/ - загруженные файлы, runs/ - результаты запусков, models/ - пакеты моделей

    public string DiplomFlightLogs { get; set; } = "../../../diplom_project/flight_logs"; // логи полётов диплома, только чтение

    // пакеты моделей всех прогонов диплома (<прогон>/<случай>/...), только чтение: из них при старте заводится справочник
    // моделей (ModelSeeder)
    public string DiplomBundles { get; set; } = "../../../diplom_project/bundles";
}
