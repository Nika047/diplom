using System.Text.Json;
using System.Text.Json.Nodes;

using radar.forecast.data;
using radar.forecast.data.App;

using Microsoft.EntityFrameworkCore;

namespace radar.forecast.Services;

// сценарии: проверка (общая для формы и файла), разбор файла формата radar_app/scenario версии 1, запуск. Формат файла -
// .agent_docs/ARCHITECTURE.md, «Сценарии». Ошибки - с путём поля: scenarios[0].models[2].members: ...
public class ScenarioService(RadarDbContext db, AppStorage storage, EngineClient engine, RunService runs, RealtimeService realtime)
{
    private readonly RadarDbContext db = db;
    private readonly AppStorage storage = storage;
    private readonly EngineClient engine = engine;
    private readonly RunService runs = runs;
    private readonly RealtimeService realtime = realtime;

    public const string Format = "radar_app/scenario";
    public const int Version = 1;

    public static readonly int[] HorizonSeconds = [2, 4, 6, 8, 10];
    public static readonly string[] Basemaps = ["osm", "yandex", "plane"];
    public static readonly string[] LayerNames = ["plots", "truth", "phases", "variants", "gate"];

    public IQueryable<ScenarioRow> Query() => db.Scenarios
        .OrderBy(s => s.Name)
        .Select(s => new ScenarioRow
        {
            OID = s.OID,
            Name = s.Name,
            Note = s.Note,
            FlightSource = s.FlightSource,
            LogName = s.LogName,
            SourceFileOID = s.SourceFile != null ? s.SourceFile.OID : null,
            SourceFileName = s.SourceFile != null ? s.SourceFile.FileName : null,
            SourceFileKind = s.SourceFile != null ? s.SourceFile.Kind : null,
            TrackRun = s.TrackRun,
            TrackId = s.TrackId,
            Piece = s.Piece,
            Mode = s.Mode,
            Speed = s.Speed,
            StartScan = s.StartScan,
            Autoplay = s.Autoplay,
            Pd = s.Pd,
            RadarLat = s.RadarLat,
            RadarLon = s.RadarLon,
            RadarAlt = s.RadarAlt,
            Basemap = s.Basemap,
            Horizons = s.Horizons,
            Layers = s.Layers,
            Focus = s.Focus,
            Follow = s.Follow,
            ModelOIDs = s.ScenarioModels.OrderBy(m => m.Position).Select(m => m.Model!.OID).ToList(),
            ModelNames = s.ScenarioModels.OrderBy(m => m.Position).Select(m => m.Model!.Name).ToList(),
            RunCount = db.Runs.Count(r => r.ScenarioName == s.Name),
            Created = s.Created
        });

