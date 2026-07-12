using System.Security.Cryptography;
using AstervoidsWeb.Configuration;
using AstervoidsWeb.Formatters;
using AstervoidsWeb.Hubs;
using AstervoidsWeb.Services;
using MessagePack;
using MessagePack.Resolvers;

var builder = WebApplication.CreateBuilder(args);

// Register configuration
builder.Services.Configure<SessionSettings>(
    builder.Configuration.GetSection(SessionSettings.SectionName));
builder.Services.Configure<RegionSettings>(
    builder.Configuration.GetSection(RegionSettings.SectionName));

// Register services
builder.Services.AddSingleton<ISessionNameGenerator, FruitNameGenerator>();
builder.Services.AddSingleton<ISessionService, SessionService>();
builder.Services.AddSingleton<IObjectService, ObjectService>();
builder.Services.AddSingleton<ISessionOperationCoordinator, SessionOperationCoordinator>();
builder.Services.AddSingleton<ServerMetricsService>();
builder.Services.AddSingleton<AstervoidsWeb.Hubs.SyncSchemaRegistry>();
builder.Services.AddHostedService<SessionCleanupService>();

// Use camelCase JSON property names for REST API endpoints
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase;
});

// Add response compression (Brotli + Gzip for all HTTP responses).
// Compresses static files (HTML/JS/CSS), SignalR negotiation, and fallback transports.
// EnableForHttps is safe here: payloads contain game state, not secrets susceptible to
// CRIME/BREACH side-channel attacks.
builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
});

// Read session settings for SignalR timeout configuration
var sessionSettings = builder.Configuration.GetSection(SessionSettings.SectionName).Get<SessionSettings>() ?? new SessionSettings();

// CORS for cross-region API calls and cross-region SignalR connections.
//
// The client needs to reach three resources on every configured region
// hostname (not just its landing origin):
//   1. /api/ping        — RTT measurement bursts
//   2. /api/regions     — manifest discovery
//   3. /api/sessions    — cross-region session-list aggregation
//   4. /sessionHub      — spectator SignalR connections that subscribe to
//                         OnSessionsChanged for live cross-region updates
//                         (Phase 3), plus the join/create connection itself
//                         when the user picks a non-landing region.
//
// SignalR requires AllowCredentials() (it uses sticky-session cookies) and
// AllowAnyHeader() (the JS client sets custom headers during negotiation).
// AllowCredentials + WithOrigins(specificOrigins) is the only safe pairing
// — wildcard origin + credentials is rejected by browsers.
//
// Same-origin requests are unaffected by this policy. Allowed origins are
// the hostnames listed in the Region manifest — they are static at
// deployment time, so there is no broad wildcard.
builder.Services.AddCors(options =>
{
    options.AddPolicy("RegionalApi", policy =>
    {
        var regions = builder.Configuration.GetSection(RegionSettings.SectionName)
            .Get<RegionSettings>() ?? new RegionSettings();
        var regionOrigins = regions.Regions
            .Select(r => r.Hostname.TrimEnd('/'))
            .Where(h => !string.IsNullOrEmpty(h));
        // Apex hostname is where every visitor lands first. Browsers issue
        // cross-origin requests from the apex to each per-region hostname for
        // RTT pings, session list, and SignalR negotiate, so the apex MUST be
        // in allowed origins on every regional app. Without this, the picker
        // stalls in "warming" (RTT measurements blocked) and Create fails
        // (hub negotiate blocked).
        var apexOrigin = regions.ApexHostname.TrimEnd('/');
        var origins = regionOrigins
            .Concat(string.IsNullOrEmpty(apexOrigin) ? Array.Empty<string>() : new[] { apexOrigin })
            .Distinct()
            .ToArray();
        if (origins.Length > 0)
        {
            policy.WithOrigins(origins);
        }
        else
        {
            // No regions configured (local dev / single-region). SetIsOriginAllowed
            // is compatible with AllowCredentials (unlike AllowAnyOrigin) and lets
            // dev setups (e.g. multiple instances on localhost ports) work.
            policy.SetIsOriginAllowed(_ => true);
        }
        policy.AllowAnyHeader();
        policy.AllowAnyMethod();
        policy.AllowCredentials();
    });
});


