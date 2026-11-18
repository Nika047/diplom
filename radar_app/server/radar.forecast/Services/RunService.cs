using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;

using radar.forecast.data;
using radar.forecast.data.App;

using Microsoft.EntityFrameworkCore;

namespace radar.forecast.Services;

// запуск «прогон целиком»: трассы из файла (движок) -> прогноз по каждой трассе и модели (движок) -> файл результата и запись
// в БД. Трассы и ответы движка хранятся как есть (форматы - .agent_docs/ARCHITECTURE.md). Файлы запусков до справочника
// моделей: { oid, case, ensemble, pd, info, tracks, results [ответ /run] } и сравнение { mode: "compare", models [{ id, case,
// kind }], runs { <случай>: { single, ensemble } } } - читаются как есть
public class RunService(RadarDbContext db, EngineClient engine, AppStorage storage, ILogger<RunService> logger)
{
    private readonly RadarDbContext db = db;
    private readonly EngineClient engine = engine;
    private readonly AppStorage storage = storage;
    private readonly ILogger<RunService> logger = logger;

    public IQueryable<RunRow> Query() => db.Runs
        .OrderByDescending(r => r.Created)
        .Select(r => new RunRow
        {
            OID = r.OID,
            Created = r.Created,
            SourceFileOID = r.SourceFile != null ? r.SourceFile.OID : null,
            FileName = r.SourceFile != null ? r.SourceFile.FileName : r.TrackId ?? string.Empty,
            Kind = r.SourceFile != null ? r.SourceFile.Kind : SourceKindEnum.Track,
            TrackRun = r.TrackRun,
            TrackId = r.TrackId,
            ScenarioName = r.ScenarioName,
            Mode = r.Mode,
            Case = r.Case,
            Ensemble = r.Ensemble,
            Pd = r.Pd,
            RadarLat = r.RadarLat,
            RadarLon = r.RadarLon,
            RadarAlt = r.RadarAlt,
            Model = r.Model,
            ModelOIDs = r.RunModels.OrderBy(m => m.Position).Select(m => m.Model!.OID).ToList(),
            TrackCount = r.TrackCount,
            ScanCount = r.ScanCount,
            // IMM не выбран - ADE IMM не показывается (у старых записей там IMM пакета первой модели)
            AdeImm = r.RunModels.Any() && !r.RunModels.Any(m => m.Model!.Kind == ForecastKindEnum.Imm) ? null : r.AdeImm,
            AdeHyb = r.AdeHyb,
            AdeModel = r.RunModels.Where(m => m.Model!.Kind != ForecastKindEnum.Imm).OrderBy(m => m.Position)
                .Select(m => m.Model!.Name).FirstOrDefault(),
            DurationMs = r.DurationMs
        });

    // источник трассы запроса: загруженный файл или траектория пакета прогона; нет ни того, ни другого или файла нет - null
    public async Task<RunSource?> SourceAsync(RunCreateModel model, CancellationToken ct)
    {
        if (model.SourceFileOID != null)
        {
            DbSourceFile? file = await db.SourceFiles.FirstOrDefaultAsync(f => f.OID == model.SourceFileOID, ct);
            return file == null ? null : new RunSource { File = file };
        }

        if (string.IsNullOrWhiteSpace(model.TrackRun) || string.IsNullOrWhiteSpace(model.TrackId))
            return null;

        return new RunSource { TrackRun = model.TrackRun, TrackId = model.TrackId };
    }

