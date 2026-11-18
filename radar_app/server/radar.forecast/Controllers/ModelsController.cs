using System.IO.Compression;
using System.Text.Json.Nodes;

using radar.forecast.data;
using radar.forecast.data.App;
using radar.forecast.Services;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace radar.forecast.Controllers;

// справочник моделей: модели диплома (ModelSeeder) и загруженные пакеты (zip: config.json и веса, формат этапа 11)
[Authorize]
[Route("api/[controller]")]
[ApiController]
public class ModelsController(RadarDbContext db, AppStorage storage, EngineClient engine, ILogger<ModelsController> logger) : ControllerBase
{
    private readonly RadarDbContext db = db;
    private readonly AppStorage storage = storage;
    private readonly EngineClient engine = engine;
    private readonly ILogger<ModelsController> logger = logger;

    private const long MaxZipSize = 500L * 1024 * 1024;

    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct)
    {
        List<ModelRow> rows = await db.Models
            .OrderByDescending(m => m.FromDiplom)
            .ThenBy(m => m.Run)
            .ThenBy(m => m.Case)
            .ThenBy(m => m.Bundle)
            .ThenBy(m => m.Kind)
            .Select(m => new ModelRow
            {
                OID = m.OID,
                Name = m.Name,
                Note = m.Note,
                Bundle = m.Bundle,
                Kind = m.Kind,
                Case = m.Case,
                Label = m.Label,
                Members = m.Members,
                Seeds = m.Seeds,
                Run = m.Run,
                FromDiplom = m.FromDiplom,
                Created = m.Created,
                RunCount = db.RunModels.Count(r => r.Model!.OID == m.OID)
            })
            .ToListAsync(ct);

        // состав - из config.json пакета (у видов одного пакета он общий, читается раз)
        Dictionary<string, BundleConfig?> configs = [];

        foreach (ModelRow r in rows)
        {
            if (!configs.TryGetValue(r.Bundle, out BundleConfig? cfg))
            {
                try
                {
                    cfg = ModelCatalog.ReadConfig(storage.BundlePath(r.Bundle));
                }
                catch (Exception ex) when (ex is InvalidDataException or System.Text.Json.JsonException or InvalidOperationException)
                {
                    cfg = null;
                }

                configs[r.Bundle] = cfg;
            }

            r.Composition = cfg == null ? "пакет не читается" : ModelCatalog.Composition(cfg, r.Kind, ModelCatalog.ParseSeeds(r.Seeds));
            r.Window = cfg?.Window;
            r.RunTitle = ModelCatalog.RunTitle(r.Run);
            r.ModelType = cfg?.ModelType ?? ModelCatalog.Hybrid;
            r.TypeTitle = ModelCatalog.TypeTitle(cfg, r.Kind);
            r.Bundle = storage.BundleTitle(r.Bundle);
        }

        return Ok(rows);
    }

    // пакет из zip: папка в хранилище, проверка движком (config.json и веса всех сетей читаются), по модели на вид
    [HttpPost(nameof(Upload))]
    [RequestSizeLimit(MaxZipSize)]
    [RequestFormLimits(MultipartBodyLengthLimit = MaxZipSize)]
    public async Task<IActionResult> Upload([FromForm] ModelUploadModel model, CancellationToken ct)
    {
        if (model.File == null || model.File.Length == 0)
            return BadRequest(new { message = "Файл не выбран" });

        if (!model.File.FileName.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
            return BadRequest(new { message = "Нужен архив zip с папкой пакета (config.json и веса .pt)" });

        if (string.IsNullOrWhiteSpace(model.Name))
            return BadRequest(new { message = "Нужно наименование" });

        if (model.Kinds.Count == 0)
            return BadRequest(new { message = "Не выбран ни один вид модели" });

        string folder = Path.Combine(storage.ModelsDir, Guid.NewGuid().ToString());

        try
        {
            Directory.CreateDirectory(folder);

            await using (Stream stream = model.File.OpenReadStream())
            {
                using ZipArchive zip = new(stream, ZipArchiveMode.Read);
                zip.ExtractToDirectory(folder);
            }

            string? dir = Directory.EnumerateFiles(folder, "config.json", SearchOption.AllDirectories)
                .Select(Path.GetDirectoryName)
                .OrderBy(d => d!.Length)
                .FirstOrDefault();

            if (dir == null)
                return Fail(folder, "В архиве нет config.json пакета");

            try
            {
                await engine.PostAsync("bundles/describe", new JsonObject { ["bundle"] = dir }, ct);
            }
            catch (EngineException ex) when (ex.Status == StatusCodes.Status400BadRequest)
            {
                return Fail(folder, ex.Message);
            }

            BundleConfig cfg = ModelCatalog.ReadConfig(dir)!;

            if (model.Kinds.Contains(ForecastKindEnum.Ens) && (!cfg.HasMembers || cfg.Seeds.Count < 2))
                return Fail(folder, cfg.HasMembers ? "Ансамбль нужен из двух и больше сетей, а в пакете одна"
                    : "У пакета CV, KF или жадного ансамбля сети не выбираются - вид «ансамбль» недоступен");

            List<DbModel> created = [.. model.Kinds.Distinct().Order().Select(kind => new DbModel
            {
                Name = model.Kinds.Count == 1 ? model.Name.Trim() : $"{model.Name.Trim()}, {ModelCatalog.KindTitle(kind)}",
                Note = string.IsNullOrWhiteSpace(model.Note)
                    ? ModelCatalog.DefaultNote(cfg, kind, "Загруженная модель", cfg.Run ?? "не указан") : model.Note.Trim(),
                Bundle = storage.BundleKey(dir),
                Kind = kind,
                Case = cfg.Case,
                Label = ModelCatalog.NetName(cfg.Label),
                Members = cfg.Seeds.Count,
                Run = cfg.Run,
                FromDiplom = false,
                Created = DateTime.Now
            })];

            db.Models.AddRange(created);
            await db.SaveChangesAsync(ct);

            logger.LogInformation("Пакет модели {File} ({Case}, сетей {Members}) сохранён в {Dir}: моделей {Count}",
                model.File.FileName, cfg.Case, cfg.Seeds.Count, dir, created.Count);

            return Ok(created.Select(m => m.OID));
        }
        catch (Exception ex) when (ex is InvalidDataException or IOException)
        {
            // IOException - в том числе элемент архива с путём вне папки распаковки
            return Fail(folder, $"Архив не читается: {ex.Message}");
        }
    }

    [HttpPost(nameof(Update))]
    public async Task<IActionResult> Update(ModelUpdateModel model, CancellationToken ct)
    {
        DbModel? item = await db.Models.FirstOrDefaultAsync(m => m.OID == model.OID, ct);

        if (item == null)
            return NotFound(new { message = "Модель не найдена" });

        if (string.IsNullOrWhiteSpace(model.Name))
            return BadRequest(new { message = "Нужно наименование" });

        item.Name = model.Name.Trim();
        item.Note = string.IsNullOrWhiteSpace(model.Note) ? null : model.Note.Trim();
        item.Edited = true;
        await db.SaveChangesAsync(ct);

        return NoContent();
    }

    // модели диплома и модели с запусками не удаляются; папка загруженного пакета - когда на неё не ссылается ни одна модель
    [HttpDelete]
    public async Task<IActionResult> Delete([FromQuery] OidModel model, CancellationToken ct)
    {
        DbModel? item = await db.Models.FirstOrDefaultAsync(m => m.OID == model.OID, ct);

        if (item == null)
            return NotFound(new { message = "Модель не найдена" });

        if (item.FromDiplom)
            return Conflict(new { message = "Модели диплома не удаляются: они заводятся из пакетов диплома при запуске сервера" });

        if (await db.RunModels.AnyAsync(r => r.Model!.OID == model.OID, ct))
            return Conflict(new { message = "По модели есть запуски - сначала удалите их в истории" });

        if (await db.ScenarioModels.AnyAsync(r => r.Model!.OID == model.OID, ct))
            return Conflict(new { message = "Модель есть в сценарии - сначала уберите её из сценария" });

        db.Models.Remove(item);
        await db.SaveChangesAsync(ct);

        string dir = storage.BundlePath(item.Bundle);

        if (!await db.Models.AnyAsync(m => m.Bundle == item.Bundle, ct) && dir.StartsWith(storage.ModelsDir, StringComparison.OrdinalIgnoreCase))
            DeleteUploadFolder(dir);

        logger.LogInformation("Модель {Name} ({OID}) удалена", item.Name, item.OID);

        return NoContent();
    }

    private BadRequestObjectResult Fail(string folder, string message)
    {
        DeleteUploadFolder(folder);
        return BadRequest(new { message });
    }

    // папка загрузки целиком: <ModelsDir>/<guid> (пакет может лежать во вложенной папке архива); ничего вне её не удаляется
    private void DeleteUploadFolder(string dir)
    {
        string first = Path.GetRelativePath(storage.ModelsDir, dir).Split(Path.DirectorySeparatorChar)[0];

        if (!Guid.TryParse(first, out _))
            return;

        string top = Path.Combine(storage.ModelsDir, first);

        if (Directory.Exists(top))
            Directory.Delete(top, true);
    }
}

