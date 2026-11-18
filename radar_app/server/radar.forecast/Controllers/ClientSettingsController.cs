using radar.forecast.Settings;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

namespace radar.forecast.Controllers;

[Route("api/[controller]")]
[ApiController]
public class ClientSettingsController(IOptions<MapSettings> optionsMap) : ControllerBase
{
    private readonly MapSettings mapSettings = optionsMap.Value;

    [AllowAnonymous]
    [HttpGet(nameof(Map))]
    public IActionResult Map() => Ok(new { yandexMapsKey = mapSettings.YandexMapsKey });
}
