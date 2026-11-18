using radar.forecast.data;
using radar.forecast.data.Security;

using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace radar.forecast.Setup;

// начальное наполнение при старте: роль администратора и учётная запись admin
public class AccountSeeder(
    RadarDbContext db,
    UserManager<DbAccount> userManager,
    RoleManager<IdentityRole<Guid>> roleManager,
    IConfiguration configuration,
    ILogger<AccountSeeder> logger)
{
    private readonly RadarDbContext db = db;
    private readonly UserManager<DbAccount> userManager = userManager;
    private readonly RoleManager<IdentityRole<Guid>> roleManager = roleManager;
    private readonly IConfiguration configuration = configuration;
    private readonly ILogger<AccountSeeder> logger = logger;

    public async Task SeedAsync()
    {
        if (!await roleManager.RoleExistsAsync(AppRoles.Administrator))
        {
            IdentityResult role = await roleManager.CreateAsync(new IdentityRole<Guid>(AppRoles.Administrator) { Id = Guid.NewGuid() });

            if (role.Succeeded)
                logger.LogInformation("Создана роль {Role}", AppRoles.Administrator);
            else
                logger.LogError("Не удалось создать роль {Role}: {Errors}", AppRoles.Administrator, string.Join("; ", role.Errors.Select(e => e.Description)));
        }

        await EnsureAdminAccountAsync();
    }

    // заводит учётную запись admin, если её нет. пароль из конфигурации (Seed:AdminPassword); если он не задан,
    // запись заблокирована и без пароля
    private async Task EnsureAdminAccountAsync()
    {
        const string adminUserName = "admin";

        DbAccount? existing = await db.Users.FirstOrDefaultAsync(a => a.UserName == adminUserName);

        if (existing != null)
        {
            if (!await userManager.IsInRoleAsync(existing, AppRoles.Administrator))
            {
                await userManager.AddToRoleAsync(existing, AppRoles.Administrator);
                logger.LogInformation("Учётной записи admin возвращена роль администратора");
            }

            return;
        }

        string? password = configuration["Seed:AdminPassword"];

        DbAccount admin = new()
        {
            Id = Guid.NewGuid(),
            UserName = adminUserName,
            DisplayName = "Администратор",
            LockoutEnabled = string.IsNullOrWhiteSpace(password),
            LockoutEnd = string.IsNullOrWhiteSpace(password) ? DateTimeOffset.MaxValue : null
        };

        IdentityResult result = string.IsNullOrWhiteSpace(password)
            ? await userManager.CreateAsync(admin)
            : await userManager.CreateAsync(admin, password);

        if (!result.Succeeded)
        {
            logger.LogError("Не удалось создать учётную запись администратора: {Errors}", string.Join("; ", result.Errors.Select(e => e.Description)));
            return;
        }

        await userManager.AddToRoleAsync(admin, AppRoles.Administrator);

        if (string.IsNullOrWhiteSpace(password))
        {
            logger.LogWarning("Учётная запись admin создана без пароля и заблокирована. " +
                "Задайте пароль в конфигурации Seed:AdminPassword и перезапустите приложение");
        }
        else
        {
            logger.LogInformation("Создана учётная запись администратора admin");
        }
    }
}