    // проверка сценария формы или файла: ошибки (поле, текст); prefix - путь сценария в файле
    public async Task<List<string>> CheckAsync(ScenarioEditModel m, string prefix, Catalogs catalogs, CancellationToken ct)
    {
        List<string> errors = [];
        void Error(string field, string text) => errors.Add($"{prefix}{field}: {text}");

        if (string.IsNullOrWhiteSpace(m.Name))
            Error("name", "нужно наименование");
        else if (m.Name.Trim().Length > 200)
            Error("name", "не длиннее 200 символов");
        else if (await db.Scenarios.AnyAsync(s => s.Name == m.Name.Trim() && s.OID != m.OID, ct))
            Error("name", $"сценарий «{m.Name.Trim()}» уже есть");

        // полёт: кусков у лога - по сводке движка, у траектории и файла отметок - один
        int? pieces = null;
        SourceKindEnum? fileKind = null;

        switch (m.FlightSource)
        {
            case FlightSourceEnum.Log:
                if (storage.DiplomLogPath(m.LogName ?? string.Empty) == null)
                    Error("flight.file", $"нет лога {m.LogName} в flight_logs диплома");
                else
                    pieces = catalogs.LogPieces.GetValueOrDefault(m.LogName!);
                fileKind = SourceKindEnum.Log;
                break;

            case FlightSourceEnum.Upload:
                DbSourceFile? file = await db.SourceFiles.FirstOrDefaultAsync(f => f.OID == m.SourceFileOID && !f.FromDiplom, ct);
                if (file == null)
                    Error("flight.file", "нет такого загруженного файла");
                else
                    fileKind = file.Kind;
                break;

            default:
                if (!catalogs.Tracks.Contains((m.TrackRun ?? string.Empty, m.TrackId ?? string.Empty)))
                    Error("flight.id", $"нет траектории {m.TrackId} в bundles/{m.TrackRun}/tracks");
                pieces = 1;
                break;
        }

        if (pieces == 0)
            Error("flight.file", "в логе не осталось кусков после очистки - запускать нечего");

        if (m.Piece != null && (m.Piece < 0 || (pieces != null && m.Piece >= pieces)))
            Error("flight.piece", pieces == null ? "номер куска от 0" : $"номер куска от 0 до {pieces - 1}");

        if (m.Models.Count == 0)
            Error("models", "нужна хотя бы одна модель");
        else if (m.Models.Distinct().Count() != m.Models.Count)
            Error("models", "модели повторяются");
        else if (await db.Models.CountAsync(x => m.Models.Contains(x.OID), ct) != m.Models.Count)
            Error("models", "модели нет в справочнике");

        if (m.Mode == RunModeEnum.Realtime)
        {
            if (m.Speed != null && (m.Speed < RealtimeService.MinSpeed || m.Speed > RealtimeService.MaxSpeed))
                Error("mode.speed", $"ускорение от {RealtimeService.MinSpeed} до {RealtimeService.MaxSpeed}");
            if (m.StartScan != null && m.StartScan < 0)
                Error("mode.start_scan", "номер обзора от 0");
        }
        else if (m.Mode == RunModeEnum.Full)
        {
            if (m.Speed != null || m.StartScan != null)
                Error("mode", "ускорение и начальный обзор - только у реального времени");
        }
        else
        {
            Error("mode.type", "full или realtime");
        }

        bool radarFile = fileKind == SourceKindEnum.Radar;

        if (!radarFile && m.Pd != null && (m.Pd <= 0 || m.Pd > 1))
            Error("radar.pd", "вероятность обнаружения от 0 (не включая) до 1");
        if (radarFile && m.Pd != null)
            Error("radar.pd", "у файла отметок РЛС вероятность обнаружения не задаётся: пропуски уже в файле");

        if (!radarFile && (m.RadarLat != null || m.RadarLon != null || m.RadarAlt != null))
            Error("radar", "координаты РЛС - только у файла отметок; у лога и траектории РЛС ставит модель РЛС диплома");
        if (radarFile && (m.RadarLat == null) != (m.RadarLon == null))
            Error("radar", "нужны и широта, и долгота РЛС или ни то, ни другое");
        if (radarFile && m.RadarAlt != null && m.RadarLat == null && m.RadarLon == null)
            Error("radar.alt", "высота РЛС - только вместе с широтой и долготой");
        if (m.RadarLat is < -90 or > 90)
            Error("radar.lat", "широта от -90 до 90");
        if (m.RadarLon is < -180 or > 180)
            Error("radar.lon", "долгота от -180 до 180");

        if (m.Basemap != null && !Basemaps.Contains(m.Basemap))
            Error("view.basemap", $"одно из: {string.Join(", ", Basemaps)}");
        else if (m.FlightSource == FlightSourceEnum.Track && m.Basemap != null && m.Basemap != "plane")
            Error("view.basemap", "у траектории пакета широты и долготы нет - только plane");
        // явно заданная подложка, которую нельзя показать, - ошибка, а не подмена плоскостью
        else if (radarFile && (m.RadarLat == null || m.RadarLon == null) && m.Basemap is "osm" or "yandex")
            Error("view.basemap", "у файла отметок без radar.lat / lon подложки нет, укажите координаты или plane");

        if (m.Focus == true && m.Follow == true)
            Error("view", "фокус на прогнозе и слежение за целью вместе нельзя - выберите одно");

        if (m.Mode == RunModeEnum.Realtime && m.Models.Count >= RealtimeService.ManyModels
            && (m.Speed ?? 1) > RealtimeService.SpeedLimit(m.Models.Count))
            Error("mode.speed", $"при {RealtimeService.ManyModels} моделях и больше ускорение не выше {RealtimeService.LimitedSpeed}");
        if (m.Horizons != null && (m.Horizons.Count == 0 || m.Horizons.Any(h => !HorizonSeconds.Contains(h))))
            Error("view.horizons_s", $"секунды из {string.Join(", ", HorizonSeconds)}");
        if (m.Layers != null && m.Layers.Any(l => !LayerNames.Contains(l)))
            Error("view.layers", $"слои из: {string.Join(", ", LayerNames)}");

        return errors;
    }

