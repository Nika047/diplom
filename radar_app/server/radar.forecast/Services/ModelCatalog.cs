using System.Text.Json.Nodes;

using radar.forecast.data.App;

namespace radar.forecast.Services;

// config.json пакета модели (формат этапа 11 диплома): то, что нужно справочнику моделей
public record BundleConfig(DopplerCaseEnum Case, string Label, List<int> Seeds, string? Title, string? Note, string? Role, string? Run)
{
    public string? Corrector { get; init; } // сеть-корректор: LSTM, GRU, Transformer
    public int? Hidden { get; init; } // нейронов в слое
    public int? Layers { get; init; }
    public int? Window { get; init; } // окно признаков, обзоров
    public bool DopplerInImm { get; init; }
    public bool DopplerInNet { get; init; }
    public bool HasVariants { get; init; } // сеть «три варианта» (гипотезы этапа 6)
    public double? GateCoverage { get; init; } // доля целей внутри строба

    // вид модели пакета (config.json["model"]): hybrid - IMM + поправка сети, e2e - сеть без IMM,
    // classic - CV или KF без сети, ensemble - жадный ансамбль из частей с разными сетями
    public string ModelType { get; init; } = ModelCatalog.Hybrid;
    public string? ClassicMethod { get; init; } // cv, kf
    public int? ClassicPoints { get; init; } // отметок у линейной экстраполяции
    public List<string> Parts { get; init; } = []; // части жадного ансамбля: «метод seed N»

    // участники выбираются (seed) только у гибрида и сети без IMM; у CV, KF и жадного ансамбля - нет
    public bool HasMembers => ModelType is ModelCatalog.Hybrid or ModelCatalog.E2e;
}

// подписи и чтение пакетов для справочника моделей
public static class ModelCatalog
{
    public const string Hybrid = "hybrid";
    public const string E2e = "e2e";
    public const string Classic = "classic";
    public const string Ensemble = "ensemble";

    public static DopplerCaseEnum CaseOf(string engineCase) => engineCase switch
    {
        "nodop" => DopplerCaseEnum.Nodop,
        "dop_traj" => DopplerCaseEnum.DopTraj,
        "dop_tele" => DopplerCaseEnum.DopTele,
        _ => throw new InvalidDataException($"Неизвестный случай доплера {engineCase} в пакете модели")
    };

    public static string CaseTitle(DopplerCaseEnum value) => value switch
    {
        DopplerCaseEnum.Nodop => "без доплера",
        DopplerCaseEnum.DopTraj => "доплер по траектории",
        _ => "доплер по телеметрии"
    };

    // без запятых: подпись идёт в столбец CSV
    public static string KindTitle(ForecastKindEnum kind) => kind switch
    {
        ForecastKindEnum.Imm => "IMM",
        ForecastKindEnum.Hyb => "гибрид",
        _ => "ансамбль"
    };

    public static BundleConfig? ReadConfig(string dir)
    {
        string path = Path.Combine(dir, "config.json");

        if (!File.Exists(path))
            return null;

        JsonNode cfg = JsonNode.Parse(File.ReadAllText(path)) ?? throw new InvalidDataException($"Пустой {path}");
        List<int> seeds = [.. (cfg["members"]?.AsArray() ?? []).Select(m => m?["seed"]?.GetValue<int>() ?? 0)];

        return new BundleConfig(
            CaseOf(cfg["case"]!.GetValue<string>()),
            cfg["label"]?.GetValue<string>() ?? "сеть",
            seeds,
            cfg["title"]?.GetValue<string>(),
            cfg["note"]?.GetValue<string>(),
            cfg["role"]?.GetValue<string>(),
            cfg["run"]?.GetValue<string>())
        {
            Corrector = cfg["corrector"]?.GetValue<string>(),
            Hidden = cfg["hp"]?["hidden"]?.GetValue<int>(),
            Layers = cfg["hp"]?["layers"]?.GetValue<int>(),
            Window = cfg["window"]?.GetValue<int>(),
            DopplerInImm = cfg["override"]?["DOPPLER_IN_IMM"]?.GetValue<bool>() ?? false,
            DopplerInNet = cfg["override"]?["DOPPLER_IN_NET"]?.GetValue<bool>() ?? false,
            HasVariants = cfg["multi"] is JsonObject,
            GateCoverage = cfg["gate"]?["coverage"]?.GetValue<double>(),
            ModelType = cfg["model"]?.GetValue<string>() ?? Hybrid,
            ClassicMethod = cfg["classic"]?["method"]?.GetValue<string>(),
            ClassicPoints = cfg["classic"]?["n_points"]?.GetValue<int>(),
            Parts = [.. (cfg["parts"]?.AsArray() ?? []).Select(p => $"{p?["method"]?.GetValue<string>()} seed {p?["seed"]}")]
        };
    }

