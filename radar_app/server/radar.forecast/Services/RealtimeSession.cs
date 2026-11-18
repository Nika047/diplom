using System.Text.Json.Nodes;

namespace radar.forecast.Services;

// сессия движка для одной или нескольких моделей запуска: пакет, вид сети и seed (одна сеть даёт и IMM, и гибрид, ансамбль -
// своя)
public class RealtimeEngineSession
{
    public string Key { get; init; } = string.Empty; // b0, b1, ... (RunService.EngineRuns): ключ результатов в записи обзора
    public string Bundle { get; init; } = string.Empty; // путь к пакету (DbModel.Bundle)
    public bool Ensemble { get; init; }
    public string? Seeds { get; init; } // seed участников (DbModel.Seeds); нет - по умолчанию
    public JsonNode Track { get; init; } = new JsonObject(); // трасса под датчик пакета: у пакетов разная радиальная скорость
    public JsonObject Engine { get; init; } = new(); // ответ движка на создание сессии: model, window, has_variants, gate
    public string Id { get; init; } = string.Empty; // id сессии движка
}

// сессия реального времени: одна трасса, сессии движка моделей (OnlinePredictor), посчитанные обзоры и плеер.
// OID сессии совпадает с OID записи DbRun (Mode = Realtime)
public class RealtimeSession
{
    public Guid OID { get; init; }
    public string FileName { get; init; } = string.Empty;
    public double? Pd { get; init; }

    public JsonArray Models { get; init; } = []; // модели запуска: { oid, name, kind, case, label, session }
    public List<RealtimeEngineSession> Engines { get; init; } = [];
    public JsonObject Info { get; init; } = new(); // period_s, horizon, phases

    // трасса показа - у первой сессии движка
    public JsonNode Track => Engines[0].Track;

    // посчитанные обзоры 0..Computed-1: { k, stamps, result (первой сессии движка), results { <ключ сессии>: ответ } };
    // движок считает по порядку, назад - только показ из памяти
    public List<JsonObject> Scans { get; } = [];

    public int Position { get; set; } = -1; // показанный обзор
    public bool Playing { get; set; }
    public double Speed { get; set; } = 1;
    public double MaxSpeed { get; init; } = 50; // меньше при многих моделях: движок считает их по очереди
    public DateTime NextDue { get; set; } // время следующего обзора по таймеру (UTC)
    public DateTime LastActivity { get; set; } = DateTime.UtcNow;
    public double EngineMs { get; set; } // время прогноза в движке по всем обзорам и сессиям (IMM + сеть)

    // все действия с сессией - по одному: таймер, управление и перемотка
    public SemaphoreSlim Lock { get; } = new(1, 1);

    public int Total => Track["t"]!.AsArray().Count;

    public double PeriodSeconds => Info["period_s"]!.GetValue<double>();

    public bool Ended => Position >= Total - 1;
}