    // справочники движка для проверки: куски логов диплома и траектории пакетов
    public async Task<Catalogs> CatalogsAsync(CancellationToken ct)
    {
        JsonNode logs = await engine.GetAsync("logs", ct);
        JsonNode tracks = await engine.GetAsync("tracks", ct);

        return new Catalogs
        {
            LogPieces = logs["logs"]!.AsArray().ToDictionary(l => l!["name"]!.GetValue<string>(), l => l!["pieces"]?.GetValue<int>() ?? 0),
            Tracks = [.. tracks["tracks"]!.AsArray().Select(t => (t!["run"]!.GetValue<string>(), t["id"]!.GetValue<string>()))]
        };
    }

    public async Task<DbScenario> SaveAsync(ScenarioEditModel m, CancellationToken ct)
    {
        DbScenario item = m.OID == null
            ? new DbScenario { Created = DateTime.Now }
            : await db.Scenarios.Include(s => s.ScenarioModels).FirstAsync(s => s.OID == m.OID, ct);

        item.Name = m.Name!.Trim();
        item.Note = string.IsNullOrWhiteSpace(m.Note) ? null : m.Note.Trim();
        item.FlightSource = m.FlightSource;
        item.LogName = m.FlightSource == FlightSourceEnum.Log ? m.LogName : null;
        item.SourceFile = m.FlightSource == FlightSourceEnum.Upload ? await db.SourceFiles.FirstAsync(f => f.OID == m.SourceFileOID, ct) : null;
        item.TrackRun = m.FlightSource == FlightSourceEnum.Track ? m.TrackRun : null;
        item.TrackId = m.FlightSource == FlightSourceEnum.Track ? m.TrackId : null;
        item.Piece = m.Piece;
        item.Mode = m.Mode;
        item.Speed = m.Mode == RunModeEnum.Realtime ? m.Speed : null;
        item.StartScan = m.Mode == RunModeEnum.Realtime ? m.StartScan : null;
        item.Autoplay = m.Autoplay;
        item.Pd = m.Pd;
        item.RadarLat = m.RadarLat;
        item.RadarLon = m.RadarLon;
        item.RadarAlt = m.RadarLat == null ? null : m.RadarAlt;
        item.Basemap = m.Basemap;
        item.Horizons = m.Horizons == null ? null : string.Join(",", m.Horizons.Distinct().Order());
        item.Layers = m.Layers == null ? null : string.Join(",", m.Layers.Distinct());
        item.Focus = m.Focus;
        item.Follow = m.Follow;

        Dictionary<Guid, DbModel> models = await db.Models.Where(x => m.Models.Contains(x.OID)).ToDictionaryAsync(x => x.OID, ct);
        db.ScenarioModels.RemoveRange(item.ScenarioModels);
        item.ScenarioModels = [.. m.Models.Select((oid, i) => new DbScenarioModel { Model = models[oid], Position = i })];

        if (m.OID == null)
            db.Scenarios.Add(item);

        return item;
    }

