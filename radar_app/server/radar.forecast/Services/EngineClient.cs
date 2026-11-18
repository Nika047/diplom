using System.Text;
using System.Text.Json.Nodes;

using radar.forecast.data.App;

using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace radar.forecast.Services;

// HTTP-клиент движка прогноза (engine/, API - .agent_docs/ARCHITECTURE.md). ответы движка сервер не разбирает в классы:
// он их хранит и отдаёт клиенту как есть, читая только нужные поля
public class EngineClient(HttpClient http, ILogger<EngineClient> logger)
{
    private readonly HttpClient http = http;
    private readonly ILogger<EngineClient> logger = logger;

    public static string CaseName(DopplerCaseEnum value) => value switch
    {
        DopplerCaseEnum.Nodop => "nodop",
        DopplerCaseEnum.DopTraj => "dop_traj",
        DopplerCaseEnum.DopTele => "dop_tele",
        _ => throw new ArgumentOutOfRangeException(nameof(value), value, "Неизвестный случай доплера")
    };

    public Task<JsonNode> GetAsync(string path, CancellationToken ct) => SendAsync(HttpMethod.Get, path, null, ct);

    public Task<JsonNode> PostAsync(string path, JsonNode body, CancellationToken ct) => SendAsync(HttpMethod.Post, path, body, ct);

    public Task<JsonNode> DeleteAsync(string path, CancellationToken ct) => SendAsync(HttpMethod.Delete, path, null, ct);

    private async Task<JsonNode> SendAsync(HttpMethod method, string path, JsonNode? body, CancellationToken ct)
    {
        using HttpRequestMessage request = new(method, path);

        if (body != null)
            request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");

        HttpResponseMessage response;

        try
        {
            response = await http.SendAsync(request, ct);
        }
        catch (HttpRequestException ex)
        {
            logger.LogError(ex, "Движок прогноза недоступен: {Method} {Path}", method, path);
            throw new EngineException(StatusCodes.Status503ServiceUnavailable, $"Движок прогноза недоступен ({http.BaseAddress}). Запустите engine\\main.py");
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new EngineException(StatusCodes.Status504GatewayTimeout, $"Движок прогноза не ответил за {http.Timeout.TotalSeconds:F0} с");
        }

        using (response)
        {
            string text = await response.Content.ReadAsStringAsync(ct);

            if (response.IsSuccessStatusCode)
                return JsonNode.Parse(text) ?? throw new EngineException(StatusCodes.Status502BadGateway, "Пустой ответ движка прогноза");

            string detail = text;

            try
            {
                detail = JsonNode.Parse(text)?["detail"]?.ToString() ?? text;
            }
            catch (System.Text.Json.JsonException)
            {
            }

            logger.LogWarning("Движок прогноза: {Method} {Path} -> {Status}: {Detail}", method, path, (int)response.StatusCode, detail);

            // ошибка входных данных и неизвестная сессия у движка - те же ошибки и у сервера, остальное - сбой движка
            int status = (int)response.StatusCode is 400 or 404 ? (int)response.StatusCode : StatusCodes.Status502BadGateway;
            throw new EngineException(status, detail);
        }
    }
}

public class EngineException(int status, string message) : Exception(message)
{
    public int Status { get; } = status;
}

// ошибка движка -> ответ { message } с её кодом: клиент показывает текст как есть
public class EngineExceptionFilter : IExceptionFilter
{
    public void OnException(ExceptionContext context)
    {
        if (context.Exception is not EngineException ex)
            return;

        context.Result = new ObjectResult(new { message = ex.Message }) { StatusCode = ex.Status };
        context.ExceptionHandled = true;
    }
}
