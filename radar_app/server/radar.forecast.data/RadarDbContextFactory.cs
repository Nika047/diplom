using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;
using Microsoft.Extensions.Configuration;

namespace radar.forecast.data;

// фабрика контекста для команд dotnet ef (создание миграций)
// в рантайме не используется - там контекст настраивается в radar.forecast
public class RadarDbContextFactory : IDesignTimeDbContextFactory<RadarDbContext>
{
    private const string ConnectionName = "Data";

    private static readonly string[] SearchPaths =
    [
        ".",                    // запуск из папки веб-проекта
        "radar.forecast",       // запуск из папки решения
        "../radar.forecast",    // запуск из папки radar.forecast.data
    ];

    public RadarDbContext CreateDbContext(string[] args)
    {
        foreach (string path in SearchPaths)
        {
            string full = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), path));
            string file = Path.Combine(full, "appsettings.json");

            if (!File.Exists(file))
                continue;

            IConfigurationRoot configuration = new ConfigurationBuilder()
                .SetBasePath(full)
                .AddJsonFile("appsettings.json", optional: false)
                .Build();

            string connection = configuration.GetConnectionString(ConnectionName)
                ?? throw new InvalidOperationException($"В файле {file} не задана строка подключения ConnectionStrings:{ConnectionName}");

            DbContextOptionsBuilder<RadarDbContext> builder = new();
            builder.UseSqlite(RadarDbContext.ResolveConnection(connection, full));

            return new RadarDbContext(builder.Options);
        }

        throw new InvalidOperationException("Не найден appsettings.json веб-проекта. Запускайте команды dotnet ef из папки server");
    }
}
