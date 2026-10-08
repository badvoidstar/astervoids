using AstervoidsWeb.Configuration;
using Azure.Data.Tables;
using Azure.Identity;

namespace AstervoidsWeb.Identity;

internal static class IdentityTableClient
{
    public static TableClient? Create(IdentitySettings settings)
    {
        if (!string.Equals(settings.Provider, "AzureTable", StringComparison.OrdinalIgnoreCase)
            || !Uri.TryCreate(settings.TableEndpoint, UriKind.Absolute, out var endpoint)
            || endpoint.Scheme != Uri.UriSchemeHttps
            || endpoint.AbsolutePath != "/" || !string.IsNullOrEmpty(endpoint.Query)
            || !string.IsNullOrEmpty(endpoint.Fragment) || !string.IsNullOrEmpty(endpoint.UserInfo)
            || !IsTableName(settings.TableName))
            return null;

        var clientOptions = new TableClientOptions();
        clientOptions.Diagnostics.IsLoggingEnabled = false;
        clientOptions.Diagnostics.IsLoggingContentEnabled = false;
        clientOptions.Diagnostics.IsDistributedTracingEnabled = false;
        clientOptions.Retry.MaxRetries = 2;
        clientOptions.Retry.Delay = TimeSpan.FromMilliseconds(200);
        clientOptions.Retry.MaxDelay = TimeSpan.FromSeconds(1);
        clientOptions.Retry.NetworkTimeout = TimeSpan.FromSeconds(10);
        var credential = new DefaultAzureCredential(new DefaultAzureCredentialOptions
        {
            Diagnostics = { IsLoggingEnabled = false, IsLoggingContentEnabled = false }
        });
        return new TableClient(endpoint, settings.TableName, credential, clientOptions);
    }

    private static bool IsTableName(string? name) => name is { Length: >= 3 and <= 63 }
        && char.IsAsciiLetter(name[0]) && name.All(char.IsAsciiLetterOrDigit);
}
