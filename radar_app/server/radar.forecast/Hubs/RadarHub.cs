using radar.forecast.Services;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace radar.forecast.Hubs;

// канал реального времени. клиент подписывается на свою сессию (группа - OID сессии) и получает события:
// Scan - обзор посчитан или показан из памяти, Scans - пачка обзоров после перемотки вперед, State - состояние плеера
[Authorize]
public class RadarHub : Hub
{
    public Task Join(Guid sessionId) => Groups.AddToGroupAsync(Context.ConnectionId, sessionId.ToString());

    public Task Leave(Guid sessionId) => Groups.RemoveFromGroupAsync(Context.ConnectionId, sessionId.ToString());

    // часы сервера, Unix мс: клиент оценивает расхождение своих часов с сервером по времени запроса туда и обратно
    public double Ping() => RealtimeService.NowMs();
}