    // запуск сценария: запись в истории со ссылкой на сценарий; лог диплома - через копию в хранилище, как при запуске из формы
    public async Task<(Guid Run, RunModeEnum Mode)> RunAsync(Guid oid, CancellationToken ct)
    {
        DbScenario s = await db.Scenarios
            .Include(x => x.SourceFile)
            .Include(x => x.ScenarioModels).ThenInclude(x => x.Model)
            .FirstAsync(x => x.OID == oid, ct);

        Guid? fileOid = s.FlightSource switch
        {
            FlightSourceEnum.Log => (await DiplomLogCopyAsync(s.LogName!, ct)).OID,
            FlightSourceEnum.Upload => s.SourceFile!.OID,
            _ => null
        };

        RealtimeCreateModel model = new()
        {
            SourceFileOID = fileOid,
            TrackRun = s.TrackRun,
            TrackId = s.TrackId,
            Models = [.. s.ScenarioModels.OrderBy(m => m.Position).Select(m => m.Model!.OID)],
            Pd = s.Pd ?? 1.0,
            RadarLat = s.RadarLat,
            RadarLon = s.RadarLon,
            RadarAlt = s.RadarAlt ?? 0,
            Track = s.Piece,
            Speed = s.Speed ?? 1
        };

        string? error = await runs.CheckAsync(model, ct);

        if (error != null)
            throw new EngineException(StatusCodes.Status400BadRequest, error);

        if (s.Mode == RunModeEnum.Full)
            return ((await runs.CreateAsync(model, ct, s.Name)).OID, RunModeEnum.Full);

        RealtimeSession session = await realtime.CreateAsync(model, ct, s.Name);

        if (s.StartScan > 0 || s.Autoplay)
        {
            await realtime.ControlAsync(session.OID, async x =>
            {
                if (s.StartScan > 0)
                    await realtime.SeekAsync(x, Math.Min(s.StartScan.Value, x.Total - 1), ct);
                if (s.Autoplay)
                    realtime.Play(x, s.Speed);
            }, ct);
        }

        return (session.OID, RunModeEnum.Realtime);
    }

    // копия лога диплома в хранилище (DbSourceFile.FromDiplom): последняя по имени или новая
    private async Task<DbSourceFile> DiplomLogCopyAsync(string name, CancellationToken ct)
    {
        DbSourceFile? copy = await db.SourceFiles
            .Where(f => f.FromDiplom && f.FileName == name)
            .OrderByDescending(f => f.Created)
            .FirstOrDefaultAsync(ct);

        if (copy != null && File.Exists(storage.SourcePath(copy.OID)))
            return copy;

        string source = storage.DiplomLogPath(name) ?? throw new EngineException(StatusCodes.Status400BadRequest, $"Нет лога {name}");

        copy = new DbSourceFile
        {
            FileName = name,
            Kind = SourceKindEnum.Log,
            Size = new FileInfo(source).Length,
            Created = DateTime.Now,
            FromDiplom = true
        };

        File.Copy(source, storage.SourcePath(copy.OID));
        db.SourceFiles.Add(copy);
        await db.SaveChangesAsync(ct);

        return copy;
    }

    // ------------------------------------------------------------------------------------------------------------------
    // файл сценариев
    // ------------------------------------------------------------------------------------------------------------------

    // разбор файла: сценарии формы (модели - OID справочника) и ошибки; при любой ошибке ничего не сохраняется
    public async Task<(List<ScenarioEditModel> Items, List<string> Errors)> ParseAsync(string text, CancellationToken ct)
    {
        List<string> errors = [];
        List<ScenarioEditModel> items = [];
        JsonNode? root;

        try
        {
            root = JsonNode.Parse(text, documentOptions: new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true });
        }
        catch (JsonException ex)
        {
            return (items, [$"файл не JSON: {ex.Message}"]);
        }

        if (root is not JsonObject top)
            return (items, ["в файле нужен объект { format, version, scenarios }"]);

        Unknown(top, "", ["format", "version", "scenarios"], errors);

        if (Str(top, "format", "", errors, true) != Format)
            errors.Add($"format: ожидается \"{Format}\"");
        if (Int(top, "version", "", errors, true) != Version)
            errors.Add($"version: приложение знает версию {Version}");

        if (top["scenarios"] is not JsonArray list || list.Count == 0)
        {
            errors.Add("scenarios: нужен массив хотя бы из одного сценария");
            return (items, errors);
        }

        List<DbModel> catalog = await db.Models.Where(m => m.FromDiplom).ToListAsync(ct);
        Catalogs catalogs = await CatalogsAsync(ct);
        HashSet<string> names = [];

