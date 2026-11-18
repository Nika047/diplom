using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;

using radar.forecast.data;
using radar.forecast.data.App;
using radar.forecast.Hubs;
using radar.forecast.Settings;

using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace radar.forecast.Services;

// сессии реального времени: обзоры идут по таймеру (RealtimeClock) раз в период обзора, деленный на ускорение; каждый обзор -
// запросы к сессиям движка моделей (OnlinePredictor, по одной на пакет и вид сети, по очереди), ответы - клиентам через
// SignalR (RadarHub, группа - OID сессии). Метки времени звеньев (Unix, мс): plotMs - сервер взял отметку,
// engineReceivedMs - первая сессия движка приняла, engineDoneMs - последняя посчитала, sentMs - сервер отправил клиенту;
// дальше метки ставит клиент
public class RealtimeService(IServiceScopeFactory scopeFactory, IHubContext<RadarHub> hub, AppStorage storage,
    IOptions<RealtimeSettings> options, ILogger<RealtimeService> logger)
{
    private readonly IServiceScopeFactory scopeFactory = scopeFactory;
    private readonly IHubContext<RadarHub> hub = hub;
    private readonly AppStorage storage = storage;
    private readonly RealtimeSettings settings = options.Value;
    private readonly ILogger<RealtimeService> logger = logger;

    private readonly ConcurrentDictionary<Guid, RealtimeSession> sessions = new();

    public const double MinSpeed = 1;
    public const double MaxSpeed = 50;

    // при стольких моделях и больше ускорение - не выше LimitedSpeed: 9 моделей - 50-60 мс движка на обзор, а при x50 обзоры
    // идут каждые 40 мс
    public const int ManyModels = 5;
    public const double LimitedSpeed = 10;

    public static double SpeedLimit(int models) => models >= ManyModels ? LimitedSpeed : MaxSpeed;

    public static double NowMs() => (DateTime.UtcNow - DateTime.UnixEpoch).TotalMilliseconds;

    public RealtimeSession? Find(Guid oid) => sessions.TryGetValue(oid, out RealtimeSession? session) ? session : null;

    public IEnumerable<RealtimeSession> All => sessions.Values;

    public async Task<RealtimeSession> CreateAsync(RealtimeCreateModel model, CancellationToken ct, string? scenarioName = null)
    {
        using IServiceScope scope = scopeFactory.CreateScope();
        RadarDbContext db = scope.ServiceProvider.GetRequiredService<RadarDbContext>();
        RunService runs = scope.ServiceProvider.GetRequiredService<RunService>();
        EngineClient engine = scope.ServiceProvider.GetRequiredService<EngineClient>();

        // источник, модели и координаты РЛС проверяет RunService.CheckAsync
        RunSource source = (await runs.SourceAsync(model, ct))!;
        List<DbModel> items = await runs.LoadModelsAsync(model.Models, ct);

        JsonNode info = await engine.GetAsync("info", ct);

        // сессия движка на пакет, вид сети и seed (RunService.EngineRuns): IMM и гибрид - из сессии одной сети, ансамбль - своя
        Dictionary<Guid, EngineRunKey> byModel = RunService.EngineRuns(items, out List<EngineRunKey> keys);
        List<string> bundles = [.. keys.Select(k => k.Bundle).Distinct()];

        Dictionary<string, JsonArray> tracksByBundle = [];
        int? index = model.Track;

        foreach (string bundle in bundles)
        {
            JsonArray tracks = await runs.ReadTracksAsync(source, storage.BundlePath(bundle), model.Pd, model.RadarLat, model.RadarLon,
                model.RadarAlt, ct);

            // по умолчанию - самый длинный кусок
            index ??= Enumerable.Range(0, tracks.Count).MaxBy(i => tracks[i]!["t"]!.AsArray().Count);

            if (index < 0 || index >= tracks.Count)
                throw new EngineException(StatusCodes.Status400BadRequest, $"В файле {tracks.Count} кусков, куска {index} нет");

            tracksByBundle[bundle] = tracks;
        }

        List<RealtimeEngineSession> engines = [];

        foreach (EngineRunKey key in keys)
        {
            JsonNode track = tracksByBundle[key.Bundle][index!.Value]!.DeepClone();

            JsonObject body = new()
            {
                ["bundle"] = storage.BundlePath(key.Bundle),
                ["ensemble"] = key.Ensemble,
                ["members"] = RunService.MembersJson(key.Seeds),
                ["radar_pos"] = track["radar_pos"]!.DeepClone(),
                ["origin"] = track["origin"]?.DeepClone(),
                ["truth"] = track["truth"]?.DeepClone()
            };

            JsonObject created = (await engine.PostAsync("sessions", body, ct)).AsObject();

            engines.Add(new RealtimeEngineSession
            {
                Key = key.Key,
                Bundle = key.Bundle,
                Ensemble = key.Ensemble,
                Seeds = key.Seeds,
                Track = track,
                Engine = created,
                Id = created["id"]!.GetValue<string>()
            });
        }

        JsonArray models = [.. items.Select(m => (JsonNode)new JsonObject
        {
            ["oid"] = m.OID,
            ["name"] = m.Name,
            ["kind"] = RunService.KindName(m.Kind),
            ["case"] = EngineClient.CaseName(m.Case),
            ["label"] = m.Label,
            ["session"] = byModel[m.OID].Key
        })];

        DbRun run = new()
        {
            Created = DateTime.Now,
            SourceFile = source.File,
            TrackRun = source.TrackRun,
            TrackId = source.TrackId,
            ScenarioName = scenarioName,
            Mode = RunModeEnum.Realtime,
            Case = items[0].Case,
            Ensemble = items.Any(m => m.Kind == ForecastKindEnum.Ens),
            Pd = source.Kind != SourceKindEnum.Radar ? model.Pd : null,
            RadarLat = source.Kind == SourceKindEnum.Radar ? model.RadarLat : null,
            RadarLon = source.Kind == SourceKindEnum.Radar ? model.RadarLon : null,
            RadarAlt = source.Kind == SourceKindEnum.Radar && model.RadarLat != null ? model.RadarAlt : null,
            Model = string.Join("; ", items.Select(m => m.Name)),
            TrackCount = 1,
            RunModels = [.. items.Select((m, i) => new DbRunModel { Model = m, Position = i })]
        };

        db.Runs.Add(run);
        await db.SaveChangesAsync(ct);

        double maxSpeed = SpeedLimit(items.Count);

        RealtimeSession session = new()
        {
            OID = run.OID,
            FileName = source.Name,
            Pd = run.Pd,
            Models = models,
            Engines = engines,
            Info = new JsonObject
            {
                ["period_s"] = info["period_s"]!.DeepClone(),
                ["horizon"] = info["horizon"]!.DeepClone(),
                ["phases"] = info["phases"]!.DeepClone()
            },
            MaxSpeed = maxSpeed,
            Speed = Math.Clamp(model.Speed, MinSpeed, maxSpeed)
        };

        sessions[session.OID] = session;

        logger.LogInformation("Сессия реального времени {Session}: {File}, {Track}, обзоров {Scans}, моделей {Count} ({Models}), " +
            "сессий движка {Engines}", session.OID, source.Name, session.Track["name"], session.Total, items.Count, run.Model,
            string.Join(", ", engines.Select(e => e.Id)));

        return session;
    }

    // описание сессии для клиента; with scans - и все посчитанные обзоры (открытие страницы заново). engine - сессия движка
    // первой модели (как до справочника моделей), engines - все по ключу
    public JsonObject Describe(RealtimeSession session, bool withScans)
    {
        JsonObject engines = [];

        foreach (RealtimeEngineSession e in session.Engines)
            engines[e.Key] = EngineSummary(e);

        JsonObject result = new()
        {
            ["oid"] = session.OID,
            ["fileName"] = session.FileName,
            ["case"] = session.Models[0]!["case"]!.DeepClone(),
            ["ensemble"] = session.Engines[0].Ensemble,
            ["pd"] = session.Pd,
            ["info"] = session.Info.DeepClone(),
            ["models"] = session.Models.DeepClone(),
            ["engine"] = EngineSummary(session.Engines[0]),
            ["engines"] = engines,
            ["maxSpeed"] = session.MaxSpeed,
            ["state"] = State(session)
        };

        if (withScans)
        {
            result["track"] = session.Track.DeepClone();
            result["scans"] = new JsonArray([.. session.Scans.Select(s => (JsonNode)s.DeepClone())]);
        }

        return result;
    }

    private static JsonObject EngineSummary(RealtimeEngineSession e) => new()
    {
        ["model"] = e.Engine["model"]?.DeepClone(),
        ["model_type"] = e.Engine["model_type"]?.DeepClone(),
        ["window"] = e.Engine["window"]?.DeepClone(),
        ["has_variants"] = e.Engine["has_variants"]?.DeepClone(),
        ["gate"] = e.Engine["gate"]?.DeepClone()
    };

    private static JsonObject State(RealtimeSession session) => new()
    {
        ["sessionId"] = session.OID,
        ["position"] = session.Position,
        ["computed"] = session.Scans.Count,
        ["total"] = session.Total,
        ["playing"] = session.Playing,
        ["speed"] = session.Speed,
        ["ended"] = session.Ended
    };

    // действие над сессией под ее замком; null - сессии нет
    public async Task<JsonObject?> ControlAsync(Guid oid, Func<RealtimeSession, Task> action, CancellationToken ct)
    {
        RealtimeSession? session = Find(oid);
        if (session == null)
            return null;

        await session.Lock.WaitAsync(ct);

        try
        {
            session.LastActivity = DateTime.UtcNow;
            await action(session);

            JsonObject state = State(session);
            await hub.Clients.Group(session.OID.ToString()).SendAsync("State", state, ct);

            return State(session);
        }
        finally
        {
            session.Lock.Release();
        }
    }

    public void Play(RealtimeSession session, double? speed)
    {
        if (speed != null)
            session.Speed = Math.Clamp(speed.Value, MinSpeed, session.MaxSpeed);

        // с конца трассы - заново с начала (из памяти)
        if (session.Ended)
            session.Position = -1;

        session.Playing = true;
        session.NextDue = DateTime.UtcNow;
    }

    public void SetSpeed(RealtimeSession session, double speed)
    {
        session.Speed = Math.Clamp(speed, MinSpeed, session.MaxSpeed);

        // новый темп - от текущего момента, а не от прежнего расписания
        if (session.Playing)
            session.NextDue = DateTime.UtcNow.AddMilliseconds(Interval(session));
    }

    public async Task StepAsync(RealtimeSession session, CancellationToken ct)
    {
        session.Playing = false;

        if (!session.Ended)
            await ShowAsync(session, session.Position + 1, ct);
    }

    // перемотка: назад и на посчитанное - показ из памяти, вперед - движок догоняет пакетами (CatchUpBatch обзоров)
    public async Task SeekAsync(RealtimeSession session, int k, CancellationToken ct)
    {
        k = Math.Clamp(k, 0, session.Total - 1);

        if (k >= session.Scans.Count)
        {
            using IServiceScope scope = scopeFactory.CreateScope();
            EngineClient engine = scope.ServiceProvider.GetRequiredService<EngineClient>();

            while (session.Scans.Count < k)
            {
                int from = session.Scans.Count;
                int to = Math.Min(k, from + settings.CatchUpBatch);
                double plotMs = NowMs();

                List<JsonArray> answers = [];

                foreach (RealtimeEngineSession e in session.Engines)
                {
                    JsonObject body = new() { ["scans"] = new JsonArray([.. Enumerable.Range(from, to - from).Select(i => (JsonNode)ScanBody(e, i))]) };
                    answers.Add((await engine.PostAsync($"sessions/{e.Id}/scans", body, ct))["results"]!.AsArray());
                }

                JsonArray items = [];

                for (int i = 0; i < to - from; i++)
                {
                    // узлы ответа уже в массивах ответов - в запись идут их копии
                    JsonObject results = [];
                    for (int j = 0; j < session.Engines.Count; j++)
                        results[session.Engines[j].Key] = answers[j][i]!.DeepClone();

                    JsonObject record = Record(session, results, plotMs);
                    session.Scans.Add(record);
                    items.Add(record.DeepClone());
                }

                await hub.Clients.Group(session.OID.ToString()).SendAsync("Scans", new JsonObject { ["sessionId"] = session.OID, ["items"] = items }, ct);
            }
        }

        await ShowAsync(session, k, ct);

        if (session.Playing)
            session.NextDue = DateTime.UtcNow.AddMilliseconds(Interval(session));
    }

    public async Task StopAsync(Guid oid, CancellationToken ct)
    {
        if (!sessions.TryRemove(oid, out RealtimeSession? session))
            return;

        await session.Lock.WaitAsync(ct);

        try
        {
            session.Playing = false;

            using IServiceScope scope = scopeFactory.CreateScope();
            EngineClient engine = scope.ServiceProvider.GetRequiredService<EngineClient>();
            RadarDbContext db = scope.ServiceProvider.GetRequiredService<RadarDbContext>();

            foreach (RealtimeEngineSession e in session.Engines)
            {
                try
                {
                    await engine.DeleteAsync($"sessions/{e.Id}", ct);
                }
                catch (EngineException ex)
                {
                    // движок мог перезапуститься и сессию уже забыть
                    logger.LogWarning("Сессия движка {Engine} не удалена: {Message}", e.Id, ex.Message);
                }
            }

            DbRun? run = await db.Runs.FirstOrDefaultAsync(r => r.OID == session.OID, ct);

            if (run != null)
            {
                run.ScanCount = session.Scans.Count;
                run.DurationMs = session.EngineMs;
                await db.SaveChangesAsync(ct);
            }

            // посчитанные обзоры сохраняются: { oid, mode: "realtime", format: 2, case, ensemble, pd, info, models, engine,
            // engines, tracks [трасса], realtime { scans } }; engine и engines - модель, окно, три варианта и строб, как в
            // описании сессии
            JsonObject description = Describe(session, false);
            JsonObject saved = new()
            {
                ["oid"] = session.OID,
                ["mode"] = "realtime",
                ["format"] = 2,
                ["case"] = description["case"]!.DeepClone(),
                ["ensemble"] = description["ensemble"]!.DeepClone(),
                ["pd"] = session.Pd,
                ["info"] = session.Info.DeepClone(),
                ["models"] = session.Models.DeepClone(),
                ["engine"] = description["engine"]!.DeepClone(),
                ["engines"] = description["engines"]!.DeepClone(),
                ["tracks"] = new JsonArray(session.Track.DeepClone()),
                ["realtime"] = new JsonObject { ["scans"] = new JsonArray([.. session.Scans.Select(s => (JsonNode)s.DeepClone())]) }
            };

            await File.WriteAllTextAsync(storage.RunPath(session.OID), saved.ToJsonString(), ct);

            await hub.Clients.Group(session.OID.ToString()).SendAsync("State", new JsonObject { ["sessionId"] = session.OID, ["stopped"] = true }, ct);

            logger.LogInformation("Сессия реального времени {Session} закрыта: посчитано обзоров {Scans}, движок {EngineMs:F0} мс",
                session.OID, session.Scans.Count, session.EngineMs);
        }
        finally
        {
            session.Lock.Release();
        }
    }

    // штатная остановка сервера: открытые сессии закрываются и сохраняются (при убитом процессе обзоры теряются)
    public async Task StopAllAsync(CancellationToken ct)
    {
        foreach (Guid oid in sessions.Keys.ToList())
        {
            try
            {
                await StopAsync(oid, ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "Сессия {Session} не сохранена при остановке сервера", oid);
            }
        }
    }

    // такт таймера: сессии, у которых подошло время обзора, - следующий обзор; простаивающие - закрыть
    public async Task TickAsync(CancellationToken ct)
    {
        DateTime now = DateTime.UtcNow;

        foreach (RealtimeSession session in sessions.Values)
        {
            if (!session.Playing)
            {
                if (now - session.LastActivity > TimeSpan.FromMinutes(settings.IdleMinutes))
                {
                    logger.LogInformation("Сессия {Session}: простой больше {Minutes} мин", session.OID, settings.IdleMinutes);
                    await StopAsync(session.OID, ct);
                }

                continue;
            }

            if (now < session.NextDue || !await session.Lock.WaitAsync(0, ct))
                continue;

            try
            {
                session.LastActivity = now;
                await ShowAsync(session, session.Position + 1, ct);

                // расписание без накопления сдвига; если отстали больше чем на обзор - от текущего момента
                double interval = Interval(session);
                session.NextDue = session.NextDue.AddMilliseconds(interval);
                if (session.NextDue < now.AddMilliseconds(-interval))
                    session.NextDue = now.AddMilliseconds(interval);

                if (session.Ended)
                {
                    session.Playing = false;
                    await hub.Clients.Group(session.OID.ToString()).SendAsync("State", State(session), ct);
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                session.Playing = false;
                logger.LogError(ex, "Сессия {Session}: обзор {K} не посчитан, проигрывание остановлено", session.OID, session.Position + 1);
                await hub.Clients.Group(session.OID.ToString()).SendAsync("State", State(session), ct);
            }
            finally
            {
                session.Lock.Release();
            }
        }
    }

    private static double Interval(RealtimeSession session) => session.PeriodSeconds * 1000 / session.Speed;

    // показать обзор k: посчитанный - из памяти, следующий за посчитанными - запросом к движку
    private async Task ShowAsync(RealtimeSession session, int k, CancellationToken ct)
    {
        if (k < 0 || k >= session.Total)
            return;

        JsonObject record;
        bool replay = k < session.Scans.Count;

        if (replay)
        {
            record = session.Scans[k];
        }
        else
        {
            using IServiceScope scope = scopeFactory.CreateScope();
            EngineClient engine = scope.ServiceProvider.GetRequiredService<EngineClient>();

            double plotMs = NowMs();
            JsonObject results = [];

            foreach (RealtimeEngineSession e in session.Engines)
                results[e.Key] = await engine.PostAsync($"sessions/{e.Id}/scan", ScanBody(e, k), ct);

            record = Record(session, results, plotMs);
            session.Scans.Add(record);
        }

        session.Position = k;

        JsonObject payload = new()
        {
            ["sessionId"] = session.OID,
            ["k"] = k,
            ["replay"] = replay,
            ["stamps"] = replay ? null : record["stamps"]!.DeepClone(),
            ["result"] = record["result"]!.DeepClone(),
            ["results"] = record["results"]!.DeepClone(),
            ["state"] = State(session)
        };

        // метка отправки - и в событии, и в записи обзора: сохраненная сессия показывает задержки до отправки клиенту
        if (!replay)
        {
            double sentMs = NowMs();
            payload["stamps"]!["sentMs"] = sentMs;
            record["stamps"]!["sentMs"] = sentMs;
        }

        await hub.Clients.Group(session.OID.ToString()).SendAsync("Scan", payload, ct);
    }

    // обзор k трассы так, как его дала бы РЛС: время, обнаружение, (дальность, азимут, угол места), радиальная скорость -
    // по трассе сессии движка (радиальная скорость у пакетов своя)
    private static JsonObject ScanBody(RealtimeEngineSession e, int k)
    {
        JsonNode track = e.Track;

        return new JsonObject
        {
            ["t"] = track["t"]![k]!.DeepClone(),
            ["detected"] = track["detected"]![k]!.DeepClone(),
            ["polar"] = track["polar"]![k]?.DeepClone(),
            ["vr"] = track["vr"] is JsonArray vr ? vr[k]?.DeepClone() : null
        };
    }

    // запись обзора: result - ответ первой сессии движка (как до справочника моделей), results - ответы всех сессий
    private static JsonObject Record(RealtimeSession session, JsonObject results, double plotMs)
    {
        foreach (KeyValuePair<string, JsonNode?> r in results)
        {
            JsonNode? ms = r.Value?["ms"];
            session.EngineMs += (ms?["imm"]?.GetValue<double>() ?? 0) + (ms?["net"]?.GetValue<double>() ?? 0);
        }

        JsonNode first = results[session.Engines[0].Key]!;
        JsonNode last = results[session.Engines[^1].Key]!;

        return new JsonObject
        {
            ["k"] = first["k"]!.DeepClone(),
            ["stamps"] = new JsonObject
            {
                ["plotMs"] = plotMs,
                ["engineReceivedMs"] = first["received_ms"]?.DeepClone(),
                ["engineDoneMs"] = last["done_ms"]?.DeepClone()
            },
            ["result"] = first.DeepClone(),
            ["results"] = results
        };
    }
}

// полёт, модели и условия РЛС - как у прогона целиком
public class RealtimeCreateModel : RunCreateModel
{
    public int? Track { get; set; } // кусок лога; не задан - самый длинный
    public double Speed { get; set; } = 1;
}
