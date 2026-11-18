using System.Text;
using System.Text.Json;

using radar.forecast.data;
using radar.forecast.data.Security;
using radar.forecast.Helper;
using radar.forecast.Hubs;
using radar.forecast.Services;
using radar.forecast.Settings;
using radar.forecast.Setup;

using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.CookiePolicy;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;

using NLog.Extensions.Logging;
using NLog.Web;

var builder = WebApplication.CreateBuilder(args);

NLog.LogManager.Configuration = new NLogLoggingConfiguration(builder.Configuration.GetSection("NLog"));
builder.Logging.ClearProviders();
builder.Host.UseNLog();

string dataConnection = builder.Configuration.GetConnectionString("Data")
    ?? throw new InvalidOperationException("Не задана строка подключения ConnectionStrings:Data");

builder.Services.AddDbContext<RadarDbContext>(options => options
    .UseSqlite(RadarDbContext.ResolveConnection(dataConnection, builder.Environment.ContentRootPath)));

builder.Services.Configure<MapSettings>(builder.Configuration.GetSection("Map"));
builder.Services.Configure<EngineSettings>(builder.Configuration.GetSection("Engine"));
builder.Services.Configure<StorageSettings>(builder.Configuration.GetSection("Storage"));
builder.Services.Configure<RealtimeSettings>(builder.Configuration.GetSection("Realtime"));

builder.Services.AddSingleton<AppStorage>();
builder.Services.AddScoped<RunService>();
builder.Services.AddScoped<ScenarioService>();

// реальное время: сессии и таймер обзоров (флаг BackgroundServices:RealtimeClock)
builder.Services.AddSingleton<RealtimeService>();
builder.Services.AddFlaggedHostedService<RealtimeClock>(builder.Configuration);

// движок прогноза: адрес и время ожидания - раздел Engine
builder.Services.AddHttpClient<EngineClient>((sp, client) =>
{
    EngineSettings engine = sp.GetRequiredService<IOptions<EngineSettings>>().Value;
    client.BaseAddress = new Uri(engine.Url.TrimEnd('/') + "/");
    client.Timeout = TimeSpan.FromSeconds(engine.TimeoutSeconds);
});

builder.Services.AddIdentity<DbAccount, IdentityRole<Guid>>(options =>
    {
        options.Password.RequiredLength = 6;

        options.Password.RequireLowercase = false;
        options.Password.RequireUppercase = false;
        options.Password.RequireNonAlphanumeric = false;
        options.Password.RequireDigit = false;

        options.Lockout.AllowedForNewUsers = true;
        options.Lockout.DefaultLockoutTimeSpan = TimeSpan.FromMinutes(1);
        options.Lockout.MaxFailedAccessAttempts = 5;
    })
    .AddEntityFrameworkStores<RadarDbContext>()
    .AddDefaultTokenProviders();

builder.Services.Configure<JwtSettings>(builder.Configuration.GetSection("JwtSettings"));
JwtSettings jwtSettings = builder.Configuration.GetSection("JwtSettings").Get<JwtSettings>() ?? new JwtSettings();

builder.Services
    .AddAuthentication(options =>
    {
        options.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
        options.DefaultChallengeScheme = JwtBearerDefaults.AuthenticationScheme;
        options.DefaultSignInScheme = CookieAuthenticationDefaults.AuthenticationScheme;
    })
    .AddCookie(options =>
    {
        options.Cookie.HttpOnly = true;
        options.Cookie.SameSite = SameSiteMode.Strict;
        options.Cookie.Name = AuthCookies.AccessToken;
        options.ExpireTimeSpan = TimeSpan.FromMinutes(jwtSettings.AccessTokenMinutes);
        options.SlidingExpiration = true;
    })
    .AddJwtBearer(options =>
    {
        options.RequireHttpsMetadata = false;
        options.SaveToken = true;

        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateIssuerSigningKey = true,
            ValidIssuer = jwtSettings.Issuer,
            ValidAudience = jwtSettings.Audience,
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtSettings.Key))
        };

        // токен приходит в HttpOnly cookie, а не в заголовке
        options.Events = new JwtBearerEvents
        {
            OnMessageReceived = context =>
            {
                string? token = context.Request.Cookies[AuthCookies.AccessToken];
                if (!string.IsNullOrEmpty(token))
                    context.Token = token;

                return Task.CompletedTask;
            }
        };
    });

builder.Services.AddAuthorizationBuilder()
    .SetDefaultPolicy(new AuthorizationPolicyBuilder(JwtBearerDefaults.AuthenticationScheme)
        .RequireAuthenticatedUser()
        .Build());

builder.Services.AddScoped<AccountSeeder>();
builder.Services.AddScoped<ModelSeeder>();

// перечисления уходят и приходят строками в camelCase
builder.Services.AddControllers(options => options.Filters.Add<EngineExceptionFilter>())
    .AddJsonOptions(options => options.JsonSerializerOptions.Converters.Add(
        new System.Text.Json.Serialization.JsonStringEnumConverter(JsonNamingPolicy.CamelCase)));
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();
builder.Services.AddSignalR();

string[] allowedOrigins = builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>() ?? [];

builder.Services.AddCors(options => options.AddDefaultPolicy(policy => policy
    .WithOrigins(allowedOrigins)
    .AllowAnyHeader()
    .AllowAnyMethod()
    .AllowCredentials()));

var app = builder.Build();

app.Logger.LogDisabledBackgroundServices();

// сессии реального времени живут в памяти: при штатной остановке сервера их обзоры сохраняются в историю
app.Lifetime.ApplicationStopping.Register(() =>
    app.Services.GetRequiredService<RealtimeService>().StopAllAsync(CancellationToken.None).Wait(TimeSpan.FromSeconds(10)));

// схема БД создаётся и обновляется миграциями при старте; миграции, удаляющие данные, не применяются
using (IServiceScope scope = app.Services.CreateScope())
{
    ILogger schemaLogger = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger(typeof(DatabaseSchema).FullName!);
    await DatabaseSchema.UpdateAsync(scope.ServiceProvider.GetRequiredService<RadarDbContext>(), schemaLogger);

    // роль и учётная запись администратора при первом запуске
    await scope.ServiceProvider.GetRequiredService<AccountSeeder>().SeedAsync();

    // справочник моделей: пакеты диплома
    await scope.ServiceProvider.GetRequiredService<ModelSeeder>().SeedAsync();
}

app.UseSwagger();
app.UseSwaggerUI();

// время обработки каждого запроса в логе
app.UseRequestTiming();

app.UseCors();

app.UseCookiePolicy(new CookiePolicyOptions { HttpOnly = HttpOnlyPolicy.Always });

app.UseAuthentication();
app.UseAuthorization();

app.MapControllers();

app.MapHub<RadarHub>("/hub/radar");

app.Run();
