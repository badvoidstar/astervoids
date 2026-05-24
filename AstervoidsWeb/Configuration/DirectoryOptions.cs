namespace AstervoidsWeb.Configuration;

/// <summary>
/// Configuration for the session directory store.
/// </summary>
public class DirectoryOptions
{
    public const string SectionName = "Directory";

    /// <summary>
    /// "InMemory" (default) or "Cosmos".
    /// </summary>
    public string Provider { get; set; } = "InMemory";

    /// <summary>
    /// Cosmos DB settings; only used when <see cref="Provider"/> is "Cosmos".
    /// </summary>
    public CosmosDirectoryOptions Cosmos { get; set; } = new();
}

/// <summary>
/// Cosmos DB connection settings for the session directory.
/// </summary>
public class CosmosDirectoryOptions
{
    public string ConnectionString { get; set; } = "";
    public string DatabaseId { get; set; } = "astervoids";
    public string ContainerId { get; set; } = "sessions";
}
