namespace radar.forecast.Services;

// Флаги активности фоновых служб: раздел BackgroundServices в appsettings.json, ключ - имя класса службы
// нет ключа - служба включена
public static class BackgroundServiceExtensions
{
    public const string SectionName = "BackgroundServices";

    // заполняется при регистрации служб (до запуска приложения), поэтому блокировка не нужна
    private static readonly List<string> Disabled = [];

    public static bool IsBackgroundServiceEnabled(this IConfiguration configuration, string serviceName)
    {
        string? raw = configuration.GetSection(SectionName)[serviceName];

        if (string.IsNullOrWhiteSpace(raw))
            return true;

        // опечатка в значении (не true/false) не должна тихо включать или выключать службу - падаем при старте
        if (!bool.TryParse(raw, out bool enabled))
            throw new InvalidOperationException($"Настройка {SectionName}:{serviceName} должна быть true или false, а не [{raw}]");

        return enabled;
    }

    public static IServiceCollection AddFlaggedHostedService<TService>(this IServiceCollection services, IConfiguration configuration)
        where TService : class, IHostedService
    {
        if (!configuration.IsBackgroundServiceEnabled(typeof(TService).Name))
        {
            Disabled.Add(typeof(TService).Name);
            return services;
        }

        return services.AddHostedService<TService>();
    }

    // для службы, которая одновременно зарегистрирована как обычный сервис (отключается только фоновая часть)
    public static IServiceCollection AddFlaggedHostedService<TService>(this IServiceCollection services, IConfiguration configuration, Func<IServiceProvider, TService> factory)
        where TService : class, IHostedService
    {
        if (!configuration.IsBackgroundServiceEnabled(typeof(TService).Name))
        {
            Disabled.Add(typeof(TService).Name);
            return services;
        }

        return services.AddHostedService(factory);
    }

    public static void LogDisabledBackgroundServices(this ILogger logger)
    {
        if (Disabled.Count == 0)
            logger.LogInformation($"Фоновые службы: все включены (настройки {SectionName})");
        else
            logger.LogWarning($"Фоновые службы ОТКЛЮЧЕНЫ настройками {SectionName}: {string.Join(", ", Disabled)}");
    }
}
