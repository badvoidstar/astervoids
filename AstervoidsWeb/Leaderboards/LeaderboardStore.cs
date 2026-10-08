namespace AstervoidsWeb.Leaderboards;

internal interface ILeaderboardStore
{
    Task<LeaderboardRecord?> ReadAsync(Guid playerId, Guid runId, CancellationToken cancellationToken);
    Task<bool> TryCommitAsync(
        LeaderboardRecord? previous, LeaderboardRecord next, CancellationToken cancellationToken);
    Task<IReadOnlyList<LeaderboardRecord>> QueryAsync(
        LeaderboardQueryRequest query, int limit, CancellationToken cancellationToken);
}

internal sealed class LeaderboardStoreUnavailableException : Exception
{
    public LeaderboardStoreUnavailableException() : base("Leaderboard storage is unavailable.") { }
}

internal sealed class UnavailableLeaderboardStore : ILeaderboardStore
{
    public Task<LeaderboardRecord?> ReadAsync(Guid playerId, Guid runId, CancellationToken cancellationToken) =>
        throw new LeaderboardStoreUnavailableException();

    public Task<bool> TryCommitAsync(
        LeaderboardRecord? previous, LeaderboardRecord next, CancellationToken cancellationToken) =>
        throw new LeaderboardStoreUnavailableException();

    public Task<IReadOnlyList<LeaderboardRecord>> QueryAsync(
        LeaderboardQueryRequest query, int limit, CancellationToken cancellationToken) =>
        throw new LeaderboardStoreUnavailableException();
}
