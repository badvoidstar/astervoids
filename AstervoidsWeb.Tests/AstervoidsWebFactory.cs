using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace AstervoidsWeb.Tests;

public class AstervoidsWebFactory : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseContentRoot(FindContentRoot());
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