        for (int i = 0; i < list.Count; i++)
        {
            string p = $"scenarios[{i}].";

            if (list[i] is not JsonObject s)
            {
                errors.Add($"scenarios[{i}]: нужен объект");
                continue;
            }

            Unknown(s, p, ["name", "note", "flight", "models", "mode", "radar", "view"], errors);

            ScenarioEditModel m = new()
            {
                Name = Str(s, "name", p, errors, true),
                Note = Str(s, "note", p, errors, false)
            };

            if (m.Name != null && !names.Add(m.Name.Trim()))
                errors.Add($"{p}name: наименование повторяется в файле");

            bool allPieces = await ParseFlightAsync(s["flight"], p + "flight", m, errors, ct);
            ParseModels(s["models"], p + "models", m, catalog, errors);
            ParseMode(s["mode"], p + "mode", m, errors);

            // реальное время идёт по одному куску: без поля - самый длинный
            if (allPieces && m.Mode == RunModeEnum.Realtime)
                errors.Add($"{p}flight.piece: в реальном времени - один кусок (\"all\" нельзя; без поля - самый длинный)");
            ParseRadar(s["radar"], p + "radar", m, errors);
            ParseView(s["view"], p + "view", m, errors);

            errors.AddRange(await CheckAsync(m, p, catalogs, ct));
            items.Add(m);
        }

