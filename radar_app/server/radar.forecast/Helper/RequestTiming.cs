using System.Diagnostics;

namespace radar.forecast.Helper;

// время обработки каждого запроса в логе: сколько занял endpoint целиком
public static class RequestTiming
{
    public static IApplicationBuilder UseRequestTiming(this IApplicationBuilder app) =>
        app.Use(async (context, next) =>
        {
            if (context.Request.Path.StartsWithSegments("/hub"))
            {
                await next();
                return;
            }

            long started = Stopwatch.GetTimestamp();

            try
            {
                await next();
            }
            finally
            {
                ILogger logger = context.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger(typeof(RequestTiming).FullName!);
                double ms = Stopwatch.GetElapsedTime(started).TotalMilliseconds;
                string query = context.Request.QueryString.HasValue ? Shorten(context.Request.QueryString.Value!) : string.Empty;

                logger.LogInformation("{Elapsed:F0} мс - {Method} {Path}{Query} -> {Status}",
                    ms, context.Request.Method, context.Request.Path.Value, query, context.Response.StatusCode);
            }
        });

    private static string Shorten(string value) => value.Length <= 120 ? value : value[..120] + "...";
}
