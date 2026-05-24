using AstervoidsWeb.Hubs;
using Microsoft.AspNetCore.SignalR;

namespace AstervoidsWeb.Services;

/// <summary>
/// Hosted service that subscribes to the session directory change feed and
/// rebroadcasts <c>OnSessionsChanged</c> to the <c>AllClients</c> SignalR group
/// on every change.
///
/// Today (single region) this is redundant with the inline broadcasts in
/// <see cref="SessionHub"/>. In Phase 3, when each region runs its own
/// <see cref="ISessionDirectory"/> backed by a shared store (e.g. Cosmos change feed),
/// this becomes the mechanism that propagates remote-region changes to every
/// browser regardless of which region the browser is connected to.
/// </summary>
public class SessionDirectoryMirror : BackgroundService
{
    private readonly ISessionDirectory _directory;
    private readonly IHubContext<SessionHub> _hubContext;
    private readonly ILogger<SessionDirectoryMirror> _logger;

    private const string AllClientsGroup = SessionHub.AllClientsGroup;

    public SessionDirectoryMirror(
        ISessionDirectory directory,
        IHubContext<SessionHub> hubContext,
        ILogger<SessionDirectoryMirror> logger)
    {
        _directory = directory;
        _hubContext = hubContext;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("SessionDirectoryMirror started");

        try
        {
            await foreach (var change in _directory.SubscribeAsync(stoppingToken))
            {
                try
                {
                    await _hubContext.Clients.Group(AllClientsGroup).SendAsync("OnSessionsChanged", stoppingToken);
                    _logger.LogDebug(
                        "Mirrored directory change: {Kind} session {SessionId}",
                        change.Kind, change.Entry.SessionId);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Failed to broadcast OnSessionsChanged from directory mirror");
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Normal shutdown
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "SessionDirectoryMirror terminated unexpectedly");
        }

        _logger.LogInformation("SessionDirectoryMirror stopped");
    }
}
