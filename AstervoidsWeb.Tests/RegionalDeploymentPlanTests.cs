using System.IO;
using System.Linq;
using System.Text.Json;
using FluentAssertions;

namespace AstervoidsWeb.Tests;

/// <summary>
/// Locks the regional deployment plan in <c>infra/main.parameters.json</c>: every region
/// declared here is intended to scale to zero on idle (no active SignalR connections),
/// and Dublin/Ireland coverage requires a <c>northeurope</c> entry.
///
/// If you intentionally change the multi-region layout, update these assertions in the
/// same commit and call it out in the PR description so the operational guarantees stay
/// explicit.
/// </summary>
public class RegionalDeploymentPlanTests
{
    private static JsonElement LoadRegionsArray()
    {
        // Walk up from the test binary directory to the repo root, then read the parameters
        // file. Cap depth to avoid pathological loops in containerised/odd CWDs.
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        const int maxDepth = 16;
        for (var i = 0; i < maxDepth && dir != null; i++)
        {
            if (File.Exists(Path.Combine(dir.FullName, "infra", "main.parameters.json")))
            {
                break;
            }
            dir = dir.Parent;
        }
        dir.Should().NotBeNull(
            $"infra/main.parameters.json must be reachable within {maxDepth} parents of the test working directory");
        var path = Path.Combine(dir!.FullName, "infra", "main.parameters.json");
        File.Exists(path).Should().BeTrue($"expected file at {path}");

        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        var regions = doc.RootElement
            .GetProperty("parameters")
            .GetProperty("regions")
            .GetProperty("value")
            .Clone();
        return regions;
    }

    [Fact]
    public void ParametersFile_DeclaresMultipleRegions()
    {
        var regions = LoadRegionsArray();
        regions.GetArrayLength().Should().BeGreaterThanOrEqualTo(2,
            "multi-region deployment must declare at least two regions");
    }

    [Fact]
    public void ParametersFile_ContainsExactlyOnePrimaryRegion()
    {
        var regions = LoadRegionsArray();
        var primaries = regions.EnumerateArray()
            .Where(r => r.TryGetProperty("isPrimary", out var p) && p.GetBoolean())
            .ToList();
        primaries.Should().HaveCount(1, "exactly one region must be marked isPrimary:true");
    }

    [Fact]
    public void ParametersFile_IncludesNorthEuropeForDublinCoverage()
    {
        var regions = LoadRegionsArray();
        var northEurope = regions.EnumerateArray()
            .FirstOrDefault(r => r.TryGetProperty("id", out var id) && id.GetString() == "northeurope");
        northEurope.ValueKind.Should().NotBe(JsonValueKind.Undefined,
            "northeurope (Dublin, Ireland) must be in the regional deployment plan");
        northEurope.GetProperty("location").GetString().Should().Be("northeurope");
    }

    [Fact]
    public void ParametersFile_EveryRegionScalesToZeroByDefault()
    {
        // Scale-to-zero is the cost-saving guarantee: when no SignalR connections are active
        // in a region, KEDA's http-rule + cpu-rule will both report zero load and the
        // replica count will collapse to minReplicas. minReplicas:0 keeps that property.
        var regions = LoadRegionsArray();
        foreach (var region in regions.EnumerateArray())
        {
            var id = region.GetProperty("id").GetString();
            region.TryGetProperty("minReplicas", out var minReplicas).Should().BeTrue(
                $"region '{id}' must declare minReplicas explicitly");
            minReplicas.GetInt32().Should().Be(0,
                $"region '{id}' must keep minReplicas:0 to preserve scale-to-zero when idle");
        }
    }
}
