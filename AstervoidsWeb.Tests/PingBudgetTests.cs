using System.Diagnostics;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace AstervoidsWeb.Tests;

/// <summary>
/// Performance budget for the regional ping endpoint.
///
/// `/api/ping` is the latency-measurement primitive every visitor calls
/// every 5 seconds, per region, while the picker is visible. If it grows a
/// service dependency or starts allocating heavily, RTT measurements
/// become inflated (server-side work charged against network RTT) and the
/// picker would misrank regions.
///
/// This test pins a budget on the server-side handler time, measured under
/// the TestServer in-process transport (no real network — pure handler
/// time + framework overhead). A regression here means someone added work
/// to the handler that doesn't belong there.
///
/// Budget rationale: 5 ms is loose enough to absorb GC + ASP.NET routing
/// overhead on a slow CI runner but tight enough that adding a service
/// dependency (e.g. `metrics.Record()`) or a DI lookup would push it over.
/// </summary>
public class PingBudgetTests : IClassFixture<PingBudgetTests.Factory>
{
    public sealed class Factory : WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(IWebHostBuilder builder)
            => builder.UseContentRoot(FindContentRoot());

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
                $"Could not find AstervoidsWeb project directory. Searched from: {AppContext.BaseDirectory}");
        }
    }

    private readonly Factory _factory;
    public PingBudgetTests(Factory factory) => _factory = factory;

    [Fact]
    public async Task GetPing_MeanLatency_StaysWithinBudget()
    {
        var client = _factory.CreateClient();

        // Warm-up: first few requests pay JIT, type construction, DI graph
        // walks, and assembly load costs that aren't representative of
        // steady-state handler time. Discard them from the measurement.
        for (var i = 0; i < 10; i++)
        {
            (await client.GetAsync("/api/ping")).EnsureSuccessStatusCode();
        }

        const int Iterations = 200;
        var sw = Stopwatch.StartNew();
        for (var i = 0; i < Iterations; i++)
        {
            (await client.GetAsync("/api/ping")).EnsureSuccessStatusCode();
        }
        sw.Stop();

        var meanMs = sw.Elapsed.TotalMilliseconds / Iterations;
        meanMs.Should().BeLessThan(5.0,
            $"/api/ping must stay cheap — measured mean {meanMs:F2}ms over {Iterations} iterations. " +
            $"If this fires, something added work to the handler that shouldn't be there (service " +
            $"dependency, DI graph walk, allocation-heavy serialization). Revert or revisit the budget.");
    }

    [Fact]
    public async Task GetPing_ResponseShape_HasOnlyTheNowField()
    {
        // The handler must NOT inadvertently start serializing more data over
        // time. Locking the response keys prevents drift: any new field added
        // to the response is a deliberate, reviewed change.
        var client = _factory.CreateClient();
        var json = await client.GetStringAsync("/api/ping");

        json.Should().StartWith("{").And.EndWith("}");
        json.Should().Contain("\"now\":");
        // Tight assertion: the only key is `now`. If a future PR adds fields
        // (e.g. `region`, `version`), it must update this assertion explicitly.
        var keys = System.Text.Json.JsonDocument.Parse(json).RootElement
            .EnumerateObject().Select(p => p.Name).ToArray();
        keys.Should().BeEquivalentTo(new[] { "now" },
            "/api/ping body keys are part of the RTT-measurement contract — adding fields inflates payload size " +
            "and may push the response past a TCP segment boundary, hurting measured RTT on first-burst");
    }
}
