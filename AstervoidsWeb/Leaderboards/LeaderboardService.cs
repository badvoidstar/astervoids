using AstervoidsWeb.Configuration;
using AstervoidsWeb.Identity;
using Microsoft.Extensions.Options;

namespace AstervoidsWeb.Leaderboards;

internal sealed class LeaderboardService(
    ILeaderboardStore store, PlayerIdentityService identities,
    IOptions<LeaderboardSettings> options, IOptions<SessionSettings> sessions)
{
    internal const int MaximumCommitAttempts = 8;

    public async Task<LeaderboardResult> SubmitAsync(
        string credential, SubmitScoreRequest request, CancellationToken cancellationToken = default)
    {
        if (!IdentitySecrets.IsToken(credential))
            return LeaderboardResult.Failure("invalid_browser_credential");
        if (!Configured())
            return LeaderboardResult.Failure("leaderboard_unavailable");
        if (!LeaderboardRules.IsSubmission(request, sessions.Value.MaxMembersPerSession))
            return LeaderboardResult.Failure("invalid_request");

        // Authorization is the durable binding read, not an atomic operation
        // spanning the identity and leaderboard transaction partitions.
        var verification = await identities.VerifyPlayerAsync(credential, request.PlayerId, cancellationToken);
        if (verification.Identity is null)
            return LeaderboardResult.Failure(verification.ErrorCode == "identity_unavailable"
                ? "leaderboard_unavailable" : verification.ErrorCode!);
        if (verification.Identity.ExcludeFromLeaderboards)
            return LeaderboardResult.Failure("leaderboard_ineligible");

        try
        {
            for (var attempt = 0; attempt < MaximumCommitAttempts; attempt++)
            {
                var previous = await store.ReadAsync(request.PlayerId, request.RunId, cancellationToken);
                var next = LeaderboardRules.Merge(previous, verification.Identity, request);
                if (ReferenceEquals(previous, next)
                    || await store.TryCommitAsync(previous, next, cancellationToken))
                    return LeaderboardResult.Success(new RecordedScoreReply(true));
            }
        }
        catch (LeaderboardStoreUnavailableException) { }
        return LeaderboardResult.Failure("leaderboard_unavailable");
    }

    public async Task<LeaderboardResult> QueryAsync(
        LeaderboardQueryRequest request, CancellationToken cancellationToken = default)
    {
        if (!Configured())
            return LeaderboardResult.Failure("leaderboard_unavailable");
        if (!LeaderboardRules.IsQuery(request, sessions.Value.MaxMembersPerSession))
            return LeaderboardResult.Failure("invalid_request");
        try
        {
            var records = await store.QueryAsync(request, options.Value.MaxEntries, cancellationToken);
            return LeaderboardResult.Success(new LeaderboardQueryReply(
                records.Select((record, index) => new LeaderboardEntry(
                    index + 1, record.Name, record.Score, record.Wave, record.Difficulty, record.TeamSize, record.Aspect)).ToArray(),
                options.Value.MaxEntries, sessions.Value.MaxMembersPerSession));
        }
        catch (LeaderboardStoreUnavailableException)
        {
            return LeaderboardResult.Failure("leaderboard_unavailable");
        }
    }

    private bool Configured() => options.Value.MaxEntries is >= 1 and <= LeaderboardSettings.MaximumEntries
        && sessions.Value.MaxMembersPerSession >= 1;
}
