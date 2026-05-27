using System.IO;
using System.Text.RegularExpressions;
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
        var match = Regex.Match(text, @"var\s+staticRoutePatterns\s*=\s*\[(?<body>[\s\S]*?)\]", RegexOptions.Multiline);
        match.Success.Should().BeTrue("main.bicep should define staticRoutePatterns");

        var body = match.Groups["body"].Value;
        body.Should().Contain("'/index.html'");
        body.Should().Contain("'/ops.html'");
        body.Should().Contain("'/js/*'");
        body.Should().NotContain("'/sessionHub'");
        body.Should().NotContain("'/api/ping'");
    }
}
