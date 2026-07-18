using AstervoidsWeb.Services;
using FluentAssertions;

namespace AstervoidsWeb.Tests;

public class ValidAtPolicyTests
{
    [Theory]
    [InlineData(-2000)]
    [InlineData(0)]
    [InlineData(2000)]
    public void Resolve_AcceptsInclusiveSanityWindow(long offset)
    {
        const long receivedAt = 1_000_000;

        ValidAtPolicy.Resolve(receivedAt + offset, receivedAt)
            .Should().Be(receivedAt + offset);
    }

    [Theory]
    [InlineData(-2001)]
    [InlineData(2001)]
    public void Resolve_RejectsValuesOutsideSanityWindow(long offset)
    {
        const long receivedAt = 1_000_000;

        ValidAtPolicy.Resolve(receivedAt + offset, receivedAt)
            .Should().Be(receivedAt);
    }

    [Fact]
    public void Resolve_UsesReceiveTimeForMissingClientValue()
    {
        ValidAtPolicy.Resolve(null, 1234).Should().Be(1234);
    }

    [Fact]
    public void Resolve_DoesNotMoveBehindPreviousObjectTime()
    {
        ValidAtPolicy.Resolve(1100, 1200, previousValidAt: 1150)
            .Should().Be(1150);
    }

    [Fact]
    public void Resolve_HandlesExtremeValuesWithoutOverflow()
    {
        var resolve = () => ValidAtPolicy.Resolve(long.MinValue, long.MaxValue);

        resolve.Should().NotThrow().Which.Should().Be(long.MaxValue);
    }
}
