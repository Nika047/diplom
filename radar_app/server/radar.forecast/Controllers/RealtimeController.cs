using System.Text.Json.Nodes;

using radar.forecast.data;
using radar.forecast.data.App;
using radar.forecast.Services;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace radar.forecast.Controllers;

// реальное время: сессия по одной трассе, плеер (пуск, пауза, шаг, перемотка, ускорение). обзоры приходят через RadarHub
[Authorize]
[Route("api/[controller]")]
[ApiController]
public class RealtimeController(RunService runs, RealtimeService realtime) : ControllerBase
{
    private readonly RunService runs = runs;
    private readonly RealtimeService realtime = realtime;

    private static readonly object NoSession = new { message = "Сессия реального времени не найдена или уже закрыта" };

    [HttpGet]
    public IActionResult List() => Ok(new JsonArray([.. realtime.All.Select(s => (JsonNode)realtime.Describe(s, false))]));

    [HttpPost]
    public async Task<IActionResult> Create(RealtimeCreateModel model, CancellationToken ct)
    {
        string? error = await runs.CheckAsync(model, ct);

        if (error != null)
            return BadRequest(new { message = error });

        RealtimeSession session = await realtime.CreateAsync(model, ct);

        return Ok(realtime.Describe(session, false));
    }

    // сессия целиком: трасса и все посчитанные обзоры - для открытия страницы заново
    [HttpGet(nameof(Get))]
    public IActionResult Get([FromQuery] OidModel model)
    {
        RealtimeSession? session = realtime.Find(model.OID);

        return session == null ? NotFound(NoSession) : Ok(realtime.Describe(session, true));
    }

    [HttpPost(nameof(Play))]
    public Task<IActionResult> Play(RealtimeControlModel model, CancellationToken ct) =>
        Control(model.OID, s => { realtime.Play(s, model.Speed); return Task.CompletedTask; }, ct);

    [HttpPost(nameof(Pause))]
    public Task<IActionResult> Pause(RealtimeControlModel model, CancellationToken ct) =>
        Control(model.OID, s => { s.Playing = false; return Task.CompletedTask; }, ct);

    [HttpPost(nameof(Step))]
    public Task<IActionResult> Step(RealtimeControlModel model, CancellationToken ct) =>
        Control(model.OID, s => realtime.StepAsync(s, ct), ct);

    [HttpPost(nameof(Seek))]
    public Task<IActionResult> Seek(RealtimeControlModel model, CancellationToken ct) =>
        Control(model.OID, s => realtime.SeekAsync(s, model.K ?? s.Position, ct), ct);

    [HttpPost(nameof(Speed))]
    public Task<IActionResult> Speed(RealtimeControlModel model, CancellationToken ct) =>
        Control(model.OID, s => { realtime.SetSpeed(s, model.Speed ?? s.Speed); return Task.CompletedTask; }, ct);

    [HttpDelete]
    public async Task<IActionResult> Stop([FromQuery] OidModel model, CancellationToken ct)
    {
        if (realtime.Find(model.OID) == null)
            return NotFound(NoSession);

        await realtime.StopAsync(model.OID, ct);

        return NoContent();
    }

    private async Task<IActionResult> Control(Guid oid, Func<RealtimeSession, Task> action, CancellationToken ct)
    {
        JsonObject? state = await realtime.ControlAsync(oid, action, ct);

        return state == null ? NotFound(NoSession) : Ok(state);
    }
}

public class RealtimeControlModel
{
    public Guid OID { get; set; }
    public double? Speed { get; set; } // ускорение x1-x50
    public int? K { get; set; } // обзор для перемотки
}
