namespace radar.forecast.Settings;

public class JwtSettings
{
    public string Issuer { get; set; } = string.Empty;
    public string Audience { get; set; } = string.Empty;
    public string Key { get; set; } = string.Empty;

    public int AccessTokenMinutes { get; set; } = 30; // время жизни токена доступа, минуты
    public int RefreshTokenHours { get; set; } = 48; // время жизни токена обновления, часы
}

// имена cookie, в которых лежат токены
public static class AuthCookies
{
    public const string AccessToken = ".AspNetCore.Identity.Application";
    public const string RefreshToken = ".AspNetCore.Identity.Application.Refresh";
}
