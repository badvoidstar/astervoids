using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using AstervoidsWeb.Configuration;
using AstervoidsWeb.Identity;

namespace AstervoidsWeb.Leaderboards;

internal sealed record SubmitScoreRequest(
    Guid PlayerId, Guid RunId, uint Score, int Wave, int TeamSize, double AspectRatio, double Difficulty);

internal sealed record LeaderboardQueryRequest(
    int? TeamSize = null, string? Aspect = null, double? Difficulty = null);

internal sealed record RecordedScoreReply(bool Recorded);
internal sealed record LeaderboardEntry(
    int Rank, string Name, uint Score, int Wave, double Difficulty, int TeamSize, string Aspect);
internal sealed record LeaderboardQueryReply(
    IReadOnlyList<LeaderboardEntry> Entries, int Limit, int MaxTeamSize);

internal sealed record LeaderboardResult(int StatusCode, JsonElement Body)
{
    public bool Succeeded => StatusCode is >= 200 and < 300;

    public static LeaderboardResult Success<T>(T body) =>
        new(200, JsonSerializer.SerializeToElement(body, IdentityJson.Options));

    public static LeaderboardResult Failure(string code, int? statusCode = null) => new(statusCode ?? (code switch
    {
        "invalid_browser_credential" => 401,
        "identity_required" or "binding_changed" => 409,
        "rate_limited" => 429,
        "leaderboard_unavailable" => 503,
        _ => 400
    }), JsonSerializer.SerializeToElement(new IdentityErrorReply(new(code)), IdentityJson.Options));
}

internal sealed record LeaderboardRecord(
    Guid PlayerId, Guid RunId, string Name, uint Score, int Wave, int TeamSize,
    double AspectRatio, double Difficulty, string Version)
{
    [JsonIgnore]
    public string? StorageEtag { get; init; }

    [JsonIgnore]
    public string Aspect => LeaderboardRules.ClassifyAspect(AspectRatio);
}

internal static class LeaderboardRules
{
    public const double MinimumDifficulty = 0.01;
    public const double MaximumDifficulty = 2;
    public const double PortraitThreshold = 0.75;
    public const double LandscapeThreshold = 4.0 / 3.0;

    public static string ClassifyAspect(double ratio) =>
        ratio < PortraitThreshold ? "portrait" : ratio > LandscapeThreshold ? "landscape" : "square";

    public static bool IsDifficulty(double value) =>
        double.IsFinite(value) && value is >= MinimumDifficulty and <= MaximumDifficulty;

    public static bool IsSubmission(SubmitScoreRequest request, int maxTeamSize) =>
        request.PlayerId != Guid.Empty && request.RunId != Guid.Empty && request.Wave >= 1
        && request.TeamSize >= 1 && request.TeamSize <= maxTeamSize
        && double.IsFinite(request.AspectRatio) && request.AspectRatio > 0
        && IsDifficulty(request.Difficulty);

    public static bool IsQuery(LeaderboardQueryRequest query, int maxTeamSize) =>
        (query.TeamSize is null || query.TeamSize >= 1 && query.TeamSize <= maxTeamSize)
        && query.Aspect is null or "portrait" or "landscape" or "square"
        && (query.Difficulty is null || IsDifficulty(query.Difficulty.Value));

    public static bool Matches(LeaderboardRecord record, LeaderboardQueryRequest query) =>
        (query.TeamSize is null || query.TeamSize == record.TeamSize)
        && (query.Aspect is null || query.Aspect == record.Aspect)
        && (query.Difficulty is null || query.Difficulty == record.Difficulty);

    public static void Validate(LeaderboardRecord record)
    {
        if (!IsSubmission(new(record.PlayerId, record.RunId, record.Score, record.Wave,
                record.TeamSize, record.AspectRatio, record.Difficulty), int.MaxValue)
            || !IdentitySecrets.IsTag(record.Name)
            || !Guid.TryParseExact(record.Version, "N", out var version) || version == Guid.Empty
            || version.ToString("N") != record.Version)
            throw new LeaderboardStoreUnavailableException();
    }

    public static LeaderboardRecord Merge(
        LeaderboardRecord? previous, PlayerIdentity player, SubmitScoreRequest request)
    {
        if (previous is null)
            return new(player.Id, request.RunId, player.Tag, request.Score, request.Wave,
                request.TeamSize, request.AspectRatio, request.Difficulty, NewVersion());

        Validate(previous);
        if (previous.PlayerId != player.Id || previous.RunId != request.RunId || previous.Name != player.Tag)
            throw new LeaderboardStoreUnavailableException();

        var better = request.Score > previous.Score
            || request.Score == previous.Score && request.Wave > previous.Wave;
        var teamSize = Math.Max(previous.TeamSize, request.TeamSize);
        if (!better && teamSize == previous.TeamSize)
            return previous;

        return previous with
        {
            Score = better ? request.Score : previous.Score,
            Wave = better ? request.Wave : previous.Wave,
            AspectRatio = better ? request.AspectRatio : previous.AspectRatio,
            Difficulty = better ? request.Difficulty : previous.Difficulty,
            TeamSize = teamSize,
            Version = NewVersion(),
            StorageEtag = null
        };
    }

