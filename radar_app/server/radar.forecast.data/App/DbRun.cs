namespace radar.forecast.data.App;

// загруженный файл: лог полёта EdgeTX/OpenTX или файл отметок РЛС. сам файл лежит в хранилище (App_Data/files/<OID>.csv)
public class DbSourceFile : DbAbstractDataObject
{
    public string FileName { get; set; } = string.Empty;

    public SourceKindEnum Kind { get; set; }

    public long Size { get; set; }

    public DateTime Created { get; set; }

    public bool FromDiplom { get; set; } // взят из flight_logs проекта диплома, а не загружен
}

// запуск прогноза. результат (трассы и ответы движка) лежит в хранилище (App_Data/runs/<OID>.json)
public class DbRun : DbAbstractDataObject
{
    public DateTime Created { get; set; }

    public DbSourceFile? SourceFile { get; set; }

    // траектория генератора или расширения из пакета прогона диплома (bundles/<прогон>/tracks) - вместо файла
    public string? TrackRun { get; set; }
    public string? TrackId { get; set; }

    // наименование сценария на момент запуска (запуск по сценарию). Не ссылка: внешний ключ к существующей таблице SQLite
    // добавляется только её пересозданием, а его DatabaseSchema не применяет
    public string? ScenarioName { get; set; }

    public RunModeEnum Mode { get; set; }

    public DopplerCaseEnum Case { get; set; }

    public bool Ensemble { get; set; }

    public double? Pd { get; set; } // вероятность обнаружения - у лога полёта и траектории

    // положение РЛС у файла отметок; без него показ только на плоскости
    public double? RadarLat { get; set; }
    public double? RadarLon { get; set; }
    public double? RadarAlt { get; set; }

    public string? Model { get; set; }

    public int TrackCount { get; set; }
    public int ScanCount { get; set; }

    // ADE по всем кускам (среднее ошибок всех пар обзор-горизонт), м; нет истины - null
    public double? AdeImm { get; set; }
    public double? AdeHyb { get; set; }

    public double DurationMs { get; set; } // время прогноза в движке по всем кускам

    // модели запуска по порядку выбора; у запусков до справочника моделей пусто - модель в Case и Ensemble
    public List<DbRunModel> RunModels { get; set; } = [];
}

// модель справочника: пакет модели (config.json и веса, формат этапа 11 диплома) и вид прогноза по нему
public class DbModel : DbAbstractDataObject
{
    public string Name { get; set; } = string.Empty;

    public string? Note { get; set; }

    // папка пакета: от папки веб-проекта (пакет диплома) или в хранилище (App_Data/models/<папка>); у видов одного
    // пакета папка общая
    public string Bundle { get; set; } = string.Empty;

    public ForecastKindEnum Kind { get; set; }

    public DopplerCaseEnum Case { get; set; } // случай доплера пакета (config.json)

    public string? Label { get; set; } // сеть пакета: IMM+Transformer и т.п.

    public int Members { get; set; } // сетей (seed) в пакете

    // seed участников через запятую (гибрид - одна сеть, ансамбль - среднее); пусто - по умолчанию: первый участник
    // или все. Выбор участников - FinalPredictor(members=...) диплома
    public string? Seeds { get; set; }

    // прогон диплома, на данных которого обучена модель (config.json["run"]): base_x1, merged_x1; вид входных данных
    public string? Run { get; set; }

    public bool FromDiplom { get; set; } // пакет диплома: заводится при старте, не удаляется

    // наименование или примечание правил пользователь: у модели диплома они больше не обновляются из config.json
    public bool Edited { get; set; }

    public DateTime Created { get; set; }
}

// модель запуска
public class DbRunModel : DbAbstractDataObject
{
    public DbRun? Run { get; set; }

    public DbModel? Model { get; set; }

    public int Position { get; set; } // порядок выбора: цвет модели на карте
}

// сценарий: готовый набор параметров запуска (формат файла - .agent_docs/ARCHITECTURE.md, «Сценарии»); запуск сценария -
// запись в истории
public class DbScenario : DbAbstractDataObject
{
    public string Name { get; set; } = string.Empty;

    public string? Note { get; set; }

    public FlightSourceEnum FlightSource { get; set; }

    public string? LogName { get; set; } // лог flight_logs диплома (FlightSource = Log)

    public DbSourceFile? SourceFile { get; set; } // загруженный файл (Upload)

    // траектория пакета прогона (Track)
    public string? TrackRun { get; set; }
    public string? TrackId { get; set; }

    public int? Piece { get; set; } // кусок лога: реальное время по нему, прогон целиком открывается на нём; нет - все куски

    public RunModeEnum Mode { get; set; }

    // реальное время: ускорение, обзор, с которого начать, пуск сразу
    public double? Speed { get; set; }
    public int? StartScan { get; set; }
    public bool Autoplay { get; set; } = true;

    public double? Pd { get; set; } // лог и траектория

    // положение РЛС у файла отметок
    public double? RadarLat { get; set; }
    public double? RadarLon { get; set; }
    public double? RadarAlt { get; set; }

    // вид карты; нет - как выбрал зритель. Горизонты - секунды через запятую, слои - имена через запятую
    public string? Basemap { get; set; }
    public string? Horizons { get; set; }
    public string? Layers { get; set; }
    public bool? Focus { get; set; } // фокус на прогнозе
    public bool? Follow { get; set; } // следить за целью; вместе с фокусом - нельзя

    public DateTime Created { get; set; }

    public List<DbScenarioModel> ScenarioModels { get; set; } = [];
}

// модель сценария
public class DbScenarioModel : DbAbstractDataObject
{
    public DbScenario? Scenario { get; set; }

    public DbModel? Model { get; set; }

    public int Position { get; set; }
}

// откуда полёт сценария: лог диплома, загруженный файл, траектория пакета прогона
public enum FlightSourceEnum
{
    [System.ComponentModel.Description("лог диплома")]
    Log = 0,

    [System.ComponentModel.Description("загруженный файл")]
    Upload = 1,

    [System.ComponentModel.Description("траектория пакета")]
    Track = 2,
}

public enum SourceKindEnum
{
    [System.ComponentModel.Description("лог полёта")]
    Log = 0,

    [System.ComponentModel.Description("отметки РЛС")]
    Radar = 1,

    // траектория генератора или расширения из пакета прогона: файла нет (DbRun.TrackRun, TrackId)
    [System.ComponentModel.Description("траектория")]
    Track = 2,
}

public enum RunModeEnum
{
    [System.ComponentModel.Description("прогон целиком")]
    Full = 0,

    [System.ComponentModel.Description("реальное время")]
    Realtime = 1,

    [System.ComponentModel.Description("сравнение моделей")]
    Compare = 2,
}

// вид прогноза в сравнении моделей: IMM случая, гибрид (одна сеть), гибрид-ансамбль (среднее поправок всех seed)
public enum ForecastKindEnum
{
    [System.ComponentModel.Description("IMM")]
    Imm = 0,

    [System.ComponentModel.Description("гибрид")]
    Hyb = 1,

    [System.ComponentModel.Description("гибрид, ансамбль")]
    Ens = 2,
}

// случай доплера итоговой модели диплома; имена у движка - EngineClient.CaseName
public enum DopplerCaseEnum
{
    [System.ComponentModel.Description("без доплера")]
    Nodop = 0,

    [System.ComponentModel.Description("доплер по траектории")]
    DopTraj = 1,

    [System.ComponentModel.Description("доплер по телеметрии")]
    DopTele = 2,
}
