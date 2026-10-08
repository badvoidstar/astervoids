namespace AstervoidsWeb.Configuration;

public sealed class LeaderboardSettings
{
    public const string SectionName = "Leaderboard";
    public const int MaximumEntries = 500;

    public int MaxEntries { get; set; } = 50;
    public LeaderboardRateLimitSettings RateLimit { get; set; } = new();
}

public sealed class LeaderboardRateLimitSettings
{
    // Independent per-instance budgets; anonymous reads are limited by connection IP.
    public int QueryIpPermitLimit { get; set; } = 120;
    public int ScoreBrowserPermitLimit { get; set; } = 120;
    public int ScoreIpPermitLimit { get; set; } = 600;
    public int WindowSeconds { get; set; } = 60;
}
