namespace AstervoidsWeb.Services;

/// <summary>
/// Abstraction over the session directory — the shared, observable store of all live
/// sessions across all regional instances.
///
/// Implementations must be thread-safe and must not acquire any application-level
/// lock that could cause deadlocks with <c>Session.SyncRoot</c>.  Callers (SessionHub,
/// SessionCleanupService) always invoke directory methods <em>outside</em> any session
/// lock.
/// </summary>
public interface ISessionDirectory
{
    /// <summary>
    /// Inserts or updates the entry for the given session.
    /// </summary>
    Task UpsertAsync(SessionDirectoryEntry entry, CancellationToken ct = default);

    /// <summary>
    /// Removes the entry for the given session.  A no-op if the session is not present.
    /// </summary>
    Task RemoveAsync(Guid sessionId, CancellationToken ct = default);

    /// <summary>
    /// Returns a point-in-time snapshot of all known session entries.
    /// </summary>
    Task<IReadOnlyList<SessionDirectoryEntry>> ListAsync(CancellationToken ct = default);

    /// <summary>
    /// Returns an async stream of change notifications.  The stream runs until
    /// <paramref name="ct"/> is cancelled.  Each subscriber receives its own
    /// independent stream; slow subscribers do not block others.
    /// </summary>
    IAsyncEnumerable<SessionDirectoryChange> SubscribeAsync(CancellationToken ct);
}
