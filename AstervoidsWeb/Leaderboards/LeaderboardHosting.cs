using System.Globalization;
using System.Threading.RateLimiting;
using AstervoidsWeb.Configuration;
using AstervoidsWeb.Identity;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Options;

namespace AstervoidsWeb.Leaderboards;

internal static class LeaderboardHosting
{
    public static IServiceCollection AddLeaderboards(
        this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<LeaderboardSettings>(configuration.GetSection(LeaderboardSettings.SectionName));
        services.AddSingleton<ILeaderboardStore>(provider =>
        {
            var settings = provider.GetRequiredService<IOptions<IdentitySettings>>().Value;
            var environment = provider.GetRequiredService<IHostEnvironment>();
            try
            {
                if (string.Equals(settings.Provider, "File", StringComparison.OrdinalIgnoreCase))
                {
                    if ((!environment.IsDevelopment() && !settings.AllowFileInProduction)
                        || string.IsNullOrWhiteSpace(settings.DataFile))
                        return new UnavailableLeaderboardStore();
                    var identityPath = Path.IsPathRooted(settings.DataFile) ? settings.DataFile
                        : Path.Combine(environment.ContentRootPath, settings.DataFile);
                    return new FileLeaderboardStore(CompanionDataFile(identityPath));
                }
                if (IdentityTableClient.Create(settings) is { } table)
                    return new AzureTableLeaderboardStore(table);
            }
            catch (Exception exception) when (exception is ArgumentException or NotSupportedException)
            {
                // A misconfigured/outage provider never substitutes ephemeral storage.
            }
            return new UnavailableLeaderboardStore();
        });
        services.AddSingleton<LeaderboardService>();
        services.AddRateLimiter(options =>
        {
            var settings = configuration.GetSection($"{LeaderboardSettings.SectionName}:RateLimit")
                .Get<LeaderboardRateLimitSettings>() ?? new();
            var window = TimeSpan.FromSeconds(Math.Clamp(settings.WindowSeconds, 1, 3600));
            var limiter = PartitionedRateLimiter.CreateChained(
                PartitionedRateLimiter.Create<HttpContext, string>(context => Partition(
                    LeaderboardEndpoints.IsScoreWrite(context.Request), "leaderboard-browser:",
                    context.Items[IdentityHosting.BrowserHashItem] as string ?? "invalid",
                    settings.ScoreBrowserPermitLimit, window)),
                PartitionedRateLimiter.Create<HttpContext, string>(context => Partition(
                    LeaderboardEndpoints.IsScoreWrite(context.Request), "leaderboard-write-ip:",
                    IpHash(context), settings.ScoreIpPermitLimit, window)),
                PartitionedRateLimiter.Create<HttpContext, string>(context => Partition(
                    LeaderboardEndpoints.IsQuery(context.Request), "leaderboard-query-ip:",
                    IpHash(context), settings.QueryIpPermitLimit, window)));

            // Extend the existing identity limiter, including its separate browser
            // and IP budgets; never replace it with a leaderboard-only policy.
            options.GlobalLimiter = options.GlobalLimiter is { } existing
                ? PartitionedRateLimiter.CreateChained(existing, limiter) : limiter;
            var existingRejection = options.OnRejected;
            options.OnRejected = async (context, cancellationToken) =>
            {
                if (!LeaderboardEndpoints.IsLeaderboardRequest(context.HttpContext) && existingRejection is not null)
                {
                    await existingRejection(context, cancellationToken);
                    return;
                }
                var seconds = context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter)
                    ? Math.Max(1, (int)Math.Ceiling(retryAfter.TotalSeconds)) : (int)window.TotalSeconds;
                context.HttpContext.Response.Headers.RetryAfter = seconds.ToString(CultureInfo.InvariantCulture);
                await LeaderboardEndpoints.WriteAsync(context.HttpContext,
                    LeaderboardResult.Failure("rate_limited"), cancellationToken);
            };
        });
        return services;
    }

    public static string CompanionDataFile(string identityDataFile) => identityDataFile + ".leaderboard.json";

    private static string IpHash(HttpContext context) =>
        IdentitySecrets.Hash(context.Connection.RemoteIpAddress?.MapToIPv6().ToString() ?? "unknown");

    private static RateLimitPartition<string> Partition(
        bool limited, string prefix, string key, int permits, TimeSpan window) =>
        limited ? RateLimitPartition.GetFixedWindowLimiter(prefix + key, _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = Math.Max(1, permits),
            Window = window,
            QueueLimit = 0,
            AutoReplenishment = true
        }) : RateLimitPartition.GetNoLimiter("other");
}
