using AstervoidsWeb.Services;
using FluentAssertions;

namespace AstervoidsWeb.Tests;

public class RegionSelectionServiceTests
{
    [Fact]
    public void SelectBestRegion_PicksLowestRttAmongCapacityEligibleRegions()
    {
        var selected = RegionSelectionService.SelectBestRegion(
        [
            new("westus2", 40, true),
            new("northeurope", 95, true),
            new("eastus2", 20, false)
        ],
        fallbackRegionId: "westus2");

        selected.Should().Be("westus2");
    }

    [Fact]
    public void SelectBestRegion_UsesPreferredRegion_WhenStillCapacityEligible()
    {
        var selected = RegionSelectionService.SelectBestRegion(
        [
            new("westus2", 30, true),
            new("northeurope", 15, true)
        ],
        preferredRegionId: "westus2",
        fallbackRegionId: "westus2");

        selected.Should().Be("westus2");
    }

    [Fact]
    public void SelectBestRegion_FallsBackToConfiguredRegion_WhenAllRegionsFull()
    {
        var selected = RegionSelectionService.SelectBestRegion(
        [
            new("westus2", 30, false),
            new("northeurope", 15, false)
        ],
        fallbackRegionId: "westus2");

        selected.Should().Be("westus2");
    }
}
