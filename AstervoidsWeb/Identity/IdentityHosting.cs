using System.Globalization;
using System.Threading.RateLimiting;
using AstervoidsWeb.Configuration;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Options;

namespace AstervoidsWeb.Identity;

internal static class IdentityHosting
{
    public const string CorsPolicy = "IdentityApi";
    public const string BrowserHeader = "X-Astervoids-Browser";
    public const string BrowserHashItem = "Astervoids.Identity.BrowserHash";
    public static readonly TimeSpan PreflightMaxAge = TimeSpan.FromMinutes(10);

    public static IServiceCollection AddPlayerIdentity(
        this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<IdentitySettings>(configuration.GetSection(IdentitySettings.SectionName));
        services.AddSingleton<IIdentityStore>(provider =>
        {
            var settings = provider.GetRequiredService<IOptions<IdentitySettings>>().Value;
            var environment = provider.GetRequiredService<IHostEnvironment>();
            try
            {
                if (settings.Provider.Equals("File", StringComparison.OrdinalIgnoreCase))
                {
                    if (!environment.IsDevelopment() && !settings.AllowFileInProduction)
                        return new UnavailableIdentityStore();
                    if (string.IsNullOrWhiteSpace(settings.DataFile))
                        return new UnavailableIdentityStore();
                    return new FileIdentityStore(Path.IsPathRooted(settings.DataFile)
                        ? settings.DataFile : Path.Combine(environment.ContentRootPath, settings.DataFile));
                }
                if (IdentityTableClient.Create(settings) is { } table)
                    return new AzureTableIdentityStore(table);
            }
            catch (Exception exception) when (exception is ArgumentException or NotSupportedException)
            {
                // Invalid deployment configuration disables only identity, never
                // resets its data or silently substitutes another provider.
            }
            return new UnavailableIdentityStore();
        });
        services.AddSingleton<PlayerIdentityService>();
        services.AddSingleton<IdentityOrigins>();
        services.AddCors(options =>
        {
            var origins = IdentityOrigins.Configured(configuration
                .GetSection(RegionSettings.SectionName).Get<RegionSettings>() ?? new());
            options.AddPolicy(CorsPolicy, policy => policy.WithOrigins(origins)
                .WithMethods("POST").WithHeaders("Content-Type", BrowserHeader)
                .WithExposedHeaders("Retry-After")
                .SetPreflightMaxAge(PreflightMaxAge));
        });
        services.AddRateLimiter(options =>
        {
            var settings = configuration.GetSection(IdentitySettings.SectionName)
                .Get<IdentitySettings>() ?? new();
            var window = TimeSpan.FromSeconds(Math.Clamp(settings.RateLimit.WindowSeconds, 1, 3600));
            options.GlobalLimiter = PartitionedRateLimiter.CreateChained(
                PartitionedRateLimiter.Create<HttpContext, string>(context =>
                    Partition(context, "browser:", Math.Max(1, settings.RateLimit.BrowserPermitLimit),
                        context.Items[BrowserHashItem] as string ?? "invalid", window)),
                PartitionedRateLimiter.Create<HttpContext, string>(context =>
                    Partition(context, "ip:", Math.Max(1, settings.RateLimit.IpPermitLimit),
                        IdentitySecrets.Hash(context.Connection.RemoteIpAddress?.MapToIPv6().ToString()
                            ?? "unknown"), window)));
            options.OnRejected = async (context, cancellationToken) =>
            {
                var seconds = context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter)
                    ? Math.Max(1, (int)Math.Ceiling(retryAfter.TotalSeconds))
                    : (int)window.TotalSeconds;
                context.HttpContext.Response.Headers.RetryAfter = seconds.ToString(CultureInfo.InvariantCulture);
                await IdentityEndpoints.WriteAsync(context.HttpContext,
                    IdentityResult.Failure("rate_limited"), cancellationToken);
            };
        });
        return services;
    }

    private static RateLimitPartition<string> Partition(
        HttpContext context, string prefix, int permits, string key, TimeSpan window) =>
        IdentityEndpoints.IsLimitedMutation(context.Request)
            ? RateLimitPartition.GetFixedWindowLimiter(prefix + key, _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = permits,
                Window = window,
                QueueLimit = 0,
                AutoReplenishment = true
            })
            : RateLimitPartition.GetNoLimiter("other");

}

internal sealed class IdentityOrigins(IOptions<RegionSettings> settings)
{
    private readonly HashSet<string> _allowed = new(Configured(settings.Value), StringComparer.Ordinal);

    public bool Allows(HttpRequest request)
    {
        if (!request.Headers.TryGetValue("Origin", out var origins))
            return true;
        if (origins.Count != 1 || Canonical(origins[0]) is not { } origin)
            return false;
        return _allowed.Contains(origin)
            || origin == Canonical($"{request.Scheme}://{request.Host}");
    }

    public static string[] Configured(RegionSettings settings) => settings.Regions
        .Select(region => region.Hostname).Concat([settings.ApexHostname])
        .Concat(settings.AdditionalAllowedOrigins)
        .Select(Canonical).OfType<string>().Distinct(StringComparer.Ordinal).ToArray();

    private static string? Canonical(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)
            || !Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri)
            || uri.Scheme is not ("http" or "https")
            || uri.AbsolutePath != "/" || uri.Query.Length != 0
            || uri.Fragment.Length != 0 || uri.UserInfo.Length != 0)
            return null;
        return uri.GetLeftPart(UriPartial.Authority);
    }
}
