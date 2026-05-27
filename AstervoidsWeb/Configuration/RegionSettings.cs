namespace AstervoidsWeb.Configuration;

/// <summary>
/// Configuration for regional deployment. Each container is stamped with its own
/// <see cref="Id"/> / <see cref="DisplayName"/> (typically via environment variables
/// <c>Region__Id</c> and <c>Region__DisplayName</c>), and ships a full <see cref="Regions"/>
/// manifest so any container can answer <c>GET /api/regions</c> with the canonical list
/// of peer regions a client should ping.
///
/// The client uses the manifest to:
///   1. Measure RTT to every region's <c>/api/ping</c> endpoint.
///   2. Open spectator SignalR connections to every region's <c>/sessionHub</c> while
///      the session picker is visible.
///   3. Route a Create call to the user's chosen region's hub.
///   4. Route a Join call to the session's owning region's hub.
/// </summary>
public class RegionSettings
{
    public const string SectionName = "Region";

    /// <summary>
    /// Stable id for this region (e.g. <c>westus2</c>). Stamped onto every
    /// <c>SessionInfo</c> emitted by this container so cross-region session lists
    /// can be merged unambiguously on the client.
    /// </summary>
    public string Id { get; set; } = "local";

    /// <summary>
    /// Human-readable name for this region (e.g. <c>US West</c>). Shown to the user
    /// in the session picker and in the "Your region" banner.
    /// </summary>
    public string DisplayName { get; set; } = "Local";

    /// <summary>
    /// Canonical manifest of all regions in the deployment. Every region ships the
    /// same manifest (via <c>appsettings.Production.json</c> or equivalent) so the
    /// client can fetch it once from any landing region and then fan out.
    /// </summary>
    public List<RegionEndpoint> Regions { get; set; } = new();
}

/// <summary>
/// A single region's externally reachable endpoint, as returned by <c>GET /api/regions</c>.
/// The client uses <see cref="Hostname"/> as the authority for both <c>/api/ping</c>
/// and <c>/sessionHub</c> when measuring RTT or opening a SignalR connection.
/// </summary>
public class RegionEndpoint
{
    /// <summary>
    /// Stable id of the region (matches <see cref="RegionSettings.Id"/> of the
    /// container serving that region). Used as the merge key on the client.
    /// </summary>
    public string Id { get; set; } = "";

    /// <summary>Human-readable name shown in the picker UI.</summary>
    public string DisplayName { get; set; } = "";

    /// <summary>
    /// Authority the client should use when fetching <c>/api/ping</c>, <c>/api/sessions</c>,
    /// and opening <c>/sessionHub</c> for this region. Includes scheme + host, e.g.
    /// <c>https://astervoids-westus2.example.com</c>. No trailing slash.
    /// </summary>
    public string Hostname { get; set; } = "";
}