    // проверка запроса запуска (прогон целиком и реальное время): текст ошибки или null
    public async Task<string?> CheckAsync(RunCreateModel model, CancellationToken ct)
    {
        if (model.SourceFileOID != null && !string.IsNullOrWhiteSpace(model.TrackId))
            return "Укажите либо файл, либо траекторию";

        RunSource? source = await SourceAsync(model, ct);

        if (source == null)
            return model.SourceFileOID != null ? "Файл не найден" : "Не выбран полёт: файл или траектория пакета";

        if (model.Models.Count == 0)
            return "Выберите хотя бы одну модель";

        if ((await LoadModelsAsync(model.Models, ct)).Count != model.Models.Distinct().Count())
            return "Модель не найдена в справочнике";

        if (source.Kind == SourceKindEnum.Radar && (model.RadarLat == null) != (model.RadarLon == null))
            return "Укажите и широту, и долготу РЛС или ни то, ни другое";

        if (source.Kind != SourceKindEnum.Radar && (model.Pd <= 0 || model.Pd > 1))
            return "Вероятность обнаружения - от 0 (не включая) до 1";

        return null;
    }

    // трассы источника в движке: лог - куски с истиной и отметками модели РЛС (датчик - как у пакета модели), файл отметок -
    // одна трасса, траектория пакета - одна трасса с истиной без широты и долготы (только плоскость)
    public async Task<JsonArray> ReadTracksAsync(RunSource source, string bundlePath, double pd,
        double? radarLat, double? radarLon, double radarAlt, CancellationToken ct)
    {
        JsonNode response;

        if (source.File == null)
        {
            JsonObject request = new()
            {
                ["run"] = source.TrackRun,
                ["id"] = source.TrackId,
                ["pd"] = pd,
                ["bundle"] = bundlePath
            };

            response = await engine.PostAsync("tracks/bundle", request, ct);
        }
        else
        {
            DbSourceFile file = source.File;
            string text = await File.ReadAllTextAsync(storage.SourcePath(file.OID), ct);

            // имя файла передается как есть: от него в дипломе зависит шум отметок (flight_id)
            JsonObject body = new()
            {
                ["name"] = file.FileName,
                ["text"] = text,
                ["bundle"] = bundlePath
            };

            if (file.Kind == SourceKindEnum.Log)
            {
                body["pd"] = pd;
            }
            else
            {
                body["lat"] = radarLat;
                body["lon"] = radarLon;
                body["alt"] = radarAlt;
            }

            response = await engine.PostAsync(file.Kind == SourceKindEnum.Log ? "tracks/log" : "tracks/radar", body, ct);
        }

        // массив отвязывается от ответа: дальше он идёт в файл результата
        JsonArray tracks = response["tracks"]!.AsArray();
        response.AsObject().Remove("tracks");

        return tracks;
    }

    // модели запроса в порядке выбора, без повторов; неизвестные - исключение (проверяет RunsController.Create)
    public async Task<List<DbModel>> LoadModelsAsync(IEnumerable<Guid> oids, CancellationToken ct)
    {
        List<Guid> order = [.. oids.Distinct()];
        Dictionary<Guid, DbModel> found = await db.Models.Where(m => order.Contains(m.OID)).ToDictionaryAsync(m => m.OID, ct);

        return [.. order.Where(found.ContainsKey).Select(o => found[o])];
    }

    // прогоны движка для моделей запуска: по одному на пакет, вид сети и seed участников (одна сеть даёт и IMM, и гибрид);
    // IMM берётся из любого прогона своего пакета. Ключи - b0, b1, ... в порядке выбора моделей
    public static Dictionary<Guid, EngineRunKey> EngineRuns(List<DbModel> items, out List<EngineRunKey> keys)
    {
        List<EngineRunKey> list = [];
        Dictionary<Guid, EngineRunKey> byModel = [];

        foreach (DbModel m in items.Where(m => m.Kind != ForecastKindEnum.Imm))
        {
            bool ensemble = m.Kind == ForecastKindEnum.Ens;
            EngineRunKey? key = list.FirstOrDefault(k => k.Bundle == m.Bundle && k.Ensemble == ensemble && k.Seeds == m.Seeds);

            if (key == null)
            {
                key = new EngineRunKey($"b{list.Count}", m.Bundle, ensemble, m.Seeds);
                list.Add(key);
            }

            byModel[m.OID] = key;
        }

        foreach (DbModel m in items.Where(m => m.Kind == ForecastKindEnum.Imm))
        {
            EngineRunKey? key = list.FirstOrDefault(k => k.Bundle == m.Bundle && !k.Ensemble) ?? list.FirstOrDefault(k => k.Bundle == m.Bundle);

            if (key == null)
            {
                key = new EngineRunKey($"b{list.Count}", m.Bundle, false, null);
                list.Add(key);
            }

            byModel[m.OID] = key;
        }

        keys = list;
        return byModel;
    }

