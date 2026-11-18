using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;

using radar.forecast.data;
using radar.forecast.data.Security;
using radar.forecast.Settings;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;

namespace radar.forecast.Controllers;

// вход по образцу ggnp.ofd: токен доступа JWT и токен обновления в HttpOnly cookie, токены обновления - в БД
[Authorize]
[Route("api/[controller]")]
[ApiController]
public class AuthController(
    RadarDbContext db,
    UserManager<DbAccount> userManager,
    IOptions<JwtSettings> optionsJwt,
    ILogger<AuthController> logger)
    : ControllerBase
{
    private readonly RadarDbContext db = db;
    private readonly UserManager<DbAccount> userManager = userManager;
    private readonly JwtSettings jwtSettings = optionsJwt.Value;
    private readonly ILogger<AuthController> logger = logger;

    [HttpPost(nameof(Login))]
    [AllowAnonymous]
    public async Task<IActionResult> Login(LoginDataModel model)
    {
        logger.LogInformation("Попытка входа в систему. UserId='{UserName}'", model.UserName);

        if (string.IsNullOrWhiteSpace(model.UserName) || string.IsNullOrWhiteSpace(model.Password))
            return Unauthorized(new { message = "Укажите имя пользователя и пароль" });

        DbAccount? user = await userManager.FindByNameAsync(model.UserName);

        if (user == null)
        {
            logger.LogInformation("Не найден пользователь. UserId='{UserName}'", model.UserName);
            return Unauthorized(new { message = "Неверное имя пользователя или пароль" });
        }

        if (await userManager.IsLockedOutAsync(user))
        {
            logger.LogInformation("Вход запрещён, учётная запись заблокирована. UserId='{UserName}'", model.UserName);
            return Unauthorized(new { message = "Учётная запись заблокирована" });
        }

        if (!await userManager.CheckPasswordAsync(user, model.Password))
        {
            await userManager.AccessFailedAsync(user);
            logger.LogInformation("Указан неверный пароль. UserId='{UserName}'", model.UserName);

            return Unauthorized(new { message = "Неверное имя пользователя или пароль" });
        }

        await userManager.ResetAccessFailedCountAsync(user);
        await IssueTokensAsync(user);

        logger.LogInformation("Вход выполнен. UserId='{UserName}'", model.UserName);

        return Ok(await BuildCurrentUserAsync(user));
    }

    [HttpPost(nameof(Refresh))]
    [AllowAnonymous]
    public async Task<IActionResult> Refresh()
    {
        string? refreshToken = Request.Cookies[AuthCookies.RefreshToken];

        if (string.IsNullOrEmpty(refreshToken))
            return Unauthorized(new { message = "Токен обновления не найден" });

        DbRefreshToken? stored = await db.RefreshTokens
            .Include(t => t.Owner)
            .FirstOrDefaultAsync(t => t.Token == refreshToken && !t.IsRevoked && t.ExpiryDate > DateTime.Now);

        if (stored?.Owner == null)
            return Unauthorized(new { message = "Токен обновления недействителен или просрочен" });

        DbAccount user = stored.Owner;

        if (await userManager.IsLockedOutAsync(user))
            return Unauthorized(new { message = "Учётная запись заблокирована" });

        // старый токен отзывается сразу: один токен обновления используется ровно один раз
        stored.IsRevoked = true;
        await db.SaveChangesAsync();

        await IssueTokensAsync(user);

        return Ok(await BuildCurrentUserAsync(user));
    }

    [HttpPost(nameof(Logout))]
    public async Task<IActionResult> Logout()
    {
        DbAccount? user = await userManager.GetUserAsync(User);

        await RevokeRefreshTokenAsync();

        Response.Cookies.Delete(AuthCookies.AccessToken);
        Response.Cookies.Delete(AuthCookies.RefreshToken);

        if (user != null)
            logger.LogInformation("Выход из системы. UserId='{UserName}'", user.UserName);

        return NoContent();
    }

    [HttpGet(nameof(GetUser))]
    public async Task<IActionResult> GetUser()
    {
        DbAccount? user = await userManager.GetUserAsync(User);

        if (user == null)
        {
            logger.LogInformation("Запрошен текущий пользователь, но сеанс не найден");
            return Unauthorized();
        }

        return Ok(await BuildCurrentUserAsync(user));
    }

    [HttpPost(nameof(ChangePassword))]
    public async Task<IActionResult> ChangePassword(ChangePasswordRequest model)
    {
        DbAccount? user = await userManager.GetUserAsync(User);

        if (user == null)
            return Unauthorized();

        if (string.IsNullOrWhiteSpace(model.NewPassword))
            return BadRequest(new { message = "Укажите новый пароль" });

        IdentityResult result = await userManager.ChangePasswordAsync(user, model.CurrentPassword ?? string.Empty, model.NewPassword);

        if (!result.Succeeded)
        {
            logger.LogInformation("Не удалось сменить пароль. UserId='{UserName}'", user.UserName);
            return BadRequest(new { message = string.Join("; ", result.Errors.Select(e => e.Description)) });
        }

        logger.LogInformation("Пароль изменён. UserId='{UserName}'", user.UserName);

        return NoContent();
    }

    private async Task IssueTokensAsync(DbAccount user)
    {
        IList<string> roles = await userManager.GetRolesAsync(user);

        SymmetricSecurityKey secretKey = new(Encoding.UTF8.GetBytes(jwtSettings.Key));
        SigningCredentials signinCredentials = new(secretKey, SecurityAlgorithms.HmacSha256);

        List<Claim> claims =
        [
            new Claim(ClaimTypes.Name, user.UserName ?? string.Empty),
            new Claim(ClaimTypes.NameIdentifier, user.Id.ToString()),
            new Claim(JwtRegisteredClaimNames.Sub, user.Id.ToString()),
            new Claim(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString()),
        ];

        claims.AddRange(roles.Select(role => new Claim(ClaimTypes.Role, role)));

        JwtSecurityToken tokenOptions = new(
            issuer: jwtSettings.Issuer,
            audience: jwtSettings.Audience,
            claims: claims,
            expires: DateTime.Now.AddMinutes(jwtSettings.AccessTokenMinutes),
            signingCredentials: signinCredentials);

        string accessToken = new JwtSecurityTokenHandler().WriteToken(tokenOptions);

        string refreshToken = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
        DateTime refreshExpires = DateTime.Now.AddHours(jwtSettings.RefreshTokenHours);

        db.RefreshTokens.Add(new DbRefreshToken
        {
            Owner = user,
            Token = refreshToken,
            ExpiryDate = refreshExpires,
            IsRevoked = false
        });

        await db.SaveChangesAsync();

        AppendCookie(AuthCookies.AccessToken, accessToken, tokenOptions.ValidTo);
        AppendCookie(AuthCookies.RefreshToken, refreshToken, refreshExpires);
    }

    private void AppendCookie(string name, string value, DateTime expires)
    {
        Response.Cookies.Append(name, value, new CookieOptions
        {
            HttpOnly = true,
            SameSite = SameSiteMode.Strict,
            Expires = expires
        });
    }

    private async Task RevokeRefreshTokenAsync()
    {
        string? refreshToken = Request.Cookies[AuthCookies.RefreshToken];
        if (string.IsNullOrEmpty(refreshToken))
            return;

        DbRefreshToken? stored = await db.RefreshTokens.FirstOrDefaultAsync(t => t.Token == refreshToken);
        if (stored == null)
            return;

        stored.IsRevoked = true;
        await db.SaveChangesAsync();
    }

    private async Task<CurrentUserResponse> BuildCurrentUserAsync(DbAccount user)
    {
        IList<string> roles = await userManager.GetRolesAsync(user);

        return new CurrentUserResponse
        {
            OID = user.Id,
            UserName = user.UserName,
            DisplayName = string.IsNullOrWhiteSpace(user.DisplayName) ? user.UserName : user.DisplayName,
            Roles = roles
        };
    }
}

public class LoginDataModel
{
    public string? UserName { get; set; }
    public string? Password { get; set; }
}

public class ChangePasswordRequest
{
    public string? CurrentPassword { get; set; }
    public string? NewPassword { get; set; }
}

public class CurrentUserResponse
{
    public Guid OID { get; set; }
    public string? UserName { get; set; }
    public string? DisplayName { get; set; }
    public IList<string> Roles { get; set; } = [];
}
