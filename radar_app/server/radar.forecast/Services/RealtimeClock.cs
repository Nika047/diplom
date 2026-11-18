using radar.forecast.Settings;

using Microsoft.Extensions.Options;

namespace radar.forecast.Services;

// таймер обзоров реального времени: раз в TickMilliseconds проверяет сессии, у которых подошло время следующего обзора.
// отключена (BackgroundServices:RealtimeClock = false) - сессии не проигрываются сами, шаг и перемотка работают
public class RealtimeClock(RealtimeService realtime, IOptions<RealtimeSettings> options, ILogger<RealtimeClock> logger) : BackgroundService
{
    private readonly RealtimeService realtime = realtime;
    private readonly RealtimeSettings settings = options.Value;
    private readonly ILogger<RealtimeClock> logger = logger;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Таймер обзоров запущен: такт {Tick} мс", settings.TickMilliseconds);

        using PeriodicTimer timer = new(TimeSpan.FromMilliseconds(Math.Max(1, settings.TickMilliseconds)));

        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                await realtime.TickAsync(stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogError(ex, "Ошибка такта таймера обзоров");
            }
        }
    }
}