//
// Wire format optimization notes:
// - WebSocket per-message compression (permessage-deflate) is NOT available through
//   SignalR's API. SignalR manages WebSocket connections internally and does not expose
//   the DangerousEnableCompression flag from WebSocketAcceptContext. HTTP-level
//   compression is handled above via response compression middleware.
// - MessagePack protocol gives ~25-30% smaller payloads vs JSON.
//   Hub DTOs are annotated with [MessagePackObject] + [Key("camelCaseName")] so the
//   binary wire format uses camelCase property names, preserving the existing JS client
//   contract without any frontend changes.
//   ContractlessStandardResolver handles unannotated types (primitives, collections,
//   Dictionary<K,V>) and includes AttributeFormatterResolver for annotated DTOs.
//   UntrustedData security guard is enabled as recommended by the MessagePack docs.
builder.Services.AddSignalR(options =>
{
    // The 2× relationship (ClientTimeout = 2 × KeepAlive) is preserved so a single
    // missed keep-alive ping doesn't kill the connection.
    options.ClientTimeoutInterval = TimeSpan.FromSeconds(sessionSettings.ClientTimeoutSeconds);
    options.KeepAliveInterval = TimeSpan.FromSeconds(sessionSettings.KeepAliveSeconds);
}).AddMessagePackProtocol(options =>
{
    // BinaryGuidResolver is composed first so typed Guid/Guid? properties are serialized
    // as 16-byte binary instead of 36-char strings (~19 bytes saved per GUID on the wire).
    // ContractlessStandardResolver handles everything else: [MessagePackObject]/[Key] DTOs,
    // primitives, collections, Dictionary<K,V>. Collection formatters (e.g. IEnumerable<Guid>)
    // resolve element formatters through the composite root, so Guid elements also get
    // binary encoding. UntrustedData rejects malformed msgpack.
    var compositeResolver = CompositeResolver.Create(
        BinaryGuidResolver.Instance,
        ContractlessStandardResolver.Instance
    );
    options.SerializerOptions = MessagePackSerializerOptions.Standard
        .WithResolver(compositeResolver)
        .WithSecurity(MessagePackSecurity.UntrustedData);
});

var app = builder.Build();

// Regional endpoints registered FIRST so they respond the moment the HTTP listener
// is up — critical for cold-start RTT measurement. The endpoints have no startup
// dependencies (RegionSettings is bound at DI time, and /api/ping does no service
// work) so they can answer before SignalR initialisation completes.
//
// CORS must run before these endpoints so cross-origin preflights succeed.
app.UseCors("RegionalApi");

// GET /api/ping — minimal latency probe. The client measures RTT by timing the
// round trip; we return the server wall-clock so cold-start vs network-only RTT
// is observable in telemetry. Cache-Control: no-store so no proxy/CDN can ever
// short-circuit the round trip (which would lie about RTT).
app.MapGet("/api/ping", (HttpContext ctx) =>
{
    ctx.Response.Headers.CacheControl = "no-store";
    return Results.Ok(new { now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() });
}).RequireCors("RegionalApi");

// GET /api/regions — canonical region manifest. The client fetches this once
// from its landing region and uses the result to populate its peer-region list.
app.MapGet("/api/regions", (Microsoft.Extensions.Options.IOptions<RegionSettings> opts) =>
{
    var s = opts.Value;
    return Results.Ok(new
    {
        regionId = s.Id,
        displayName = s.DisplayName,
        regions = s.Regions.Select(r => new
        {
            id = r.Id,
            displayName = r.DisplayName,
            hostname = r.Hostname.TrimEnd('/'),
        }),
    });
}).RequireCors("RegionalApi");

app.UseResponseCompression();
app.UseDefaultFiles();

