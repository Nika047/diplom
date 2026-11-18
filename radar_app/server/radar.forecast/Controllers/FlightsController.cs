using System.Collections.Concurrent;
using System.Text.Json.Nodes;

using radar.forecast.data;
using radar.forecast.data.App;
using radar.forecast.Services;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace radar.forecast.Controllers;

// справочник полётов: логи flight_logs диплома (сводка - очисткой диплома в движке, выборка - в каждом прогоне), траектории
// генератора и расширения из пакетов прогонов (bundles/<прогон>/tracks) и загруженные файлы, по строке на полёт. Копии лога
// диплома, сделанные при запусках, сливаются с его строкой по имени файла
[Authorize]
[Route("api/[controller]")]
[ApiController]
public class FlightsController(RadarDbContext db, AppStorage storage, EngineClient engine) : ControllerBase
{
    private readonly RadarDbContext db = db;
    private readonly AppStorage storage = storage;
    private readonly EngineClient engine = engine;

    // сводка загруженного файла: файлы не меняются, движок разбирает каждый один раз за работу сервера
    private static readonly ConcurrentDictionary<Guid, JsonNode> Described = new();

    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct)
    {
        List<SourceFileRow> files = await db.SourceFiles
            .OrderByDescending(f => f.Created)
            .Select(f => new SourceFileRow
            {
                OID = f.OID,
                FileName = f.FileName,
                Kind = f.Kind,
                Size = f.Size,
                Created = f.Created,
                FromDiplom = f.FromDiplom,
                RunCount = db.Runs.Count(r => r.SourceFile!.OID == f.OID)
            })
            .ToListAsync(ct);

        JsonNode catalog = await engine.GetAsync("logs", ct);
        List<FlightRow> rows = [];

        foreach (JsonNode? log in catalog["logs"]!.AsArray())
        {
            string name = log!["name"]!.GetValue<string>();
            List<SourceFileRow> copies = files.Where(f => f.FromDiplom && f.FileName == name).ToList();

            FlightRow row = Summary(log);
            row.Key = name;
            row.FileName = name;
            row.Kind = SourceKindEnum.Log;
            row.Origin = log["source"]?.GetValue<string>() == "sim" ? FlightOriginEnum.Sim : FlightOriginEnum.Real;
            row.Splits = log["splits"]!.AsObject().ToDictionary(p => p.Key, p => p.Value?.GetValue<string>());
            row.Size = new FileInfo(Path.Combine(storage.DiplomFlightLogs, name)).Length;
            row.SourceFileOID = copies.FirstOrDefault()?.OID;
            row.RunCount = copies.Sum(f => f.RunCount);
            rows.Add(row);
        }

        // запуски по траекториям: (прогон, id) -> число
        Dictionary<(string?, string?), int> trackRuns = (await db.Runs
            .Where(r => r.TrackId != null)
            .Select(r => new { r.TrackRun, r.TrackId })
            .ToListAsync(ct))
            .GroupBy(r => (r.TrackRun, r.TrackId))
            .ToDictionary(g => g.Key, g => g.Count());

        foreach (JsonNode? track in (await engine.GetAsync("tracks", ct))["tracks"]!.AsArray())
        {
            string run = track!["run"]!.GetValue<string>();
            string id = track["id"]!.GetValue<string>();
            bool aug = track["kind"]?.GetValue<string>() == "aug";

            rows.Add(new FlightRow
            {
                Key = $"{run}/{id}",
                FileName = id,
                Kind = SourceKindEnum.Track,
                Origin = aug ? FlightOriginEnum.Aug : FlightOriginEnum.Synth,
                Run = run,
                TrackId = id,
                Detail = aug ? track["aug_kind"]?.GetValue<string>() : track["scenario"]?.GetValue<string>(),
                Aircraft = aug ? track["source_log"]?.GetValue<string>() : null,
                Rows = track["points"]?.GetValue<int>(),
                Pieces = 1,
                DurationS = track["duration_s"]?.GetValue<double>(),
                Splits = new Dictionary<string, string?> { [run] = track["set"]?.GetValue<string>() },
                RunCount = trackRuns.GetValueOrDefault((run, id))
            });
        }

        foreach (SourceFileRow file in files.Where(f => !f.FromDiplom))
        {
            JsonNode? summary = await DescribeAsync(file, ct);

            FlightRow row = summary == null ? new FlightRow() : Summary(summary);
            row.Key = file.OID.ToString();
            row.FileName = file.FileName;
            row.Kind = file.Kind;
            row.Origin = FlightOriginEnum.Manual;
            row.Size = file.Size;
            row.Created = file.Created;
            row.SourceFileOID = file.OID;
            row.RunCount = file.RunCount;
            row.Error = summary == null ? "Файл не разобран движком" : null;
            rows.Add(row);
        }

        return Ok(rows);
    }

    private async Task<JsonNode?> DescribeAsync(SourceFileRow file, CancellationToken ct)
    {
        if (Described.TryGetValue(file.OID, out JsonNode? cached))
            return cached;

        JsonObject body = new()
        {
            ["name"] = file.FileName,
            ["text"] = await System.IO.File.ReadAllTextAsync(storage.SourcePath(file.OID), ct),
            ["kind"] = file.Kind == SourceKindEnum.Log ? "log" : "radar"
        };

        try
        {
            JsonNode summary = await engine.PostAsync("logs/describe", body, ct);
            Described[file.OID] = summary;
            return summary;
        }
        catch (EngineException ex) when (ex.Status == StatusCodes.Status400BadRequest)
        {
            return null;
        }
    }

    private static FlightRow Summary(JsonNode node) => new()
    {
        Aircraft = node["aircraft"]?.GetValue<string>(),
        Rows = node["rows"]?.GetValue<int>(),
        Pieces = node["pieces"]?.GetValue<int>(),
        DurationS = node["duration_s"]?.GetValue<double>()
    };
}