    // сеть пакета с IMM: «IMM+Transformer»
    public static string NetName(string label) => label.StartsWith("IMM") ? label : $"IMM+{label}";

    // seed участников модели (DbModel.Seeds - через запятую); пусто - null: по умолчанию первый участник или все
    public static List<int>? ParseSeeds(string? seeds)
    {
        List<int> list = [.. (seeds ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(int.Parse)];

        return list.Count == 0 ? null : list;
    }

    // seed сетей модели: гибрид - выбранный или первый участник пакета, ансамбль - выбранные или все, IMM - нет
    public static List<int> ModelSeeds(BundleConfig cfg, ForecastKindEnum kind, List<int>? seeds) => kind switch
    {
        ForecastKindEnum.Imm => [],
        ForecastKindEnum.Hyb => seeds ?? [.. cfg.Seeds.Take(1)],
        _ => seeds ?? cfg.Seeds
    };

    // прогон диплома - вид входных данных обучения: base - сгенерированные траектории только в обучении, merged - во всех
    // выборках; xN - объём сгенерированных траекторий
    public static string RunTitle(string? run)
    {
        if (string.IsNullOrEmpty(run))
            return "не указан";

        string data = run.StartsWith("merged") ? "реальные полёты и сгенерированные траектории во всех выборках"
            : run.StartsWith("base") ? "реальные полёты, сгенерированные траектории только в обучении" : "прогон диплома";

        return $"{run}: {data}";
    }

    private const string FinalPrefix = "Итоговая модель:";

    // вид модели для таблицы: у пакетов без выбора участников - их вид, иначе вид прогноза
    public static string TypeTitle(BundleConfig? cfg, ForecastKindEnum kind) => kind == ForecastKindEnum.Imm ? "IMM"
        : cfg?.ModelType switch
        {
            Classic => cfg.ClassicMethod == "kf" ? "фильтр Калмана" : "линейная экстраполяция",
            Ensemble => "жадный ансамбль",
            E2e => kind == ForecastKindEnum.Ens ? "сеть без IMM, ансамбль" : "сеть без IMM",
            _ => kind == ForecastKindEnum.Ens ? "гибрид, ансамбль" : "гибрид"
        };

    // наименование по умолчанию: «IMM, без доплера (merged_x1)», «IMM+Transformer, seed 42, доплер по траектории (merged_x1)»,
    // «IMM+Transformer, ансамбль 3 seed, доплер по траектории (base_x1)», «Фильтр Калмана, без доплера (merged_x1)»; у
    // пакета с title - title вместо сети. «Итоговая модель:» из title пакетов случаев не берётся: итоговые модели текста ВКР -
    // пакеты на MSE в compare/, а пакеты случаев - те же сети под ADE после текста (README диплома)
    public static string DefaultName(BundleConfig cfg, ForecastKindEnum kind, List<int>? seeds = null)
    {
        string? title = cfg.Title?.StartsWith(FinalPrefix) == true ? cfg.Title[FinalPrefix.Length..].Trim() : cfg.Title;
        string net = title ?? NetName(cfg.Label);
        string caseTitle = CaseTitle(cfg.Case);
        string run = cfg.Run == null ? string.Empty : $" ({cfg.Run})";
        List<int> used = ModelSeeds(cfg, kind, seeds);

        if (kind != ForecastKindEnum.Imm && !cfg.HasMembers)
            return $"{net}, {caseTitle}{run}";

        return kind switch
        {
            // IMM пакета случая - подобранный IMM случая, от сети пакета не зависит
            ForecastKindEnum.Imm => $"IMM, {caseTitle}{run}",
            ForecastKindEnum.Hyb => $"{net}, seed {string.Join(", ", used)}, {caseTitle}{run}",
            _ => $"{net}, ансамбль {used.Count} seed, {caseTitle}{run}"
        };
    }

    // состав модели одной строкой: фильтр, сеть, окно, сети (seed), доплер, три варианта, строб
    public static string Composition(BundleConfig cfg, ForecastKindEnum kind, List<int>? seeds = null)
    {
        bool imm = kind == ForecastKindEnum.Imm;
        bool net = !imm && cfg.ModelType is Hybrid or E2e or Ensemble;
        List<int> used = ModelSeeds(cfg, kind, seeds);
        List<string> parts = [imm ? "IMM (модели CV и CT)" : cfg.ModelType switch
        {
            Classic => cfg.ClassicMethod == "kf" ? "фильтр Калмана (одна модель CV, параметры подобраны), без сети"
                : $"линейная экстраполяция по {cfg.ClassicPoints} последним отметкам, без сети",
            E2e => $"{NetDetails(cfg)} без IMM: последняя отметка + смещение, предсказанное сетью",
            Ensemble => $"жадный ансамбль из {cfg.Parts.Count} частей ({string.Join(", ", cfg.Parts)}), среднее их прогнозов",
            _ => $"IMM + {NetDetails(cfg)}"
        }];

        if (net && cfg.Window != null && cfg.ModelType != Ensemble)
            parts.Add($"окно {cfg.Window} обзоров");

        if (kind == ForecastKindEnum.Hyb && cfg.HasMembers)
            parts.Add($"сеть seed {string.Join(", ", used)}");
        else if (kind == ForecastKindEnum.Ens)
            parts.Add($"среднее {used.Count} сетей seed {string.Join(", ", used)}");

        bool netDoppler = net && cfg.DopplerInNet;
        // у сети без IMM и линейной экстраполяции фильтра нет: доплер в фильтре - только у IMM, гибрида, KF и ансамбля
        bool filterDoppler = cfg.DopplerInImm && cfg.ModelType != E2e && !(cfg.ModelType == Classic && cfg.ClassicMethod != "kf");
        parts.Add(filterDoppler && netDoppler ? "доплер в фильтре и во входах сети"
            : filterDoppler ? "доплер в фильтре"
            : netDoppler ? "доплер во входах сети"
            : "без доплера");

        if (net && cfg.HasVariants)
            parts.Add("три варианта прогноза");

        if (!imm && cfg.GateCoverage != null)
            parts.Add($"строб {Math.Round(cfg.GateCoverage.Value * 100)}%");

        return string.Join("; ", parts);
    }

    private static string NetDetails(BundleConfig cfg)
    {
        string net = cfg.Corrector ?? cfg.Label.Replace("IMM+", string.Empty);
        List<string> size = [];
        if (cfg.Hidden != null) size.Add($"{cfg.Hidden} нейронов");
        if (cfg.Layers != null) size.Add($"слоёв {cfg.Layers}");
        return size.Count == 0 ? net : $"{net} ({string.Join(", ", size)})";
    }

    // примечание по умолчанию: что за модель и из чего сформирована
    public static string DefaultNote(BundleConfig cfg, ForecastKindEnum kind, string source, string run, List<int>? seeds = null)
    {
        List<int> used = ModelSeeds(cfg, kind, seeds);
        string data = run.StartsWith("merged") ? "реальных полётах и сгенерированных траекториях"
            : run.StartsWith("base") ? "реальных полётах (сгенерированные траектории - только в обучении)" : $"данных прогона {run}";
        string what = kind != ForecastKindEnum.Imm && cfg.ModelType != Hybrid ? cfg.ModelType switch
        {
            Classic => cfg.ClassicMethod == "kf"
                ? "Фильтр Калмана этапа 1 (одна модель движения CV, параметры подобраны) без нейросети - классический метод для сравнения."
                : $"Линейная экстраполяция этапа 1 по {cfg.ClassicPoints} последним отметкам без нейросети - классический метод для сравнения.",
            E2e => $"Нейросеть {NetDetails(cfg)} без фильтра IMM: прогноз - последняя отметка плюс смещение, предсказанное сетью по окну " +
                $"{cfg.Window} обзоров; " + (kind == ForecastKindEnum.Ens ? $"среднее {used.Count} сетей (seed {string.Join(", ", used)})."
                    : $"одна сеть (seed {string.Join(", ", used)})."),
            _ => $"Жадный ансамбль этапа 8: среднее прогнозов {cfg.Parts.Count} моделей с разными сетями ({string.Join(", ", cfg.Parts)})."
        } : kind switch
        {
            ForecastKindEnum.Imm => "Только фильтр IMM (модели движения CV и CT, параметры подобраны для этого случая доплера) без " +
                "поправки нейросети - база для сравнения.",
            ForecastKindEnum.Hyb => $"Гибрид: прогноз IMM и поправка нейросети {NetDetails(cfg)}, окно {cfg.Window} обзоров; одна " +
                $"сеть (seed {string.Join(", ", used)}) из {cfg.Seeds.Count} обученных с разными seed.",
            _ => $"Гибрид-ансамбль: прогноз IMM и среднее поправок {used.Count} сетей {NetDetails(cfg)} (seed " +
                $"{string.Join(", ", used)}) - устойчивее одной сети."
        };
        string doppler = cfg.Case switch
        {
            DopplerCaseEnum.Nodop => "Доплера нет: на входе только отметки РЛС (дальность, азимут, угол места).",
            DopplerCaseEnum.DopTraj => "На входе ещё радиальная скорость (доплер); при обучении она считалась по траектории.",
            _ => "На входе ещё радиальная скорость (доплер); при обучении она бралась из телеметрии аппарата."
        };

        return $"{source} (прогон {run}, обучена на {data}). {what} {doppler}"
            + (kind != ForecastKindEnum.Imm && cfg.HasVariants ? " Есть три варианта прогноза и строб." : string.Empty);
    }
}