    // seed участников прогона движка для запроса: null - по умолчанию (первый участник или все при ансамбле)
    public static JsonArray? MembersJson(string? seeds) =>
        ModelCatalog.ParseSeeds(seeds) is List<int> list ? new JsonArray([.. list.Select(s => (JsonNode)s)]) : null;

    // прогон целиком по моделям справочника. Трассы строятся под каждый пакет (у пакетов одного файла отметки и истина
    // одни и те же, различается радиальная скорость - check.py), движок вызывается по разу на прогон (EngineRuns). Файл
    // результата (format 2): { oid, mode: "full", format: 2, pd, info, models [{ oid, name, kind, case, label, run, ade }],
    // tracks [трассы первого пакета], runs { <run>: { bundle, members, single: [ответ /run по кускам] | null, ensemble: [...]
    // | null } } }
    public async Task<RunRow> CreateAsync(RunCreateModel model, CancellationToken ct, string? scenarioName = null)
    {
        // источник, модели и координаты РЛС проверяет CheckAsync
        RunSource source = (await SourceAsync(model, ct))!;
        List<DbModel> items = await LoadModelsAsync(model.Models, ct);

        long started = Stopwatch.GetTimestamp();
        JsonNode info = await engine.GetAsync("info", ct);

        Dictionary<Guid, EngineRunKey> byModel = EngineRuns(items, out List<EngineRunKey> keys);
        Dictionary<string, JsonArray> tracksByBundle = [];

        JsonArray? displayTracks = null;
        JsonObject runs = [];
        double durationMs = 0;

        foreach (EngineRunKey key in keys)
        {
            string bundlePath = storage.BundlePath(key.Bundle);

            if (!tracksByBundle.TryGetValue(key.Bundle, out JsonArray? tracks))
            {
                tracks = await ReadTracksAsync(source, bundlePath, model.Pd, model.RadarLat, model.RadarLon, model.RadarAlt, ct);
                tracksByBundle[key.Bundle] = tracks;
            }

            displayTracks ??= tracks;

            JsonArray results = await RunTracksAsync(tracks, bundlePath, key.Ensemble, key.Seeds, ct);
            JsonObject entry = new()
            {
                ["bundle"] = storage.BundleTitle(key.Bundle),
                ["members"] = MembersJson(key.Seeds),
                ["single"] = key.Ensemble ? null : results,
                ["ensemble"] = key.Ensemble ? results : null
            };

            durationMs += results.Sum(r => r!["ms_total"]!.GetValue<double>());
            runs[key.Key] = entry;
        }

        JsonArray models = [.. items.Select(m =>
        {
            JsonObject entry = runs[byModel[m.OID].Key]!.AsObject();

            return (JsonNode)new JsonObject
            {
                ["oid"] = m.OID,
                ["name"] = m.Name,
                ["kind"] = KindName(m.Kind),
                ["case"] = EngineClient.CaseName(m.Case),
                ["label"] = m.Label,
                ["run"] = byModel[m.OID].Key,
                ["ade"] = Ade(SeriesResults(entry, KindName(m.Kind)), m.Kind == ForecastKindEnum.Imm ? "imm" : "hyb")
            };
        })];

        DbModel? firstImm = items.FirstOrDefault(m => m.Kind == ForecastKindEnum.Imm);
        DbModel? firstNet = items.FirstOrDefault(m => m.Kind != ForecastKindEnum.Imm);

        DbRun run = new()
        {
            Created = DateTime.Now,
            SourceFile = source.File,
            TrackRun = source.TrackRun,
            TrackId = source.TrackId,
            ScenarioName = scenarioName,
            Mode = RunModeEnum.Full,
            Case = items[0].Case,
            Ensemble = items.Any(m => m.Kind == ForecastKindEnum.Ens),
            Pd = source.Kind != SourceKindEnum.Radar ? model.Pd : null,
            RadarLat = source.Kind == SourceKindEnum.Radar ? model.RadarLat : null,
            RadarLon = source.Kind == SourceKindEnum.Radar ? model.RadarLon : null,
            RadarAlt = source.Kind == SourceKindEnum.Radar && model.RadarLat != null ? model.RadarAlt : null,
            Model = string.Join("; ", items.Select(m => m.Name)),
            TrackCount = displayTracks!.Count,
            ScanCount = displayTracks.Sum(t => t!["t"]!.AsArray().Count),
            DurationMs = durationMs,
            // ADE IMM - у первой выбранной модели IMM (не выбран - нет); AdeHyb - у первой модели не-IMM любого вида
            AdeImm = firstImm == null ? null : Ade(SeriesResults(runs[byModel[firstImm.OID].Key]!, "imm"), "imm"),
            AdeHyb = firstNet == null ? null : Ade(SeriesResults(runs[byModel[firstNet.OID].Key]!, KindName(firstNet.Kind)), "hyb"),
            RunModels = [.. items.Select((m, i) => new DbRunModel { Model = m, Position = i })]
        };

        JsonObject result = new()
        {
            ["oid"] = run.OID,
            ["mode"] = "full",
            ["format"] = 2,
            ["pd"] = run.Pd,
            ["info"] = new JsonObject
            {
                ["period_s"] = info["period_s"]!.DeepClone(),
                ["horizon"] = info["horizon"]!.DeepClone(),
                ["phases"] = info["phases"]!.DeepClone()
            },
            ["models"] = models,
            ["tracks"] = displayTracks,
            ["runs"] = runs
        };

        await File.WriteAllTextAsync(storage.RunPath(run.OID), result.ToJsonString(), ct);

        db.Runs.Add(run);
        await db.SaveChangesAsync(ct);

        logger.LogInformation("Запуск {Run}: {File}, моделей {Count} ({Models}), кусков {Tracks}, обзоров {Scans}, ADE IMM {AdeImm:F1} м, " +
            "модель {AdeHyb:F1} м, движок {Engine:F0} мс, всего {Total:F0} мс", run.OID, source.Name, items.Count, run.Model,
            run.TrackCount, run.ScanCount, run.AdeImm, run.AdeHyb, run.DurationMs, Stopwatch.GetElapsedTime(started).TotalMilliseconds);

        return await Query().FirstAsync(r => r.OID == run.OID, ct);
    }

