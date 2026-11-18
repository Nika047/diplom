using System.Diagnostics;
using System.Text.Json.Nodes;

using radar.forecast.Services;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace radar.forecast.Controllers;

// состояние движка и сведения о моделях (случаи доплера, окно, три варианта, строб)
[Authorize]
[Route("api/[controller]")]
[ApiController]
public class EngineController(EngineClient engine) : ControllerBase
{
    private readonly EngineClient engine = engine;

    // сколько раз опросить часы движка; берется замер с самым коротким запросом
    private const int ClockSamples = 7;

    [HttpGet(nameof(Info))]
    public async Task<IActionResult> Info(CancellationToken ct)
    {
        long started = Stopwatch.GetTimestamp();
        JsonNode health = await engine.GetAsync("health", ct);
        double pingMs = Stopwatch.GetElapsedTime(started).TotalMilliseconds;

        JsonNode info = await engine.GetAsync("info", ct);
        info["ping_ms"] = Math.Round(pingMs, 2);
        info["engine_time_ms"] = health["time_ms"]?.DeepClone();

        return Ok(info);
    }

    // расхождение часов движка с часами сервера, мс (движок минус сервер), как у NTP: время движка сравнивается с серединой
    // запроса; погрешность - не больше половины времени запроса. первый запрос (установка соединения) не учитывается
    [HttpGet(nameof(Clock))]
    public async Task<IActionResult> Clock(CancellationToken ct)
    {
        await engine.GetAsync("health", ct);

        double bestRtt = double.MaxValue;
        double offset = 0;

        for (int i = 0; i < ClockSamples; i++)
        {
            double sent = RealtimeService.NowMs();
            JsonNode health = await engine.GetAsync("health", ct);
            double received = RealtimeService.NowMs();

            double rtt = received - sent;
            if (rtt >= bestRtt)
                continue;

            bestRtt = rtt;
            offset = health["time_ms"]!.GetValue<double>() - (sent + rtt / 2);
        }

        return Ok(new { offsetMs = Math.Round(offset, 3), rttMs = Math.Round(bestRtt, 3), samples = ClockSamples, serverMs = RealtimeService.NowMs() });
    }
}
