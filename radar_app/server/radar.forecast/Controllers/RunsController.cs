using System.Text;
using System.Text.Json.Nodes;

using radar.forecast.data;
using radar.forecast.data.App;
using radar.forecast.Services;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace radar.forecast.Controllers;

// запуски «прогон целиком»: создание по моделям справочника, история, результат, экспорт
[Authorize]
[Route("api/[controller]")]
[ApiController]
public class RunsController(RadarDbContext db, RunService runs, EngineClient engine, AppStorage storage, RealtimeService realtime,
    ILogger<RunsController> logger) : ControllerBase
{
    private readonly RadarDbContext db = db;
    private readonly RealtimeService realtime = realtime;
    private readonly RunService runs = runs;
    private readonly EngineClient engine = engine;
    private readonly AppStorage storage = storage;
    private readonly ILogger<RunsController> logger = logger;

    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct) => Ok(await runs.Query().ToListAsync(ct));

    // прогон целиком по моделям справочника (одна или несколько - сравнение на одной трассе); полёт - файл или траектория пакета
    [HttpPost]
    public async Task<IActionResult> Create(RunCreateModel model, CancellationToken ct)
    {
        string? error = await runs.CheckAsync(model, ct);

        if (error != null)
            return BadRequest(new { message = error });

        return Ok(await runs.CreateAsync(model, ct));
    }

    // трассы и ответы движка как есть (формат - RunService)
    [HttpGet(nameof(Result))]
    public IActionResult Result([FromQuery] OidModel model)
    {
        string path = storage.RunPath(model.OID);

        if (!System.IO.File.Exists(path))
            return NotFound(new { message = "Результат запуска не найден" });

        return PhysicalFile(path, "application/json");
    }

    [HttpGet(nameof(ExportForecast))]
    public async Task<IActionResult> ExportForecast([FromQuery] OidModel model, CancellationToken ct)
    {
        RunRow? run = await runs.Query().FirstOrDefaultAsync(r => r.OID == model.OID, ct);

        if (run == null)
            return NotFound(new { message = "Запуск не найден" });

        string csv = RunService.ForecastCsv(await runs.ReadResultAsync(model.OID, ct));

        // BOM - чтобы Excel открыл русские заголовки без выбора кодировки
        return File(Encoding.UTF8.GetPreamble().Concat(Encoding.UTF8.GetBytes(csv)).ToArray(), "text/csv",
            $"{Path.GetFileNameWithoutExtension(run.FileName)}_forecast_{EngineClient.CaseName(run.Case)}.csv");
    }

    // отметки куска лога в формате файла РЛС (predict.py --radar) и положение РЛС для повторного запуска по ним
    [HttpGet(nameof(RadarFile))]
    public async Task<IActionResult> RadarFile([FromQuery] RadarFileModel model, CancellationToken ct)
    {
        RunRow? run = await runs.Query().FirstOrDefaultAsync(r => r.OID == model.OID, ct);

        if (run == null)
            return NotFound(new { message = "Запуск не найден" });

        JsonArray tracks = (await runs.ReadResultAsync(model.OID, ct))["tracks"]!.AsArray();

        if (model.Track < 0 || model.Track >= tracks.Count)
            return BadRequest(new { message = $"Нет куска {model.Track}" });

        JsonNode response = await engine.PostAsync("tracks/radar-csv", new JsonObject { ["track"] = tracks[model.Track]!.DeepClone() }, ct);

        return Ok(new
        {
            fileName = $"{Path.GetFileNameWithoutExtension(run.FileName)}_radar_{model.Track}.csv",
            text = response["text"]!.GetValue<string>(),
            radar = response["radar"]
        });
    }

    [HttpDelete]
    public async Task<IActionResult> Delete([FromQuery] OidModel model, CancellationToken ct)
    {
        // открытая сессия реального времени иначе записала бы файл и запись уже после удаления
        if (realtime.Find(model.OID) != null)
            await realtime.StopAsync(model.OID, ct);

        DbRun? run = await db.Runs.FirstOrDefaultAsync(r => r.OID == model.OID, ct);

        if (run == null)
            return NotFound(new { message = "Запуск не найден" });

        db.Runs.Remove(run);
        await db.SaveChangesAsync(ct);

        System.IO.File.Delete(storage.RunPath(model.OID));
        logger.LogInformation("Запуск {Run} удалён", model.OID);

        return NoContent();
    }
}

public class OidModel
{
    public Guid OID { get; set; }
}

public class RadarFileModel
{
    public Guid OID { get; set; }
    public int Track { get; set; }
}
