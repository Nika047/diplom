using radar.forecast.data;
using radar.forecast.data.App;
using radar.forecast.Services;

using Microsoft.EntityFrameworkCore;

namespace radar.forecast.Setup;

// справочник моделей при старте: по каждому пакету диплома (папка с config.json в Storage:DiplomBundles, всех прогонов) -
// гибрид (или сеть без IMM) на каждый seed пакета и ансамбль (если сетей больше одной), у CV, KF и жадного ансамбля - одна
// модель; у итоговых пакетов случаев (<прогон>/<случай>) - ещё IMM. Модель диплома не удаляется (на неё ссылаются запуски); наименование, примечание, состав и прогон обновляются из
// config.json, пока пользователь их не правил (DbModel.Edited)
public class ModelSeeder(RadarDbContext db, AppStorage storage, ILogger<ModelSeeder> logger)
{
    private readonly RadarDbContext db = db;
    private readonly AppStorage storage = storage;
    private readonly ILogger<ModelSeeder> logger = logger;

    public async Task SeedAsync()
    {
        if (!Directory.Exists(storage.DiplomBundles))
        {
            logger.LogWarning("Нет папки пакетов диплома {Dir} - модели диплома не заведены", storage.DiplomBundles);
            return;
        }

        List<DbModel> existing = await db.Models.Where(m => m.FromDiplom).ToListAsync();

        int added = 0;
        int updated = 0;

        foreach (string dir in Directory.EnumerateFiles(storage.DiplomBundles, "config.json", SearchOption.AllDirectories)
            .Select(Path.GetDirectoryName)
            .OfType<string>()
            .OrderBy(d => d))
        {
            BundleConfig? cfg;

            try
            {
                cfg = ModelCatalog.ReadConfig(dir);
            }
            catch (Exception ex) when (ex is InvalidDataException or System.Text.Json.JsonException or InvalidOperationException)
            {
                logger.LogWarning("Пакет {Dir} пропущен: {Error}", dir, ex.Message);
                continue;
            }

            if (cfg == null)
                continue;

            string bundle = storage.BundleKey(dir);
            // пакет случая - <прогон>/<случай>; вложенные compare/ и extra/ - глубже
            bool caseBundle = storage.DiplomBundleId(dir)?.Count(c => c == '/') == 1;
            string run = cfg.Run ?? storage.DiplomBundleId(dir)?.Split('/')[0] ?? "не указан";
            string source = caseBundle ? "Модель диплома из пакета случая, этап 11" : "Модель диплома";

            // у CV, KF и жадного ансамбля участники не выбираются - одна модель пакета
            List<(ForecastKindEnum Kind, List<int>? Seeds)> wanted = [];
            if (caseBundle) wanted.Add((ForecastKindEnum.Imm, null));
            if (!cfg.HasMembers) wanted.Add((ForecastKindEnum.Hyb, null));
            wanted.AddRange(cfg.HasMembers ? cfg.Seeds.Select(s => (ForecastKindEnum.Hyb, (List<int>?)[s])) : []);
            if (cfg.HasMembers && cfg.Seeds.Count > 1) wanted.Add((ForecastKindEnum.Ens, null));

            List<DbModel> ofBundle = [.. existing.Where(m => m.Bundle == bundle)];

            // гибрид без выбора seed - первый участник пакета
            foreach (DbModel old in ofBundle.Where(m => m.Kind == ForecastKindEnum.Hyb && m.Seeds == null && cfg.Seeds.Count > 0))
                old.Seeds = cfg.Seeds[0].ToString();

            foreach ((ForecastKindEnum kind, List<int>? seeds) in wanted)
            {
                string? seedsText = seeds == null ? null : string.Join(",", seeds);
                DbModel? model = ofBundle.FirstOrDefault(m => m.Kind == kind && m.Seeds == seedsText);
                string note = ModelCatalog.DefaultNote(cfg, kind, source, run, seeds) + (cfg.Note == null ? string.Empty : $" {cfg.Note}");

                if (model == null)
                {
                    db.Models.Add(new DbModel
                    {
                        Name = ModelCatalog.DefaultName(cfg, kind, seeds),
                        Note = note,
                        Bundle = bundle,
                        Kind = kind,
                        Case = cfg.Case,
                        Label = ModelCatalog.NetName(cfg.Label),
                        Members = cfg.Seeds.Count,
                        Seeds = seedsText,
                        Run = run,
                        FromDiplom = true,
                        Created = DateTime.Now
                    });
                    added++;
                    continue;
                }

                string name = ModelCatalog.DefaultName(cfg, kind, seeds);

                if (model.Edited || (model.Name == name && model.Note == note && model.Run == run && model.Members == cfg.Seeds.Count
                    && model.Label == ModelCatalog.NetName(cfg.Label)))
                    continue;

                // пакет в дипломе переписан (например, сменилась итоговая модель): подписи - по нему
                model.Name = name;
                model.Note = note;
                model.Run = run;
                model.Case = cfg.Case;
                model.Label = ModelCatalog.NetName(cfg.Label);
                model.Members = cfg.Seeds.Count;
                updated++;
            }
        }

        if (added > 0 || updated > 0 || db.ChangeTracker.HasChanges())
        {
            await db.SaveChangesAsync();
            logger.LogInformation("Справочник моделей: моделей диплома добавлено {Added}, обновлено {Updated}", added, updated);
        }
    }
}
