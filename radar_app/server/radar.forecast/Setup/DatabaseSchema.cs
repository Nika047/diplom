using System.Text.RegularExpressions;

using radar.forecast.data;

using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace radar.forecast.Setup;

// обновление схемы БД миграциями при старте: добавлять и менять можно, удалять таблицы и колонки - нет
public static class DatabaseSchema
{
    // у SQLite смена колонки или новый внешний ключ - пересоздание таблицы: копия в "ef_temp_...", DROP TABLE исходной и
    // переименование. Такая миграция тоже останавливается (каскадные ключи при удалении таблицы задели бы связанные строки):
    // новые ссылки на существующие таблицы - через новую таблицу или без внешнего ключа
    private static readonly Regex DropStatement = new(@"\bDROP\s+(TABLE|COLUMN)\s+(?!""ef_temp_)", RegexOptions.IgnoreCase);

    public static async Task UpdateAsync(RadarDbContext db, ILogger logger, CancellationToken ct = default)
    {
        List<string> pending = [.. await db.Database.GetPendingMigrationsAsync(ct)];

        if (pending.Count == 0)
        {
            logger.LogInformation("Схема БД актуальна, новых миграций нет");
            return;
        }

        string? lastApplied = (await db.Database.GetAppliedMigrationsAsync(ct)).LastOrDefault();
        string script = db.GetService<IMigrator>().GenerateScript(lastApplied, null);

        Match drop = DropStatement.Match(script);

        if (drop.Success)
            throw new InvalidOperationException(
                $"Миграции {string.Join(", ", pending)} удаляют данные ({drop.Value}). Обновление схемы остановлено");

        logger.LogInformation("Применяются миграции: {Migrations}", string.Join(", ", pending));
        await db.Database.MigrateAsync(ct);
        logger.LogInformation("Схема БД обновлена");
    }
}