        return (items, errors.Distinct().ToList());
    }

    // полёт; true - кусок задан как "all"
    private async Task<bool> ParseFlightAsync(JsonNode? node, string p, ScenarioEditModel m, List<string> errors, CancellationToken ct)
    {
        if (node is not JsonObject f)
        {
            errors.Add($"{p}: нужен объект {{ source, ... }}");
            return false;
        }

        Unknown(f, p + ".", ["source", "file", "id", "run", "piece"], errors);

        string? source = Str(f, "source", p + ".", errors, true);
        m.FlightSource = source switch
        {
            "log" => FlightSourceEnum.Log,
            "upload" => FlightSourceEnum.Upload,
            "track" => FlightSourceEnum.Track,
            _ => FlightSourceEnum.Log
        };

        if (source is not ("log" or "upload" or "track"))
            errors.Add($"{p}.source: log, upload или track");

        if (source == "track")
        {
            m.TrackRun = Str(f, "run", p + ".", errors, true);
            m.TrackId = Str(f, "id", p + ".", errors, true);
            if (f["file"] != null)
                errors.Add($"{p}.file: у траектории - run и id, а не file");
        }
        else
        {
            string? file = Str(f, "file", p + ".", errors, true);
            if (f["id"] != null || f["run"] != null)
                errors.Add($"{p}: run и id - только у траектории (source: track)");

            if (source == "log")
                m.LogName = file;
            else if (file != null)
            {
                List<Guid> found = await db.SourceFiles
                    .Where(x => !x.FromDiplom && x.FileName == file)
                    .Select(x => x.OID)
                    .ToListAsync(ct);

                if (found.Count == 1)
                    m.SourceFileOID = found[0];
                else
                    errors.Add(found.Count == 0 ? $"{p}.file: нет загруженного файла {file}"
                        : $"{p}.file: загруженных файлов {file} несколько - оставьте один");
            }
        }

        // кусок: номер или "all" (нет - тоже все)
        if (f["piece"] is JsonValue piece)
        {
            if (piece.TryGetValue(out string? text) && text == "all")
            {
                m.Piece = null;
                return true;
            }

            if (piece.TryGetValue(out int k))
                m.Piece = k;
            else
                errors.Add($"{p}.piece: номер куска или \"all\"");
        }

        return false;
    }

    // модели: "<пакет>:<вид>" или { bundle, kind, members }; пакет - путь от bundles/ диплома, вид - imm, hyb, ens
    private void ParseModels(JsonNode? node, string p, ScenarioEditModel m, List<DbModel> catalog, List<string> errors)
    {
        if (node is not JsonArray list || list.Count == 0)
        {
            errors.Add($"{p}: нужен массив хотя бы из одной модели");
            return;
        }

        for (int i = 0; i < list.Count; i++)
        {
            string q = $"{p}[{i}]";
            string? bundle = null, kind = null;
            List<int>? members = null;

            if (list[i] is JsonValue v && v.TryGetValue(out string? text))
            {
                int colon = text.LastIndexOf(':');
                if (colon <= 0)
                {
                    errors.Add($"{q}: строка \"<пакет>:<вид>\", например \"merged_x1/dop_tele:hyb\"");
                    continue;
                }

                bundle = text[..colon];
                kind = text[(colon + 1)..];
            }
            else if (list[i] is JsonObject o)
            {
                Unknown(o, q + ".", ["bundle", "kind", "members"], errors);
                bundle = Str(o, "bundle", q + ".", errors, true);
                kind = Str(o, "kind", q + ".", errors, true);

                if (o["members"] is JsonArray seeds)
                {
                    try
                    {
                        members = [.. seeds.Select(x => x!.GetValue<int>())];
                    }
                    catch (Exception ex) when (ex is InvalidOperationException or FormatException or NullReferenceException)
                    {
                        errors.Add($"{q}.members: массив seed (целые числа)");
                        continue;
                    }
                }
                else if (o["members"] != null)
                {
                    errors.Add($"{q}.members: массив seed (целые числа)");
                    continue;
                }
            }
            else
            {
                errors.Add($"{q}: строка \"<пакет>:<вид>\" или объект {{ bundle, kind, members }}");
                continue;
            }

            if (bundle == null || kind == null)
                continue;

            ForecastKindEnum? k = kind switch
            {
                "imm" => ForecastKindEnum.Imm,
                "hyb" => ForecastKindEnum.Hyb,
                "ens" => ForecastKindEnum.Ens,
                _ => null
            };

            if (k == null)
            {
                errors.Add($"{q}: вид {kind} - ожидается imm, hyb или ens");
                continue;
            }

            if (k == ForecastKindEnum.Imm && members != null)
            {
                errors.Add($"{q}.members: у IMM сетей нет");
                continue;
            }

            string? rule = MembersRule(bundle.Trim('/'), k.Value, members);
            if (rule != null)
            {
                errors.Add($"{q}: {rule}");
                continue;
            }

            DbModel? model = FindModel(catalog, bundle.Trim('/'), k.Value, members);

            if (model == null)
                errors.Add($"{q}: нет в справочнике модели {bundle}:{kind}" + (members == null ? string.Empty : $" с seed {string.Join(", ", members)}")
                    + " (модели заводятся из bundles диплома при запуске сервера)");
            else
                m.Models.Add(model.OID);
        }
    }

    // правила вида и seed по config.json пакета: IMM - только у пакета случая; у hyb ровно
    // один seed, у ens - все seed пакета; у CV, KF и жадного ансамбля seed не выбираются и ens нет. null - всё верно
    private string? MembersRule(string bundle, ForecastKindEnum kind, List<int>? members)
    {
        string dir = Path.GetFullPath(Path.Combine(storage.DiplomBundles, bundle));
        BundleConfig? cfg = storage.DiplomBundleId(dir) == null ? null : ModelCatalog.ReadConfig(dir);

        if (cfg == null)
            return $"нет пакета {bundle} (папка с config.json в bundles диплома)";

        if (kind == ForecastKindEnum.Imm)
            return bundle.Count(c => c == '/') == 1 ? null : "IMM - только у пакета случая <прогон>/<случай>";

        if (!cfg.HasMembers)
            return kind == ForecastKindEnum.Ens ? "у CV, KF и жадного ансамбля вида ens нет - только hyb"
                : members != null ? "у CV, KF и жадного ансамбля seed не выбираются (members не задаётся)" : null;

        List<int> missing = [.. (members ?? []).Where(s => !cfg.Seeds.Contains(s))];
        if (missing.Count > 0)
            return $"нет seed {string.Join(", ", missing)} в пакете, есть [{string.Join(", ", cfg.Seeds)}]";

        if (kind == ForecastKindEnum.Hyb && members != null && members.Count != 1)
            return "у hyb ровно один seed (по умолчанию первый)";

        if (kind == ForecastKindEnum.Ens && members != null && !members.Order().SequenceEqual(cfg.Seeds.Order()))
            return $"у ens - только все seed пакета [{string.Join(", ", cfg.Seeds)}] (по умолчанию все)";

        if (kind == ForecastKindEnum.Ens && cfg.Seeds.Count < 2)
            return "ансамбль нужен из двух и больше сетей, а в пакете одна";

        return null;
    }

    // модель справочника по пакету диплома, виду и seed: гибрид без seed - первый участник пакета, ансамбль - все
    private DbModel? FindModel(List<DbModel> catalog, string bundle, ForecastKindEnum kind, List<int>? members)
    {
        List<DbModel> ofBundle = [.. catalog.Where(m => m.Kind == kind && storage.DiplomBundleId(storage.BundlePath(m.Bundle)) == bundle)];

        // ансамбль - все seed пакета (MembersRule): модель без выбранных seed
        if (kind == ForecastKindEnum.Ens)
            return ofBundle.FirstOrDefault(m => m.Seeds == null) ?? ofBundle.FirstOrDefault();

        if (members != null)
            return ofBundle.FirstOrDefault(m => m.Seeds == string.Join(",", members));

        if (kind == ForecastKindEnum.Hyb)
        {
            List<int> seeds = ModelCatalog.ReadConfig(storage.BundlePath(ofBundle.FirstOrDefault()?.Bundle ?? string.Empty))?.Seeds ?? [];
            string? first = seeds.Count == 0 ? null : seeds[0].ToString();
            return ofBundle.FirstOrDefault(m => m.Seeds == first) ?? ofBundle.FirstOrDefault();
        }

        return ofBundle.FirstOrDefault(m => m.Seeds == null) ?? ofBundle.FirstOrDefault();
    }

    private static void ParseMode(JsonNode? node, string p, ScenarioEditModel m, List<string> errors)
    {
        if (node is not JsonObject o)
        {
            errors.Add($"{p}: нужен объект {{ type, ... }}");
            return;
        }

        Unknown(o, p + ".", ["type", "speed", "start_scan", "autoplay"], errors);

        string? type = Str(o, "type", p + ".", errors, true);
        m.Mode = type switch { "full" => RunModeEnum.Full, "realtime" => RunModeEnum.Realtime, _ => RunModeEnum.Compare };
        m.Speed = Num(o, "speed", p + ".", errors);
        m.StartScan = Int(o, "start_scan", p + ".", errors, false);

        if (o["autoplay"] is JsonValue a)
        {
            if (a.TryGetValue(out bool play))
                m.Autoplay = play;
            else
                errors.Add($"{p}.autoplay: true или false");
        }

        if (m.Mode == RunModeEnum.Full && o["autoplay"] != null)
            errors.Add($"{p}.autoplay: только у реального времени");
    }

    private static void ParseRadar(JsonNode? node, string p, ScenarioEditModel m, List<string> errors)
    {
        if (node == null)
            return;

        if (node is not JsonObject o)
        {
            errors.Add($"{p}: нужен объект {{ pd }} или {{ lat, lon, alt }}");
            return;
        }

        Unknown(o, p + ".", ["pd", "lat", "lon", "alt"], errors);
        m.Pd = Num(o, "pd", p + ".", errors);
        m.RadarLat = Num(o, "lat", p + ".", errors);
        m.RadarLon = Num(o, "lon", p + ".", errors);
        m.RadarAlt = Num(o, "alt", p + ".", errors);
    }

    private static void ParseView(JsonNode? node, string p, ScenarioEditModel m, List<string> errors)
    {
        if (node == null)
            return;

        if (node is not JsonObject o)
        {
            errors.Add($"{p}: нужен объект {{ basemap, horizons_s, layers, focus }}");
            return;
        }

        Unknown(o, p + ".", ["basemap", "horizons_s", "layers", "focus", "follow"], errors);
        m.Basemap = Str(o, "basemap", p + ".", errors, false);

        if (o["horizons_s"] != null)
            m.Horizons = IntList(o["horizons_s"], $"{p}.horizons_s", errors);

        if (o["layers"] is JsonArray layers)
            m.Layers = [.. layers.Select(x => x is JsonValue v && v.TryGetValue(out string? s) ? s : "?")];
        else if (o["layers"] != null)
            errors.Add($"{p}.layers: массив имён слоёв");

        if (o["focus"] is JsonValue f)
        {
            if (f.TryGetValue(out bool focus))
                m.Focus = focus;
            else
                errors.Add($"{p}.focus: true или false");
        }

        if (o["follow"] is JsonValue fw)
        {
            if (fw.TryGetValue(out bool follow))
                m.Follow = follow;
            else
                errors.Add($"{p}.follow: true или false");
        }
    }

    // неизвестное поле - ошибка: опечатка в ручной правке не пропадёт молча
    private static void Unknown(JsonObject o, string p, string[] known, List<string> errors)
    {
        foreach (string key in o.Select(x => x.Key).Where(k => !known.Contains(k)))
            errors.Add($"{p}{key}: неизвестное поле (есть: {string.Join(", ", known)})");
    }

    private static string? Str(JsonObject o, string key, string p, List<string> errors, bool required)
    {
        if (o[key] is JsonValue v && v.TryGetValue(out string? s) && !string.IsNullOrWhiteSpace(s))
            return s;

        if (o[key] != null || required)
            errors.Add($"{p}{key}: " + (o[key] == null ? "обязательное поле" : "нужна непустая строка"));

        return null;
    }

    private static int? Int(JsonObject o, string key, string p, List<string> errors, bool required)
    {
        if (o[key] is JsonValue v && v.TryGetValue(out int i))
            return i;

        if (o[key] != null || required)
            errors.Add($"{p}{key}: " + (o[key] == null ? "обязательное поле" : "нужно целое число"));

        return null;
    }

    private static double? Num(JsonObject o, string key, string p, List<string> errors)
    {
        if (o[key] is JsonValue v && v.TryGetValue(out double d))
            return d;

        if (o[key] != null)
            errors.Add($"{p}{key}: нужно число");

        return null;
    }

    private static List<int>? IntList(JsonNode? node, string p, List<string> errors)
    {
        if (node is JsonArray list && list.All(x => x is JsonValue v && v.TryGetValue(out int _)))
            return [.. list.Select(x => x!.GetValue<int>())];

        errors.Add($"{p}: массив целых чисел");
        return null;
    }
}