public class ModelUploadModel
{
    public IFormFile? File { get; set; }
    public string? Name { get; set; }
    public string? Note { get; set; }
    public List<ForecastKindEnum> Kinds { get; set; } = [];
}

public class ModelUpdateModel
{
    public Guid OID { get; set; }
    public string? Name { get; set; }
    public string? Note { get; set; }
}

public class ModelRow
{
    public Guid OID { get; set; }
    public string Name { get; set; } = string.Empty;
    public string? Note { get; set; }
    public string Bundle { get; set; } = string.Empty; // подпись пакета: <прогон>/<случай>... или «загружен»
    public ForecastKindEnum Kind { get; set; }
    public DopplerCaseEnum Case { get; set; }
    public string? Label { get; set; }
    public int Members { get; set; }
    public string? Seeds { get; set; }
    public string? Run { get; set; } // прогон диплома - вид входных данных обучения
    public string RunTitle { get; set; } = string.Empty;
    public string ModelType { get; set; } = string.Empty; // вид модели пакета: hybrid, e2e, classic, ensemble
    public string TypeTitle { get; set; } = string.Empty; // вид для таблицы: IMM, гибрид, сеть без IMM, фильтр Калмана, ...
    public string Composition { get; set; } = string.Empty; // состав из config.json пакета: фильтр, сеть, окно, seed, доплер
    public int? Window { get; set; }
    public bool FromDiplom { get; set; }
    public DateTime Created { get; set; }
    public int RunCount { get; set; }
}
