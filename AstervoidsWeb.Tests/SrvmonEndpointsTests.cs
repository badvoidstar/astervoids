using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using AstervoidsWeb.Services;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace AstervoidsWeb.Tests;

public class SrvmonEndpointsTests : IClassFixture<SrvmonEndpointsTests.Factory>
{
    public sealed class Factory : WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Regions:Self"] = "local",
                    ["Regions:All:0:Id"] = "local",
                    ["Regions:All:0:DisplayName"] = "Local",
                    ["Regions:All:0:PublicUrl"] = "",
                    ["Regions:All:1:Id"] = "westus2",
                    ["Regions:All:1:DisplayName"] = "West US 2",
                    ["Regions:All:1:PublicUrl"] = "https://healthy.region.test",
                    ["Regions:All:2:Id"] = "eastus2",
                    ["Regions:All:2:DisplayName"] = "East US 2",
                    ["Regions:All:2:PublicUrl"] = "https://down.region.test"
                });
            });

            builder.ConfigureTestServices(services =>
            {
                services.AddSingleton<StubSrvmonHandler>();
                services.AddHttpClient("SrvmonFanout")
                    .ConfigurePrimaryHttpMessageHandler(sp => sp.GetRequiredService<StubSrvmonHandler>());
            });
        }
    }

    private readonly Factory _factory;

    public SrvmonEndpointsTests(Factory factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task Srvmon_Includes_RegionId()
    {
        var client = _factory.CreateClient();
        var response = await client.GetAsync("/api/srvmon");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        json.RootElement.GetProperty("regionId").GetString().Should().Be("local");
    }

    [Fact]
    public async Task SrvmonAll_Aggregates_Reachable_And_Unreachable_Regions()
    {
        var client = _factory.CreateClient();
        var response = await client.GetAsync("/api/srvmon/all");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var regions = json.RootElement.GetProperty("regions");
        regions.GetArrayLength().Should().BeGreaterThanOrEqualTo(3);

        var local = regions.EnumerateArray().First(r => r.GetProperty("id").GetString() == "local");
        local.GetProperty("ok").GetBoolean().Should().BeTrue();
        local.GetProperty("metrics").GetProperty("regionId").GetString().Should().Be("local");

        var reachable = regions.EnumerateArray().First(r => r.GetProperty("id").GetString() == "westus2");
        reachable.GetProperty("ok").GetBoolean().Should().BeTrue();
        reachable.GetProperty("metrics").GetProperty("regionId").GetString().Should().Be("westus2");

        var unreachable = regions.EnumerateArray().First(r => r.GetProperty("id").GetString() == "eastus2");
        unreachable.GetProperty("ok").GetBoolean().Should().BeFalse();
        unreachable.GetProperty("error").GetString().Should().NotBeNullOrWhiteSpace();
    }

    [Fact]
    public async Task CapacityAll_Aggregates_Reachable_And_Unreachable_Regions()
    {
        var client = _factory.CreateClient();
        var response = await client.GetAsync("/api/capacity/all");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var regions = json.RootElement.GetProperty("regions");
        regions.GetArrayLength().Should().BeGreaterThanOrEqualTo(3);

        var local = regions.EnumerateArray().First(r => r.GetProperty("id").GetString() == "local");
        local.GetProperty("ok").GetBoolean().Should().BeTrue();
        local.GetProperty("capacity").GetProperty("regionId").GetString().Should().Be("local");

        var reachable = regions.EnumerateArray().First(r => r.GetProperty("id").GetString() == "westus2");
        reachable.GetProperty("ok").GetBoolean().Should().BeTrue();
        reachable.GetProperty("capacity").GetProperty("regionId").GetString().Should().Be("westus2");

        var unreachable = regions.EnumerateArray().First(r => r.GetProperty("id").GetString() == "eastus2");
        unreachable.GetProperty("ok").GetBoolean().Should().BeFalse();
    }

    [Fact]
    public async Task RegionRecommend_Picks_LowestRtt_Region_WithCapacity()
    {
        var client = _factory.CreateClient();
        var request = new
        {
            rttMsByRegion = new Dictionary<string, double?>
            {
                ["local"] = 90,
                ["westus2"] = 30,
                ["eastus2"] = 10
            },
            preferredRegionId = (string?)null
        };

        var response = await client.PostAsJsonAsync("/api/regions/recommend", request);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        json.RootElement.GetProperty("regionId").GetString().Should().Be("westus2");
    }

    private sealed class StubSrvmonHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.RequestUri?.Host == "healthy.region.test")
            {
                var payload = request.RequestUri?.AbsolutePath == "/api/capacity"
                    ? JsonSerializer.Serialize(new RegionCapacitySnapshot("westus2", 1, 6, true))
                    : JsonSerializer.Serialize(new ServerMetricsSnapshot(
                        RegionId: "westus2",
                        System: new SystemMetricsSnapshot(
                            UptimeSeconds: 1,
                            CpuUsagePercent: 12.3,
                            MemoryUsagePercent: 45.6,
                            MemoryWorkingSetBytes: 1000,
                            MemoryTotalBytes: 2000,
                            GcGen0: 1,
                            GcGen1: 1,
                            GcGen2: 1,
                            ThreadPoolWorkerAvailable: 10,
                            ThreadPoolIoAvailable: 10,
                            ThreadPoolWorkerMax: 100,
                            ThreadPoolIoMax: 100),
                        Connections: new ConnectionMetricsSnapshot(
                            CurrentConnections: 1,
                            PeakConnections: 2,
                            TotalHubInvocations: 3),
                        Sessions: []));

                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(payload, Encoding.UTF8, "application/json")
                });
            }

            throw new HttpRequestException("Simulated region unreachable");
        }
    }
}
