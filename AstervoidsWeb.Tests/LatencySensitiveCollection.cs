namespace AstervoidsWeb.Tests;

/// <summary>
/// Groups tests that either measure wall-clock latency or impose real load, so xUnit
/// does not run them concurrently.
///
/// <para>
/// <see cref="PingBudgetTests"/> asserts a 5 ms mean handler time. That budget is about
/// the handler, but the measurement is wall-clock, so it is sensitive to anything heavy
/// running in parallel — for example <see cref="WebSocketCompressionTests"/>, which
/// starts real Kestrel listeners. Membership of this collection keeps the budget
/// meaningful instead of forcing it to be loosened to absorb unrelated test load.
/// </para>
/// </summary>
[CollectionDefinition(Name)]
public sealed class LatencySensitiveCollection
{
    public const string Name = "LatencySensitive";
}
