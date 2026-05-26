using System.IO;
using FluentAssertions;

namespace AstervoidsWeb.Tests;

public class FrontDoorRoutingPlanTests
{
    private static string LoadMainBicep()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        const int maxDepth = 16;
        for (var i = 0; i < maxDepth && dir != null; i++)
        {
            if (File.Exists(Path.Combine(dir.FullName, "infra", "main.bicep")))
                break;
            dir = dir.Parent;
        }

        dir.Should().NotBeNull();
        var path = Path.Combine(dir!.FullName, "infra", "main.bicep");
        File.Exists(path).Should().BeTrue();
        return File.ReadAllText(path);
    }

    [Fact]
    public void MainBicep_Defines_StaticOnlyFrontDoorToggle()
    {
        var text = LoadMainBicep();
        text.Should().Contain("param enableFrontDoorStaticOnly bool");
        text.Should().Contain("staticRoutePatterns");
    }

    [Fact]
    public void MainBicep_StaticRoutePatterns_DoNotIncludeRealtimeOrPingPaths()
    {
        var text = LoadMainBicep();
        text.Should().Contain("'/index.html'");
        text.Should().Contain("'/ops.html'");
        text.Should().NotContain("'/sessionHub'");
        text.Should().NotContain("'/api/ping'");
        text.Should().Contain("Do NOT broaden to '/api/*'");
        text.Should().Contain("'/api/*'");
        text.Should().Contain("'/sessionHub*'");
    }
}