    // ответы движка по кускам для вида прогноза: ансамбль - из прогона с ensemble, IMM и гибрид - из прогона одной сети
    // (если его нет - IMM берётся из прогона ансамбля, он тот же)
    private static JsonArray SeriesResults(JsonNode entry, string kind) =>
        (kind == "ens" || entry["single"] == null ? entry["ensemble"] : entry["single"])!.AsArray();

    // ADE по всем кускам - среднее по всем парам обзор-горизонт: взвешивается числом пар куска; нет истины - null
    private static double? Ade(JsonArray results, string key)
    {
        List<JsonNode> withErrors = [.. results
            .Where(r => r!["errors"] is JsonObject e && e[key]!["ade"] != null)
            .Select(r => r!["errors"]![key]!)];
        double pairs = withErrors.Sum(e => e["n"]!.GetValue<double>());

        return pairs > 0 ? withErrors.Sum(e => e["ade"]!.GetValue<double>() * e["n"]!.GetValue<double>()) / pairs : null;
    }

    private async Task<JsonArray> RunTracksAsync(JsonArray tracks, string bundlePath, bool ensemble, string? seeds, CancellationToken ct)
    {
        JsonArray results = [];

        foreach (JsonNode? track in tracks)
        {
            JsonObject body = new()
            {
                ["track"] = track!.DeepClone(),
                ["bundle"] = bundlePath,
                ["ensemble"] = ensemble,
                ["members"] = MembersJson(seeds)
            };

            results.Add(await engine.PostAsync("run", body, ct));
        }

        return results;
    }

