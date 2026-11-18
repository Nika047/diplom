using radar.forecast.data;
using radar.forecast.data.App;
using radar.forecast.Services;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace radar.forecast.Controllers;

// сценарии: готовые наборы параметров запуска - форма (создание, правка), загрузка файлом (формат radar_app/scenario), запуск
// (запись в истории со ссылкой на сценарий)
[Authorize]
[Route("api/[controller]")]
[ApiController]
public class ScenariosController(RadarDbContext db, ScenarioService scenarios, ILogger<ScenariosController> logger) : ControllerBase
{
    private readonly RadarDbContext db = db;
    private readonly ScenarioService scenarios = scenarios;
    private readonly ILogger<ScenariosController> logger = logger;

    private const long MaxFileSize = 1024 * 1024;

    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct) => Ok(await scenarios.Query().ToListAsync(ct));

    [HttpGet(nameof(Get))]
    public async Task<IActionResult> Get([FromQuery] OidModel model, CancellationToken ct)
    {
        ScenarioRow? row = await scenarios.Query().FirstOrDefaultAsync(s => s.OID == model.OID, ct);

        return row == null ? NotFound(new { message = "Сценарий не найден" }) : Ok(row);
    }

    // создание (OID нет) и правка сценария формы; ошибки - списком, как у файла
    [HttpPost(nameof(Save))]
    public async Task<IActionResult> Save(ScenarioEditModel model, CancellationToken ct)
    {
        if (model.OID != null && !await db.Scenarios.AnyAsync(s => s.OID == model.OID, ct))
            return NotFound(new { message = "Сценарий не найден" });

        List<string> errors = await scenarios.CheckAsync(model, string.Empty, await scenarios.CatalogsAsync(ct), ct);

        if (errors.Count > 0)
            return BadRequest(new { message = string.Join("; ", errors), errors });

        DbScenario item = await scenarios.SaveAsync(model, ct);
        await db.SaveChangesAsync(ct);

        logger.LogInformation("Сценарий {Name} ({OID}) сохранён", item.Name, item.OID);

        return Ok(await scenarios.Query().FirstAsync(s => s.OID == item.OID, ct));
    }

    // файл сценариев: все или ничего - при любой ошибке ничего не сохраняется
    [HttpPost(nameof(Upload))]
    [RequestSizeLimit(MaxFileSize)]
    public async Task<IActionResult> Upload([FromForm] ScenarioUploadModel model, CancellationToken ct)
    {
        if (model.File == null || model.File.Length == 0)
            return BadRequest(new { message = "Файл не выбран" });

        using StreamReader reader = new(model.File.OpenReadStream());
        (List<ScenarioEditModel> items, List<string> errors) = await scenarios.ParseAsync(await reader.ReadToEndAsync(ct), ct);

        if (errors.Count > 0)
            return BadRequest(new { message = $"Файл не загружен, ошибок {errors.Count}: {string.Join("; ", errors.Take(5))}", errors });

        List<DbScenario> saved = [];

        foreach (ScenarioEditModel item in items)
            saved.Add(await scenarios.SaveAsync(item, ct));

        await db.SaveChangesAsync(ct);

        logger.LogInformation("Файл сценариев {File}: загружено {Count}", model.File.FileName, saved.Count);

        return Ok(saved.Select(s => s.OID));
    }

    [HttpDelete]
    public async Task<IActionResult> Delete([FromQuery] OidModel model, CancellationToken ct)
    {
        DbScenario? item = await db.Scenarios.FirstOrDefaultAsync(s => s.OID == model.OID, ct);

        if (item == null)
            return NotFound(new { message = "Сценарий не найден" });

        // запуски по сценарию остаются в истории с его наименованием
        db.Scenarios.Remove(item);
        await db.SaveChangesAsync(ct);

        logger.LogInformation("Сценарий {Name} ({OID}) удалён", item.Name, item.OID);

        return NoContent();
    }

    // запуск: прогон целиком или сессия реального времени (с перемоткой и пуском, если заданы); ответ - OID запуска и режим
    [HttpPost(nameof(Run))]
    public async Task<IActionResult> Run(OidModel model, CancellationToken ct)
    {
        if (!await db.Scenarios.AnyAsync(s => s.OID == model.OID, ct))
            return NotFound(new { message = "Сценарий не найден" });

        (Guid run, RunModeEnum mode) = await scenarios.RunAsync(model.OID, ct);

        return Ok(new { oid = run, mode });
    }
}

public class ScenarioUploadModel
{
    public IFormFile? File { get; set; }
}