    private static string NewVersion() => Guid.NewGuid().ToString("N");
}

internal enum LeaderboardWriteKind { Add, Replace, Delete }
internal sealed record LeaderboardWrite(
    string Key, LeaderboardWriteKind Kind, LeaderboardRecord? Record);

internal static class LeaderboardRows
{
    public const string PartitionKey = "leaderboard";
    public const int IndexCount = 8;

    public static string CanonicalKey(Guid playerId, Guid runId) => $"C:{playerId:N}:{runId:N}";
    public static string CanonicalKey(LeaderboardRecord record) => CanonicalKey(record.PlayerId, record.RunId);

    public static string QueryPrefix(LeaderboardQueryRequest query) =>
        $"R:{query.TeamSize?.ToString(CultureInfo.InvariantCulture) ?? "*"}:"
        + $"{query.Aspect ?? "*"}:"
        + $"{(query.Difficulty is { } difficulty ? DifficultyKey(difficulty) : "*")}:";

    public static string QueryEnd(LeaderboardQueryRequest query) => QueryPrefix(query)[..^1] + ";";

    public static string RankKey(LeaderboardRecord record, LeaderboardQueryRequest query) =>
        QueryPrefix(query) + (uint.MaxValue - record.Score).ToString("D10", CultureInfo.InvariantCulture)
        + $":{record.PlayerId:N}:{record.RunId:N}";

    public static IReadOnlyList<string> IndexKeys(LeaderboardRecord record)
    {
        var keys = new string[IndexCount];
        for (var mask = 0; mask < IndexCount; mask++)
            keys[mask] = RankKey(record, new(
                (mask & 1) == 0 ? null : record.TeamSize,
                (mask & 2) == 0 ? null : record.Aspect,
                (mask & 4) == 0 ? null : record.Difficulty));
        return keys;
    }

    public static void ValidateQuery(LeaderboardQueryRequest query, int limit)
    {
        if (!LeaderboardRules.IsQuery(query, int.MaxValue) || limit is < 1 or > LeaderboardSettings.MaximumEntries)
            throw new LeaderboardStoreUnavailableException();
    }

    public static void ValidateJsonShape(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object || IdentityJson.HasDuplicateProperties(element)
            || element.EnumerateObject().Any(property => property.Name is not
                ("playerId" or "runId" or "name" or "score" or "wave" or "teamSize" or "aspectRatio" or "difficulty" or "version")))
            throw new LeaderboardStoreUnavailableException();
    }

    public static IReadOnlyList<LeaderboardWrite> Plan(LeaderboardRecord? previous, LeaderboardRecord next)
    {
        LeaderboardRules.Validate(next);
        if (previous is not null)
        {
            LeaderboardRules.Validate(previous);
            if (string.IsNullOrEmpty(previous.StorageEtag) || previous.StorageEtag == "*"
                || previous.PlayerId != next.PlayerId || previous.RunId != next.RunId
                || previous.Name != next.Name || next.Version == previous.Version
                || next.TeamSize < previous.TeamSize || next.Score < previous.Score
                || next.Score == previous.Score && next.Wave < previous.Wave
                || next.Score == previous.Score && next.Wave == previous.Wave
                    && (next.AspectRatio != previous.AspectRatio || next.Difficulty != previous.Difficulty))
                throw new LeaderboardStoreUnavailableException();
        }

        var oldKeys = previous is null ? new HashSet<string>(StringComparer.Ordinal)
            : IndexKeys(previous).ToHashSet(StringComparer.Ordinal);
        var newKeys = IndexKeys(next).ToHashSet(StringComparer.Ordinal);
        var writes = new List<LeaderboardWrite>
        {
            new(CanonicalKey(next), previous is null ? LeaderboardWriteKind.Add : LeaderboardWriteKind.Replace, next)
        };
        writes.AddRange(oldKeys.Except(newKeys).Select(key => new LeaderboardWrite(key, LeaderboardWriteKind.Delete, null)));
        writes.AddRange(newKeys.Select(key => new LeaderboardWrite(
            key, oldKeys.Contains(key) ? LeaderboardWriteKind.Replace : LeaderboardWriteKind.Add, next)));
        return writes;
    }

    private static string DifficultyKey(double value) =>
        BitConverter.DoubleToUInt64Bits(value).ToString("x16", CultureInfo.InvariantCulture);
}
