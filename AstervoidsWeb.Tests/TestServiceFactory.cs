using AstervoidsWeb.Configuration;
using AstervoidsWeb.Services;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace AstervoidsWeb.Tests;

internal static class TestServiceFactory
{
    internal static SessionService CreateSessionService(
        SessionSettings? settings = null,
        RegionSettings? regionSettings = null,
        ISessionNameGenerator? nameGenerator = null)
        => new(
            Options.Create(settings ?? new SessionSettings()),
            NullLogger<SessionService>.Instance,
            nameGenerator ?? new FruitNameGenerator(),
            Options.Create(regionSettings ?? new RegionSettings()));
}
