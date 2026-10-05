namespace AstervoidsWeb.Configuration;

public sealed class IdentitySettings
{
    public const string SectionName = "Identity";

    public string Provider { get; set; } = "File";
    public string DataFile { get; set; } = Path.Combine("App_Data", "identity.json");
    public bool AllowFileInProduction { get; set; }
    public string TableEndpoint { get; set; } = "";
    public string TableName { get; set; } = "PlayerIdentity";
    public bool PromptOnRoot { get; set; } = true;
    public IdentityRateLimitSettings RateLimit { get; set; } = new();
}

public sealed class IdentityRateLimitSettings
{
    // These are per-instance limits, not distributed storage quotas.
    public int BrowserPermitLimit { get; set; } = 120;
    public int IpPermitLimit { get; set; } = 600;
    public int WindowSeconds { get; set; } = 60;
}
