using radar.forecast.Settings;

using Microsoft.Extensions.Options;

namespace radar.forecast.Services;

// папки хранилища: загруженные файлы и результаты запусков; логи полётов диплома - только чтение
public class AppStorage
{
    public string FilesDir { get; }
    public string RunsDir { get; }
    public string DiplomFlightLogs { get; }
    public string ModelsDir { get; }
    public string DiplomBundles { get; }

    private readonly string contentRoot;

    public AppStorage(IOptions<StorageSettings> options, IWebHostEnvironment env)
    {
        StorageSettings settings = options.Value;
        string root = Path.GetFullPath(Path.Combine(env.ContentRootPath, settings.Root));

        contentRoot = env.ContentRootPath;
        FilesDir = Path.Combine(root, "files");
        RunsDir = Path.Combine(root, "runs");
        ModelsDir = Path.Combine(root, "models");
        DiplomFlightLogs = Path.GetFullPath(Path.Combine(env.ContentRootPath, settings.DiplomFlightLogs));
        DiplomBundles = Path.GetFullPath(Path.Combine(env.ContentRootPath, settings.DiplomBundles));

        Directory.CreateDirectory(FilesDir);
        Directory.CreateDirectory(RunsDir);
        Directory.CreateDirectory(ModelsDir);
    }

    public string SourcePath(Guid oid) => Path.Combine(FilesDir, $"{oid}.csv");

    public string RunPath(Guid oid) => Path.Combine(RunsDir, $"{oid}.json");

    // папка пакета модели хранится от папки веб-проекта (DbModel.Bundle): переезд репозитория её не ломает
    public string BundlePath(string bundle) => Path.GetFullPath(Path.Combine(contentRoot, bundle));

    public string BundleKey(string fullPath) => Path.GetRelativePath(contentRoot, fullPath).Replace(Path.DirectorySeparatorChar, '/');

    // подпись пакета для таблицы: путь от папки пакетов диплома (<прогон>/<случай>/...) или «загружен»
    public string BundleTitle(string bundle)
    {
        string full = BundlePath(bundle);

        if (full.StartsWith(ModelsDir, StringComparison.OrdinalIgnoreCase))
            return "загружен";

        return DiplomBundleId(full) ?? bundle;
    }

    // путь пакета диплома от папки пакетов (как в файле сценария: merged_x1/dop_tele/compare/IMM_GRU); чужая папка - null
    public string? DiplomBundleId(string fullPath)
    {
        string rel = Path.GetRelativePath(DiplomBundles, fullPath);

        return rel.StartsWith("..") || Path.IsPathRooted(rel) ? null : rel.Replace(Path.DirectorySeparatorChar, '/');
    }

    // файл из flight_logs диплома по имени; имя с путём или чужой файл - null
    public string? DiplomLogPath(string name)
    {
        if (string.IsNullOrWhiteSpace(name) || Path.GetFileName(name) != name || !name.EndsWith(".csv", StringComparison.OrdinalIgnoreCase))
            return null;

        string path = Path.Combine(DiplomFlightLogs, name);

        return File.Exists(path) ? path : null;
    }
}
