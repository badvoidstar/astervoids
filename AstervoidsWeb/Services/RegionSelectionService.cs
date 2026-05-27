namespace AstervoidsWeb.Services;

public record RegionSelectionCandidate(
    string RegionId,
    double? RttMs,
    bool CanCreateSession
);

public static class RegionSelectionService
{
    public static string SelectBestRegion(
        IEnumerable<RegionSelectionCandidate> candidates,
        string? preferredRegionId = null,
        string? fallbackRegionId = null)
    {
        var list = candidates.ToList();
        if (list.Count == 0)
            return fallbackRegionId ?? "local";

        if (!string.IsNullOrWhiteSpace(preferredRegionId))
        {
            var preferred = list.FirstOrDefault(c =>
                string.Equals(c.RegionId, preferredRegionId, StringComparison.OrdinalIgnoreCase)
                && c.CanCreateSession);
            if (preferred is not null)
                return preferred.RegionId;
        }

        var available = list
            .Where(c => c.CanCreateSession)
            .OrderBy(c => c.RttMs.HasValue ? 0 : 1)
            .ThenBy(c => c.RttMs ?? double.MaxValue)
            .ThenBy(c => c.RegionId, StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault();

        if (available is not null)
            return available.RegionId;

        if (!string.IsNullOrWhiteSpace(fallbackRegionId))
        {
            var fallback = list.FirstOrDefault(c =>
                string.Equals(c.RegionId, fallbackRegionId, StringComparison.OrdinalIgnoreCase));
            if (fallback is not null)
                return fallback.RegionId;
        }

        return list
            .OrderBy(c => c.RttMs.HasValue ? 0 : 1)
            .ThenBy(c => c.RttMs ?? double.MaxValue)
            .ThenBy(c => c.RegionId, StringComparer.OrdinalIgnoreCase)
            .First()
            .RegionId;
    }
}