// Build a content-hash ETag table once at startup.
// SHA-256 of each file's bytes → first 16 bytes hex-encoded → stable ETag.
// Unlike ASP.NET Core's default mtime-derived ETag, this is unchanged across deploys
// when the file content hasn't changed (mtime is reset by `dotnet publish` / COPY).
var webRoot = app.Environment.WebRootPath;
var etags = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
if (!string.IsNullOrEmpty(webRoot) && Directory.Exists(webRoot))
{
    foreach (var filePath in Directory.EnumerateFiles(webRoot, "*", SearchOption.AllDirectories))
    {
        using var fs = File.OpenRead(filePath);
        var hash = SHA256.HashData(fs);
        var rel = "/" + Path.GetRelativePath(webRoot, filePath).Replace('\\', '/');
        etags[rel] = "\"" + Convert.ToHexString(hash, 0, 16).ToLowerInvariant() + "\"";
    }
}

// ETag + Cache-Control middleware.
// Placed after UseDefaultFiles (so "/" is already rewritten to "/index.html")
// and before UseStaticFiles (which serves the body on 200 responses).
// - Sets Cache-Control: no-cache so the browser revalidates on every launch.
// - Returns 304 when If-None-Match matches the content-hash ETag (no body transfer).
// - Non-static paths (SignalR, API) are not in the etags table and pass through unchanged.
app.Use(async (context, next) =>
{
    var method = context.Request.Method;
    if ((method == HttpMethods.Get || method == HttpMethods.Head)
        && etags.TryGetValue(context.Request.Path.Value ?? "", out var etag))
    {
        context.Response.Headers.ETag = etag;
        context.Response.Headers.CacheControl = "no-cache";

        var ifNoneMatch = context.Request.Headers.IfNoneMatch.ToString();
        if (!string.IsNullOrEmpty(ifNoneMatch))
        {
            // If-None-Match may contain a comma-separated list of ETags (RFC 9110 §13.1.2).
            // Return 304 if any supplied tag matches our content-hash ETag.
            var clientTags = ifNoneMatch.Split(',',
                StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (clientTags.Any(t => t == etag))
            {
                context.Response.StatusCode = StatusCodes.Status304NotModified;
                context.Response.Headers.Remove("Content-Type");
                return;
            }
        }
    }
    await next(context);
});

app.UseStaticFiles();

// Map SignalR hub. RequireCors so cross-origin spectator connections from
// peer regions can negotiate + open the WebSocket.
app.MapHub<SessionHub>("/sessionHub").RequireCors("RegionalApi");

// Server monitoring metrics API endpoint
app.MapGet("/api/srvmon", (ServerMetricsService metrics, ISessionService sessionService) =>
    Results.Ok(metrics.GetSnapshot(sessionService)));

// GET /api/sessions — REST mirror of SessionHub.GetActiveSessions, stamped with this
// region's id. The client polls this on every region (in parallel) to merge a unified
// session list across regions without needing a SignalR connection.
//
// regionId is sourced from SessionInfo.RegionId (stamped by SessionService at
// emit time), which matches the SessionListItem returned by the SignalR hub —
// guaranteeing both code paths agree on the owning region for every session.
app.MapGet("/api/sessions", (ISessionService sessionService,
    Microsoft.Extensions.Options.IOptions<RegionSettings> regionOpts) =>
{
    var result = sessionService.GetActiveSessions();
    return Results.Ok(new
    {
        regionId = regionOpts.Value.Id,
        sessions = result.Sessions.Select(s => new
        {
            id = s.Id,
            name = s.Name,
            memberCount = s.MemberCount,
            maxMembers = s.MaxMembers,
            createdAt = s.CreatedAt,
            regionId = s.RegionId,
        }),
        maxSessions = result.MaxSessions,
        canCreateSession = result.CanCreateSession,
    });
}).RequireCors("RegionalApi");

app.Run();

// Make Program accessible to integration tests (WebApplicationFactory<Program>).
public partial class Program { }