// справочники для проверки сценария: кусков у логов диплома, траектории пакетов (прогон, id)
public class Catalogs
{
    public Dictionary<string, int> LogPieces { get; init; } = [];
    public HashSet<(string, string)> Tracks { get; init; } = [];
}

// сценарий формы и файла; модели - OID справочника в порядке выбора
public class ScenarioEditModel
{
    public Guid? OID { get; set; } // нет - новый
    public string? Name { get; set; }
    public string? Note { get; set; }
    public FlightSourceEnum FlightSource { get; set; }
    public string? LogName { get; set; }
    public Guid? SourceFileOID { get; set; }
    public string? TrackRun { get; set; }
    public string? TrackId { get; set; }
    public int? Piece { get; set; }
    public List<Guid> Models { get; set; } = [];
    public RunModeEnum Mode { get; set; }
    public double? Speed { get; set; }
    public int? StartScan { get; set; }
    public bool Autoplay { get; set; } = true;
    public double? Pd { get; set; }
    public double? RadarLat { get; set; }
    public double? RadarLon { get; set; }
    public double? RadarAlt { get; set; }
    public string? Basemap { get; set; }
    public List<int>? Horizons { get; set; } // секунды: 2, 4, ..., 10
    public List<string>? Layers { get; set; }
    public bool? Focus { get; set; }
    public bool? Follow { get; set; }
}