    // вид прогноза в файле результата и в API - как имя члена перечисления в camelCase
    public static string KindName(ForecastKindEnum kind) => kind switch
    {
        ForecastKindEnum.Imm => "imm",
        ForecastKindEnum.Hyb => "hyb",
        _ => "ens"
    };

    public async Task<JsonNode> ReadResultAsync(Guid oid, CancellationToken ct)
    {
        string path = storage.RunPath(oid);

        if (!File.Exists(path))
            throw new FileNotFoundException("Нет файла результата запуска", path);

        await using FileStream stream = File.OpenRead(path);

        return await JsonNode.ParseAsync(stream, cancellationToken: ct) ?? throw new InvalidDataException($"Пустой файл {path}");
    }

    // ряды прогноза файла результата: (подпись, ответы движка по кускам, поле прогноза imm или hyb)
    private static IEnumerable<(string Label, JsonArray Results, string Key)> ForecastSeries(JsonNode result)
    {
        // прогон целиком до справочника моделей: одна модель, IMM и гибрид из одного ответа
        if (result["format"] == null && result["mode"]?.GetValue<string>() != "compare")
        {
            JsonArray results = result["results"]!.AsArray();
            yield return ("гибрид", results, "hyb");
            yield return ("IMM", results, "imm");
            yield break;
        }

        // формат 2 - модели справочника: подпись - наименование модели (запятые заменены: подпись идёт в столбец CSV)
        if (result["format"]?.GetValue<int>() == 2)
        {
            foreach (JsonNode? m in result["models"]!.AsArray())
            {
                string kind = m!["kind"]!.GetValue<string>();
                JsonNode entry = result["runs"]![m["run"]!.GetValue<string>()]!;

                yield return (m["name"]!.GetValue<string>().Replace(',', ';'), SeriesResults(entry, kind), kind == "imm" ? "imm" : "hyb");
            }

            yield break;
        }

        // сравнение до справочника моделей: ключ прогона - случай доплера
        foreach (JsonNode? m in result["models"]!.AsArray())
        {
            string kind = m!["kind"]!.GetValue<string>();
            JsonNode entry = result["runs"]![m["case"]!.GetValue<string>()]!;
            JsonArray results = (kind == "ens" || entry["single"] == null ? entry["ensemble"] : entry["single"])!.AsArray();
            // без запятых: подпись идет в столбец CSV
            string label = kind switch { "imm" => "IMM", "hyb" => "гибрид", _ => "ансамбль" };

            yield return ($"{label} {m["case"]!.GetValue<string>()}", results, kind == "imm" ? "imm" : "hyb");
        }
    }

