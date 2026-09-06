using AstervoidsWeb.Configuration;
using AstervoidsWeb.Hubs;
using AstervoidsWeb.Models;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;

namespace AstervoidsWeb.Services;

/// <summary>
/// Background service that periodically checks for and cleans up expired sessions.
/// Handles two timeout tiers:
/// 1. Empty timeout: sessions with no connected members for a configurable duration.
/// 2. Absolute timeout: sessions that have exceeded a maximum lifetime regardless of activity.
/// </summary>
public class SessionCleanupService : BackgroundService
{
    private readonly ISessionService _sessionService;
    private readonly IHubContext<SessionHub> _hubContext;
    private readonly SyncSchemaRegistry _schemaRegistry;
    private readonly ISessionOperationCoordinator _operationCoordinator;
    private readonly ILogger<SessionCleanupService> _logger;
    private readonly TimeSpan _emptyTimeout;
    private readonly TimeSpan _absoluteTimeout;
    private static readonly TimeSpan CheckInterval = TimeSpan.FromSeconds(10);

    // Group name must match SessionHub.AllClientsGroup
    private const string AllClientsGroup = SessionHub.AllClientsGroup;

    public SessionCleanupService(
        ISessionService sessionService,
        IHubContext<SessionHub> hubContext,
        SyncSchemaRegistry schemaRegistry,
        IOptions<SessionSettings> settings,
        ILogger<SessionCleanupService> logger,
        ISessionOperationCoordinator operationCoordinator)
    {
        _sessionService = sessionService;
        _hubContext = hubContext;
        _schemaRegistry = schemaRegistry;
        _operationCoordinator = operationCoordinator ?? throw new ArgumentNullException(nameof(operationCoordinator));
        _logger = logger;
        _emptyTimeout = TimeSpan.FromSeconds(settings.Value.EmptyTimeoutSeconds);
        _absoluteTimeout = TimeSpan.FromMinutes(settings.Value.AbsoluteTimeoutMinutes);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation(
            "Session cleanup service started. Empty timeout: {EmptyTimeout}s, Absolute timeout: {AbsoluteTimeout}min",
            _emptyTimeout.TotalSeconds, _absoluteTimeout.TotalMinutes);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(CheckInterval, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }

            try
            {
                await CleanupExpiredSessions();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error during session cleanup");
            }
        }
    }

    internal async Task CleanupExpiredSessions()
    {
        var now = DateTime.UtcNow;
        var sessions = _sessionService.GetAllSessions().ToList();
        var sessionsDestroyed = false;

        foreach (var session in sessions)
        {
            string? reason = null;
            SessionDestroyCondition? condition = null;
            TimeSpan? emptyDuration = null;

            lock (session.SyncRoot)
            {
                if (session.LifecycleState != SessionLifecycleState.Active)
                    continue;

                // Absolute timeout takes priority. The declarative condition is
                // re-evaluated by SessionService after this method enters the
                // asynchronous per-session operation gate.
                if (now - session.CreatedAt > _absoluteTimeout)
                {
                    reason = "Session exceeded maximum duration";
                    condition = new SessionDestroyCondition(
                        CreatedBefore: now - _absoluteTimeout);
                }
                else if (session.Members.IsEmpty
                         && session.LastMemberLeftAt is { } lastMemberLeftAt
                         && now - lastMemberLeftAt > _emptyTimeout)
                {
                    reason = "Session was empty for too long";
                    emptyDuration = now - lastMemberLeftAt;
                    condition = new SessionDestroyCondition(
                        LastMemberLeftBefore: now - _emptyTimeout,
                        RequireEmpty: true);
                }
            }

            if (reason != null)
            {
                if (emptyDuration.HasValue)
                {
                    _logger.LogInformation(
                        "Session {SessionName} ({SessionId}) empty for {EmptyDuration}s (timeout: {EmptyTimeout}s). Destroying.",
                        session.Name, session.Id,
                        emptyDuration.Value.TotalSeconds,
                        _emptyTimeout.TotalSeconds);
                }
                else
                {
                    _logger.LogInformation(
                        "Session {SessionName} ({SessionId}) exceeded absolute timeout ({AbsoluteTimeout}min). Created at {CreatedAt}.",
                        session.Name, session.Id, _absoluteTimeout.TotalMinutes, session.CreatedAt);
                }

                using var operation =
                    await _operationCoordinator.EnterAsync(session.Id);
                var result = _sessionService.ForceDestroySession(
                    session.Id, condition);
                if (result != null)
                {
                    sessionsDestroyed = true;

                    // Sessions are torn down here (not in SessionHub.LeaveSession,
                    // which only marks LastMemberLeftAt and lets the session sit
                    // in an empty grace window where a rejoin is still possible).
                    // Clear positional schemas registered for this session id so
                    // the registry doesn't accumulate entries forever.
                    _schemaRegistry.ClearSession(session.Id);

                    // Notify any connected members (only relevant for absolute timeout)
                    foreach (var connectionId in result.ConnectionIds)
                    {
                        try
                        {
                            await _hubContext.Clients.Client(connectionId)
                                .SendAsync("OnSessionExpired", session.Id, reason);
                            await _hubContext.Groups.RemoveFromGroupAsync(
                                connectionId, session.Id.ToString());
                        }
                        catch (Exception ex)
                        {
                            _logger.LogWarning(ex,
                                "Failed to notify connection {ConnectionId} of session expiration",
                                connectionId);
                        }
                    }
                }
            }
        }

        // Broadcast session list change once if any sessions were destroyed
        if (sessionsDestroyed)
        {
            await _hubContext.Clients.Group(AllClientsGroup).SendAsync("OnSessionsChanged");
        }
    }
}
