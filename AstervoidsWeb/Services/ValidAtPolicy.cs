namespace AstervoidsWeb.Services;

/// <summary>
/// Validates owner-stamped simulation times against the server receive time.
/// </summary>
public static class ValidAtPolicy
{
    public const long SanityBoundMs = 2000;

    public static long Resolve(
        long? clientValidAt,
        long serverReceiveTimeMs,
        long? previousValidAt = null)
    {
        var validAt = clientValidAt.HasValue
            && Math.Abs((decimal)clientValidAt.Value - serverReceiveTimeMs) <= SanityBoundMs
                ? clientValidAt.Value
                : serverReceiveTimeMs;

        return previousValidAt.HasValue && validAt < previousValidAt.Value
            ? previousValidAt.Value
            : validAt;
    }
}