    // прогнозы для каждого обзора и горизонта - те же столбцы, что forecast.csv у predict.py диплома; у сравнения моделей
    // в столбце «метод» - вид прогноза и случай доплера
    public static string ForecastCsv(JsonNode result)
    {
        CultureInfo inv = CultureInfo.InvariantCulture;
        double period = result["info"]!["period_s"]!.GetValue<double>();
        StringBuilder csv = new();

        csv.AppendLine("кусок,k,t_s,h,t_прогноза_s,метод,east_m,north_m,lat,lon");

        JsonArray tracks = result["tracks"]!.AsArray();

        foreach ((string label, JsonArray results, string key) in ForecastSeries(result))
        {
            for (int i = 0; i < tracks.Count; i++)
            {
                JsonNode track = tracks[i]!;
                JsonNode res = results[i]!;
                JsonArray t = track["t"]!.AsArray();
                double t0 = t[0]!.GetValue<double>();

                JsonArray forecast = res[key]!.AsArray();
                JsonArray? geo = res[key + "_ll"] as JsonArray;

                foreach (JsonNode? kNode in res["ks"]!.AsArray())
                {
                    int k = kNode!.GetValue<int>();
                    JsonArray row = forecast[k]!.AsArray();
                    double tk = t[k]!.GetValue<double>() - t0;

                    for (int h = 0; h < row.Count; h++)
                    {
                        if (row[h] is not JsonArray point)
                            continue;

                        JsonArray? ll = geo?[k]?[h] as JsonArray;

                        csv.Append(track["name"]).Append(',').Append(k).Append(',')
                            .Append(tk.ToString("F1", inv)).Append(',').Append(h + 1).Append(',')
                            .Append((tk + (h + 1) * period).ToString("F1", inv)).Append(',').Append(label).Append(',')
                            .Append(point[0]!.GetValue<double>().ToString("F2", inv)).Append(',')
                            .Append(point[1]!.GetValue<double>().ToString("F2", inv)).Append(',')
                            .Append(ll == null ? string.Empty : ll[0]!.GetValue<double>().ToString("F7", inv)).Append(',')
                            .Append(ll == null ? string.Empty : ll[1]!.GetValue<double>().ToString("F7", inv))
                            .AppendLine();
                    }
                }
            }
        }

        return csv.ToString();
    }
}

// прогон движка: пакет, ансамбль, seed участников (DbModel.Seeds); Key - ключ ответов в файле результата и в записи обзора
public record EngineRunKey(string Key, string Bundle, bool Ensemble, string? Seeds);

// источник трассы запуска: загруженный файл (лог полёта или отметки РЛС) или траектория пакета прогона диплома
public class RunSource
{
    public DbSourceFile? File { get; init; }
    public string? TrackRun { get; init; }
    public string? TrackId { get; init; }

    public SourceKindEnum Kind => File?.Kind ?? SourceKindEnum.Track;

    public string Name => File?.FileName ?? TrackId ?? string.Empty;
}

public class RunCreateModel
{
    // полёт: загруженный файл или траектория пакета прогона (TrackRun - прогон, TrackId - id из tracks/index.json)
    public Guid? SourceFileOID { get; set; }
    public string? TrackRun { get; set; }
    public string? TrackId { get; set; }
    public List<Guid> Models { get; set; } = []; // модели справочника в порядке выбора, от одной
    public double Pd { get; set; } = 1.0; // вероятность обнаружения - у лога полёта и траектории
    public double? RadarLat { get; set; } // положение РЛС - только у файла отметок
    public double? RadarLon { get; set; }
    public double RadarAlt { get; set; }
}

public class RunRow
{
    public Guid OID { get; set; }
    public DateTime Created { get; set; }
    public Guid? SourceFileOID { get; set; } // нет у запуска по траектории пакета
    public string FileName { get; set; } = string.Empty; // имя файла или id траектории
    public SourceKindEnum Kind { get; set; }
    public string? TrackRun { get; set; }
    public string? TrackId { get; set; }
    public string? ScenarioName { get; set; } // запуск по сценарию: его наименование на момент запуска
    public RunModeEnum Mode { get; set; }
    public DopplerCaseEnum Case { get; set; }
    public bool Ensemble { get; set; }
    public double? Pd { get; set; }
    public double? RadarLat { get; set; }
    public double? RadarLon { get; set; }
    public double? RadarAlt { get; set; }
    public string? Model { get; set; }
    public List<Guid> ModelOIDs { get; set; } = []; // модели справочника по порядку; у старых запусков пусто
    public int TrackCount { get; set; }
    public int ScanCount { get; set; }
    public double? AdeImm { get; set; }
    public double? AdeHyb { get; set; } // ADE первой модели не-IMM (гибрид, сеть без IMM, CV, KF, ансамбль)
    public string? AdeModel { get; set; } // её наименование; у старых запусков нет - там гибрид случая
    public double DurationMs { get; set; }
}