// откуда полёт: реальный лог диплома, лог симулятора диплома, загружен вручную
public enum FlightOriginEnum
{
    [System.ComponentModel.Description("реальный")]
    Real = 0,

    [System.ComponentModel.Description("симулятор")]
    Sim = 1,

    [System.ComponentModel.Description("добавлен вручную")]
    Manual = 2,

    [System.ComponentModel.Description("сгенерирована")]
    Synth = 3, // траектория генератора диплома (bundles/<прогон>/tracks)

    [System.ComponentModel.Description("расширение")]
    Aug = 4, // копия реального полёта с изменением (скорость, РЛС, ...) - расширение обучающей выборки
}

public class FlightRow
{
    public string Key { get; set; } = string.Empty; // имя лога диплома, OID загруженного файла или <прогон>/<id траектории>
    public string FileName { get; set; } = string.Empty;
    public SourceKindEnum Kind { get; set; }
    public FlightOriginEnum Origin { get; set; }
    public string? Aircraft { get; set; } // аппарат лога; у расширения - исходный лог
    public int? Rows { get; set; }
    public int? Pieces { get; set; } // кусков после очистки лога; 0 - запускать нечего
    public double? DurationS { get; set; } // суммарная длительность кусков, с
    // выборка диплома по прогонам: { base_x1: train, merged_x1: val }; train, val, test, excluded, sim, analysis
    public Dictionary<string, string?> Splits { get; set; } = [];
    public string? Run { get; set; } // прогон пакета траектории
    public string? TrackId { get; set; }
    public string? Detail { get; set; } // сценарий генератора (straight, turn, ...) или вид расширения (speed, radar, ...)
    public long Size { get; set; }
    public DateTime? Created { get; set; }
    public Guid? SourceFileOID { get; set; }
    public int RunCount { get; set; }
    public string? Error { get; set; }
}
