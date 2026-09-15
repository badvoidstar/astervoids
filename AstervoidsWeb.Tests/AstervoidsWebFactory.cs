using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace AstervoidsWeb.Tests;

public class AstervoidsWebFactory : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseContentRoot(FindContentRoot());

        // Brotli quality 11 over wwwroot costs ~1.4s of CPU. The suite starts many
        // hosts, so leaving it on means paying that repeatedly on background threads,
        // which perturbs wall-clock assertions elsewhere (see PingBudgetTests).
        // Nothing is lost: responses still compress via UseResponseCompression, and
        // the cache itself is covered directly by StaticAssetCompressionTests.
        builder.ConfigureAppConfiguration((_, cfg) =>
            cfg.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["StaticAssets:Precompress"] = "false"
            }));

        ConfigureAstervoidsWeb(builder);
    }

    protected virtual void ConfigureAstervoidsWeb(IWebHostBuilder builder)
    {
    }

    private static string FindContentRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null)
        {
            var candidate = Path.Combine(directory.FullName, "AstervoidsWeb");
            if (Directory.Exists(Path.Combine(candidate, "wwwroot")))
                return candidate;
            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException(
            "Could not find the AstervoidsWeb project directory with wwwroot. " +
            $"Searched upward from: {AppContext.BaseDirectory}");
    }
}
