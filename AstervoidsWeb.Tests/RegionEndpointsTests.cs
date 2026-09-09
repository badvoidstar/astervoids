using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AstervoidsWeb.Configuration;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
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
    private const string StaticOrigin = "https://example-static.azurestaticapps.net";

    public sealed class Factory : AstervoidsWebFactory
    {
        protected override void ConfigureAstervoidsWeb(IWebHostBuilder builder)
        {
            // Inject a deterministic Region manifest so assertions don't depend
            // on whatever appsettings.json ships. The test manifest mimics a
            // 3-region deployment (one of which we are).
            builder.ConfigureAppConfiguration((_, cfg) =>
            {
                cfg.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Region:Id"] = "westus2",
                    ["Region:DisplayName"] = "US West",
                    ["Region:ApexHostname"] = "https://astervoids.example.com",
                    ["Region:AdditionalAllowedOrigins:0"] = $"  {StaticOrigin}/  ",
                    ["Region:AdditionalAllowedOrigins:1"] = "",
                    ["Region:AdditionalAllowedOrigins:2"] = "   ",
                    ["Region:AdditionalAllowedOrigins:3"] = null,
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
    // /api/srvmon
    // -------------------------------------------------------------------------

    [Fact]
    public async Task GetServerMonitor_ReturnsMetricsSnapshot()
    {
        var client = _factory.CreateClient();
        var response = await client.GetAsync("/api/srvmon");

        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        body.TryGetProperty("system", out _).Should().BeTrue();
        body.TryGetProperty("connections", out _).Should().BeTrue();
        body.TryGetProperty("sessions", out _).Should().BeTrue();
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
    [InlineData("/api/srvmon")]
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
    [InlineData("/api/srvmon")]
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

    [Fact]
    public async Task ServerMonitor_AllowStaticApexOrigin()
    {
        var client = _factory.CreateClient();
        var request = new HttpRequestMessage(HttpMethod.Get, "/api/srvmon");
        request.Headers.Add("Origin", "https://astervoids.example.com");

        var response = await client.SendAsync(request);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Headers.GetValues("Access-Control-Allow-Origin")
            .Should().Contain("https://astervoids.example.com",
                "the static apex hosts srvmon in a multi-region deployment");
    }

    [Theory]
    [InlineData("/api/ping")]
    [InlineData("/api/regions")]
    [InlineData("/api/srvmon")]
    [InlineData("/api/sessions")]
    public async Task RegionalEndpoints_AllowConfiguredStaticOrigin(string path)
    {
        using var client = _factory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.Add("Origin", StaticOrigin);

        using var response = await client.SendAsync(request);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Headers.GetValues("Access-Control-Allow-Origin").Should().Equal(StaticOrigin);
        response.Headers.GetValues("Access-Control-Allow-Credentials").Should().Equal("true");
    }

    [Theory]
    [InlineData("/api/sessions", "GET", StaticOrigin)]
    [InlineData("/sessionHub/negotiate?negotiateVersion=1", "POST", StaticOrigin)]
    [InlineData("/sessionHub/negotiate?negotiateVersion=1", "POST", "https://astervoids.example.com")]
    public async Task RegionalApi_CredentialedPreflight_AllowsConfiguredOrigins(
        string path, string method, string origin)
    {
        using var client = _factory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Options, path);
        request.Headers.Add("Origin", origin);
        request.Headers.Add("Access-Control-Request-Method", method);
        request.Headers.Add("Access-Control-Request-Headers", "content-type,x-signalr-user-agent");

        using var response = await client.SendAsync(request);

        response.StatusCode.Should().Be(HttpStatusCode.NoContent);
        response.Headers.GetValues("Access-Control-Allow-Origin").Should().Equal(origin);
        response.Headers.GetValues("Access-Control-Allow-Credentials").Should().Equal("true");
        response.Headers.GetValues("Access-Control-Allow-Methods").Should().Contain(method);
        response.Headers.GetValues("Access-Control-Allow-Headers")
            .SelectMany(value => value.Split(',', StringSplitOptions.TrimEntries))
            .Should().Contain("content-type").And.Contain("x-signalr-user-agent");
    }

    [Theory]
    [InlineData(StaticOrigin)]
    [InlineData("https://astervoids.example.com")]
    [InlineData("https://astervoids-eastus.example.com")]
    public async Task SignalR_Negotiation_AllowsConfiguredOrigins(string origin)
    {
        using var client = _factory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Post, "/sessionHub/negotiate?negotiateVersion=1");
        request.Headers.Add("Origin", origin);

        using var response = await client.SendAsync(request);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Headers.GetValues("Access-Control-Allow-Origin").Should().Equal(origin);
        response.Headers.GetValues("Access-Control-Allow-Credentials").Should().Equal("true");
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("connectionToken").GetString().Should().NotBeNullOrEmpty();
        body.GetProperty("availableTransports").GetArrayLength().Should().BeGreaterThan(0);
    }

    [Theory]
    [InlineData("https://other-static.azurestaticapps.net")]
    [InlineData("https://other-app.azurecontainerapps.io")]
    [InlineData("https://nested.example-static.azurestaticapps.net")]
    [InlineData("http://example-static.azurestaticapps.net")]
    [InlineData("https://example-static.azurestaticapps.net:444")]
    public async Task RegionalApi_RejectsUnconfiguredAzureOrigins(string origin)
    {
        using var client = _factory.CreateClient();
        using var restRequest = new HttpRequestMessage(HttpMethod.Get, "/api/sessions");
        restRequest.Headers.Add("Origin", origin);
        using var restResponse = await client.SendAsync(restRequest);
        restResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        restResponse.Headers.Contains("Access-Control-Allow-Origin").Should().BeFalse();
        restResponse.Headers.Contains("Access-Control-Allow-Credentials").Should().BeFalse();

        using var preflight = new HttpRequestMessage(HttpMethod.Options, "/sessionHub/negotiate?negotiateVersion=1");
        preflight.Headers.Add("Origin", origin);
        preflight.Headers.Add("Access-Control-Request-Method", "POST");
        using var preflightResponse = await client.SendAsync(preflight);
        preflightResponse.StatusCode.Should().Be(HttpStatusCode.NoContent);
        preflightResponse.Headers.Contains("Access-Control-Allow-Origin").Should().BeFalse();
        preflightResponse.Headers.Contains("Access-Control-Allow-Credentials").Should().BeFalse();

        using var negotiate = new HttpRequestMessage(HttpMethod.Post, "/sessionHub/negotiate?negotiateVersion=1");
        negotiate.Headers.Add("Origin", origin);
        using var negotiateResponse = await client.SendAsync(negotiate);
        negotiateResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        negotiateResponse.Headers.Contains("Access-Control-Allow-Origin").Should().BeFalse();
        negotiateResponse.Headers.Contains("Access-Control-Allow-Credentials").Should().BeFalse();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task LocalCors_WithoutConfiguredOrigins_PreservesCredentialedDevelopmentRequests(bool blankAdditionalOrigins)
    {
        new RegionSettings().AdditionalAllowedOrigins.Should().BeEmpty();
        using var factory = new AstervoidsWebFactory().WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) =>
            {
                if (blankAdditionalOrigins)
                    config.AddInMemoryCollection(new Dictionary<string, string?>
                    {
                        ["Region:AdditionalAllowedOrigins:0"] = "   ",
                        ["Region:AdditionalAllowedOrigins:1"] = "/"
                    });
            }));
        using var client = factory.CreateClient();
        const string origin = "http://localhost:5001";
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/sessions");
        request.Headers.Add("Origin", origin);
        using var response = await client.SendAsync(request);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Headers.GetValues("Access-Control-Allow-Origin").Should().Equal(origin);
        response.Headers.GetValues("Access-Control-Allow-Credentials").Should().Equal("true");

        using var preflight = new HttpRequestMessage(HttpMethod.Options, "/sessionHub/negotiate?negotiateVersion=1");
        preflight.Headers.Add("Origin", origin);
        preflight.Headers.Add("Access-Control-Request-Method", "POST");
        using var preflightResponse = await client.SendAsync(preflight);
        preflightResponse.StatusCode.Should().Be(HttpStatusCode.NoContent);
        preflightResponse.Headers.GetValues("Access-Control-Allow-Origin").Should().Equal(origin);
        preflightResponse.Headers.GetValues("Access-Control-Allow-Credentials").Should().Equal("true");
    }

    [Theory]
    [InlineData("Region:AdditionalAllowedOrigins:0", StaticOrigin)]
    [InlineData("Region:Regions:0:Hostname", "https://example-app.azurecontainerapps.io")]
    public async Task SingleRegionCors_WithManifestOrAdditionalOrigin_UsesExactAllowList(
        string configurationKey, string origin)
    {
        using var factory = new AstervoidsWebFactory().WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) =>
                config.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    [configurationKey] = origin
                })));
        using var client = factory.CreateClient();
        using var allowed = new HttpRequestMessage(HttpMethod.Get, "/api/sessions");
        allowed.Headers.Add("Origin", origin);
        using var allowedResponse = await client.SendAsync(allowed);
        allowedResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        allowedResponse.Headers.GetValues("Access-Control-Allow-Origin").Should().Equal(origin);
        allowedResponse.Headers.GetValues("Access-Control-Allow-Credentials").Should().Equal("true");

        using var rejected = new HttpRequestMessage(HttpMethod.Get, "/api/sessions");
        rejected.Headers.Add("Origin", "https://other-static.azurestaticapps.net");
        using var rejectedResponse = await client.SendAsync(rejected);
        rejectedResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        rejectedResponse.Headers.Contains("Access-Control-Allow-Origin").Should().BeFalse();
        rejectedResponse.Headers.Contains("Access-Control-Allow-Credentials").Should().BeFalse();
    }
}
