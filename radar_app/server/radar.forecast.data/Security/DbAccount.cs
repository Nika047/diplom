using System.Runtime.Serialization;
using System.Text.Json.Serialization;

using Microsoft.AspNetCore.Identity;

namespace radar.forecast.data.Security;

// учётная запись: таблицы ASP.NET Identity, ключ Guid. в приложении одна запись - admin (Setup/AccountSeeder)
public class DbAccount : IdentityUser<Guid>
{
    public string? DisplayName { get; set; }

    [JsonIgnore]
    [IgnoreDataMember]
    public List<DbRefreshToken> Tokens { get; set; } = [];
}

public class DbRefreshToken : DbAbstractDataObject
{
    public DbAccount? Owner { get; set; }

    public string Token { get; set; } = string.Empty;

    public DateTime ExpiryDate { get; set; }

    public bool IsRevoked { get; set; } // отозванный токен обменять на новый сеанс нельзя
}