public class ScenarioRow
{
    public Guid OID { get; set; }
    public string Name { get; set; } = string.Empty;
    public string? Note { get; set; }
    public FlightSourceEnum FlightSource { get; set; }
    public string? LogName { get; set; }
    public Guid? SourceFileOID { get; set; }
    public string? SourceFileName { get; set; }
    public SourceKindEnum? SourceFileKind { get; set; }
    public string? TrackRun { get; set; }
    public string? TrackId { get; set; }
    public int? Piece { get; set; }
    public RunModeEnum Mode { get; set; }
    public double? Speed { get; set; }
    public int? StartScan { get; set; }
    public bool Autoplay { get; set; }
    public double? Pd { get; set; }
    public double? RadarLat { get; set; }
    public double? RadarLon { get; set; }
    public double? RadarAlt { get; set; }
    public string? Basemap { get; set; }
    public string? Horizons { get; set; } // секунды через запятую
    public string? Layers { get; set; }
    public bool? Focus { get; set; }
    public bool? Follow { get; set; }
    public List<Guid> ModelOIDs { get; set; } = [];
    public List<string> ModelNames { get; set; } = [];
    public string Models => string.Join("; ", ModelNames);
    public int RunCount { get; set; } // запусков с этим наименованием сценария
    public DateTime Created { get; set; }
}
