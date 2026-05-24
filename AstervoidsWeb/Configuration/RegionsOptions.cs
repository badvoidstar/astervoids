namespace AstervoidsWeb.Configuration;

/// <summary>
/// Configuration for regional deployment.
/// </summary>
public class RegionsOptions
{
    public const string SectionName = "Regions";

    /// <summary>
    /// The region ID of this instance (e.g. "local", "westus2").
    /// </summary>
    public string Self { get; set; } = "local";

    /// <summary>
    /// All known regions. Each browser uses this list for RTT probing and display.
    /// </summary>
    public List<RegionEntry> All { get; set; } = new()
    {
        new RegionEntry { Id = "local", DisplayName = "Local", PublicUrl = "" }
    };
}

/// <summary>
/// Describes a single deployable region.
/// </summary>
public class RegionEntry
{
    /// <summary>Short stable identifier, e.g. "westus2".</summary>
    public string Id { get; set; } = "";

    /// <summary>Human-readable label shown in the UI.</summary>
    public string DisplayName { get; set; } = "";

    /// <summary>Base URL of the app instance for this region, e.g. "https://westus2.astervoids.example".</summary>
    public string PublicUrl { get; set; } = "";
}
