using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace AstervoidsWeb.Tests;

/// <summary>
/// Integration tests for the regional REST endpoints introduced in the regional
/// deployments work: <c>GET /api/ping</c>, <c>GET /api/regions</c>, and
/// <c>GET /api/sessions</c>. Boots a real TestServer that points at the
/// AstervoidsWeb project's wwwroot so the existing ETag middleware still finds
/// content to hash.
/// </summary>
public class RegionEndpointsTests : IClassFixture<RegionEndpointsTests.Factory>
{
    /// <summary>
    /// Custom factory that mirrors StaticFileCachingTests.Factory — points the
    /// content root at the AstervoidsWeb project so the wwwroot exists at start.
    /// Also overrides Region configuration so we test against a known manifest
    /// rather than whatever appsettings ships.
    /// </summary>
    public sealed class Factory : WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseContentRoot(FindContentRoot());

            // Inject a deterministic Region manifest so assertions don't depend
            // on whatever appsettings.json ships. The test manifest mimics a
            // 3-region deployment (one of which we are).
            builder.ConfigureAppConfiguration((_, cfg) =>
            {
                cfg.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Region:Id"] = "westus2",
                    ["Region:DisplayName"] = "US West",
                    ["Region:Regions:0:Id"] = "westus2",
                    ["Region:Regions:0:DisplayName"] = "US West",
                    ["Region:Regions:0:Hostname"] = "https://astervoids-westus2.example.com",
                    ["Region:Regions:1:Id"] = "eastus",
                    ["Region:Regions:1:DisplayName"] = "US East",
                    ["Region:Regions:1:Hostname"] = "https://astervoids-eastus.example.com/",
                    ["Region:Regions:2:Id"] = "westeurope",
                    ["Region:Regions:2:DisplayName"] = "Europe West",
                    ["Region:Regions:2:Hostname"] = "https://astervoids-westeurope.example.com",
                });
            });
        }

        private static string FindContentRoot()
        {
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir != null)
            {
                var candidate = Path.Combine(dir.FullName, "AstervoidsWeb");
                if (Directory.Exists(Path.Combine(candidate, "wwwroot")))
                    return candidate;
                dir = dir.Parent;
            }
            throw new DirectoryNotFoundException(
                "Could not find AstervoidsWeb project directory with wwwroot. " +
                $"Searched upward from: {AppContext.BaseDirectory}");
        }
    }

    private readonly Factory _factory;

    public RegionEndpointsTests(Factory factory) => _factory = factory;

    // -------------------------------------------------------------------------
    // /api/ping
    // -------------------------------------------------------------------------

    [Fact]
    public async Task GetPing_ReturnsOk_WithNowTimestamp()
    {
        var client = _factory.CreateClient();
        var response = await client.GetAsync("/api/ping");

        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        body.TryGetProperty("now", out var now).Should().BeTrue(
            "the client measures cold-start vs network-only RTT using the server's wall-clock");
        now.ValueKind.Should().Be(JsonValueKind.Number);

        var nowMs = now.GetInt64();
        var serverWallClockNowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        nowMs.Should().BeCloseTo(serverWallClockNowMs, 5_000,
            "server-returned timestamp should be within 5s of real wall-clock");
    }

    [Fact]
    public async Task GetPing_SetsCacheControlNoStore()
    {
        var client = _factory.CreateClient();
        var response = await client.GetAsync("/api/ping");

        // no-store is critical: if a CDN/proxy ever cached this it would lie
        // about RTT (returning instantly from cache instead of doing a round trip).
        response.Headers.CacheControl.Should().NotBeNull();
        response.Headers.CacheControl!.NoStore.Should().BeTrue();
    }

    // -------------------------------------------------------------------------
    // /api/regions
    // -------------------------------------------------------------------------

    [Fact]
    public async Task GetRegions_ReturnsLocalRegionAndManifest()
    {
        var client = _factory.CreateClient();
        var response = await client.GetAsync("/api/regions");

        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var body = await response.Content.ReadFromJsonAsync<JsonElement>();

        body.GetProperty("regionId").GetString().Should().Be("westus2",
            "the local container identifies itself so the client can pin its session affinity");
        body.GetProperty("displayName").GetString().Should().Be("US West");

        var regions = body.GetProperty("regions").EnumerateArray().ToList();
        regions.Should().HaveCount(3, "the test factory configures a 3-region manifest");

        regions[0].GetProperty("id").GetString().Should().Be("westus2");
        regions[0].GetProperty("hostname").GetString()
            .Should().Be("https://astervoids-westus2.example.com");

        // Trailing slash must be trimmed so the client can safely append paths
        // like /api/ping without producing a double-slash URL.
        regions[1].GetProperty("hostname").GetString()
            .Should().Be("https://astervoids-eastus.example.com",
                "trailing slash on configured hostnames must be normalised away");

        regions[2].GetProperty("displayName").GetString().Should().Be("Europe West");
    }

    [Fact]
    public async Task GetRegions_UsesCamelCasePropertyNames()
    {
        // The existing JS client (session-client.js, ObjectSync, etc.) expects
        // camelCase property names. Program.cs already configures the JSON
        // options for that — this test pins the contract.
        var client = _factory.CreateClient();
        var response = await client.GetAsync("/api/regions");
        var raw = await response.Content.ReadAsStringAsync();

        raw.Should().Contain("\"regionId\"").And.Contain("\"displayName\"")
            .And.Contain("\"regions\"").And.Contain("\"hostname\"");
        raw.Should().NotContain("\"RegionId\"").And.NotContain("\"DisplayName\"");
    }

    // -------------------------------------------------------------------------
    // /api/sessions
    // -------------------------------------------------------------------------

    [Fact]
    public async Task GetSessions_ReturnsEmptyListAndRegionIdStamp_WhenNoSessions()
    {
        var client = _factory.CreateClient();
        var response = await client.GetAsync("/api/sessions");

        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("regionId").GetString().Should().Be("westus2",
            "every cross-region session response is stamped with its origin region " +
            "so the client knows where to route a Join call");
        body.GetProperty("sessions").EnumerateArray().Should().BeEmpty();
        body.GetProperty("maxSessions").GetInt32().Should().Be(6);
        body.GetProperty("canCreateSession").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task GetSessions_StampsRegionIdOnEverySession()
    {
        var client = _factory.CreateClient();

        // Seed a session by reaching into the shared service instance.
        // We use the test factory's services rather than going through SignalR
        // because the assertion is about the REST endpoint's serialization shape,
        // not the hub's behaviour.
        using var scope = _factory.Services.CreateScope();
        var sessionService = scope.ServiceProvider
            .GetRequiredService<AstervoidsWeb.Services.ISessionService>();
        var created = sessionService.CreateSession("conn-region-stamp-test");
        created.Success.Should().BeTrue();

        try
        {
            var response = await client.GetAsync("/api/sessions");
            response.StatusCode.Should().Be(HttpStatusCode.OK);

            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            var sessions = body.GetProperty("sessions").EnumerateArray().ToList();
            sessions.Should().NotBeEmpty();
            sessions.Should().AllSatisfy(s =>
                s.GetProperty("regionId").GetString().Should().Be("westus2",
                    "every session in the REST list is stamped with the serving region"));
        }
        finally
        {
            // Clean up so this test doesn't pollute other tests sharing the factory.
            sessionService.LeaveSession("conn-region-stamp-test");
        }
    }

    // -------------------------------------------------------------------------
    // CORS
    // -------------------------------------------------------------------------

    [Theory]
    [InlineData("/api/ping")]
    [InlineData("/api/regions")]
    [InlineData("/api/sessions")]
    public async Task RegionalEndpoints_AllowCrossRegionOrigin(string path)
    {
        var client = _factory.CreateClient();

        var request = new HttpRequestMessage(HttpMethod.Get, path);
        // Simulate a cross-region GET originating from another configured region.
        request.Headers.Add("Origin", "https://astervoids-eastus.example.com");

        var response = await client.SendAsync(request);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Headers.GetValues("Access-Control-Allow-Origin")
            .Should().Contain("https://astervoids-eastus.example.com",
                "regional REST endpoints must echo the requesting region's origin so " +
                "the browser permits the cross-origin response");
    }

    [Theory]
    [InlineData("/api/ping")]
    [InlineData("/api/regions")]
    [InlineData("/api/sessions")]
    public async Task RegionalEndpoints_RejectUntrustedOrigin(string path)
    {
        var client = _factory.CreateClient();

        var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.Add("Origin", "https://evil.example.com");

        var response = await client.SendAsync(request);

        // The endpoint still returns 200 (CORS is enforced by the browser, not the
        // server, when origin isn't allowed), but it must NOT echo the bad origin
        // back as an Allow-Origin header.
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var allowOrigin = response.Headers
            .Where(h => string.Equals(h.Key, "Access-Control-Allow-Origin",
                StringComparison.OrdinalIgnoreCase))
            .SelectMany(h => h.Value)
            .ToList();
        allowOrigin.Should().NotContain("https://evil.example.com",
            "an unconfigured origin must not receive an Access-Control-Allow-Origin echo");
    }
}
