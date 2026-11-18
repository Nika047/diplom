using radar.forecast.data;
using radar.forecast.data.App;
using radar.forecast.Services;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace radar.forecast.Controllers;

// исходные файлы: загрузка своего лога или файла отметок, копия лога из flight_logs диплома
[Authorize]
[Route("api/[controller]")]
[ApiController]
public class SourceFilesController(RadarDbContext db, AppStorage storage, ILogger<SourceFilesController> logger) : ControllerBase
{
    private readonly RadarDbContext db = db;
    private readonly AppStorage storage = storage;
    private readonly ILogger<SourceFilesController> logger = logger;

    private const long MaxFileSize = 50L * 1024 * 1024;

    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct) => Ok(await db.SourceFiles
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
        .ToListAsync(ct));

    // логи полётов диплома, которые можно взять без загрузки
    [HttpGet(nameof(DiplomLogs))]
    public IActionResult DiplomLogs()
    {
        if (!Directory.Exists(storage.DiplomFlightLogs))
            return Ok(Array.Empty<object>());

        return Ok(new DirectoryInfo(storage.DiplomFlightLogs)
            .GetFiles("*.csv")
            .OrderBy(f => f.Name)
            .Select(f => new { name = f.Name, size = f.Length }));
    }

    [HttpPost(nameof(Upload))]
    [RequestSizeLimit(MaxFileSize)]
    public async Task<IActionResult> Upload([FromForm] UploadModel model, CancellationToken ct)
    {
        if (model.File == null || model.File.Length == 0)
            return BadRequest(new { message = "Файл не выбран" });

        if (!model.File.FileName.EndsWith(".csv", StringComparison.OrdinalIgnoreCase))
            return BadRequest(new { message = "Нужен файл CSV" });

        DbSourceFile file = new()
        {
            FileName = Path.GetFileName(model.File.FileName),
            Kind = model.Kind,
            Size = model.File.Length,
            Created = DateTime.Now
        };

        await using (FileStream stream = System.IO.File.Create(storage.SourcePath(file.OID)))
            await model.File.CopyToAsync(stream, ct);

        return Ok(await SaveAsync(file, ct));
    }

    [HttpPost(nameof(ImportDiplomLog))]
    public async Task<IActionResult> ImportDiplomLog(ImportDiplomLogModel model, CancellationToken ct)
    {
        string? source = storage.DiplomLogPath(model.Name ?? string.Empty);

        if (source == null)
            return BadRequest(new { message = $"Нет лога {model.Name} в {storage.DiplomFlightLogs}" });

        DbSourceFile file = new()
        {
            FileName = model.Name!,
            Kind = SourceKindEnum.Log,
            Size = new FileInfo(source).Length,
            Created = DateTime.Now,
            FromDiplom = true
        };

        System.IO.File.Copy(source, storage.SourcePath(file.OID));

        return Ok(await SaveAsync(file, ct));
    }

    [HttpDelete]
    public async Task<IActionResult> Delete([FromQuery] OidModel model, CancellationToken ct)
    {
        DbSourceFile? file = await db.SourceFiles.FirstOrDefaultAsync(f => f.OID == model.OID, ct);

        if (file == null)
            return NotFound(new { message = "Файл не найден" });

        if (await db.Runs.AnyAsync(r => r.SourceFile!.OID == model.OID, ct))
            return Conflict(new { message = "По файлу есть запуски - сначала удалите их" });

        if (await db.Scenarios.AnyAsync(s => s.SourceFile!.OID == model.OID, ct))
            return Conflict(new { message = "Файл есть в сценарии - сначала удалите сценарий или выберите в нём другой полёт" });

        db.SourceFiles.Remove(file);
        await db.SaveChangesAsync(ct);

        System.IO.File.Delete(storage.SourcePath(model.OID));
        logger.LogInformation("Файл {File} ({OID}) удалён", file.FileName, file.OID);

        return NoContent();
    }

    private async Task<SourceFileRow> SaveAsync(DbSourceFile file, CancellationToken ct)
    {
        db.SourceFiles.Add(file);
        await db.SaveChangesAsync(ct);

        logger.LogInformation("Файл {File} ({Kind}, {Size} байт) сохранён как {OID}", file.FileName, file.Kind, file.Size, file.OID);

        return new SourceFileRow
        {
            OID = file.OID,
            FileName = file.FileName,
            Kind = file.Kind,
            Size = file.Size,
            Created = file.Created,
            FromDiplom = file.FromDiplom
        };
    }
}

public class UploadModel
{
    public IFormFile? File { get; set; }
    public SourceKindEnum Kind { get; set; }
}

public class ImportDiplomLogModel
{
    public string? Name { get; set; }
}

public class SourceFileRow
{
    public Guid OID { get; set; }
    public string FileName { get; set; } = string.Empty;
    public SourceKindEnum Kind { get; set; }
    public long Size { get; set; }
    public DateTime Created { get; set; }
    public bool FromDiplom { get; set; }
    public int RunCount { get; set; }
}
