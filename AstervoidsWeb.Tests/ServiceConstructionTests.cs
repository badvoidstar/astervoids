using AstervoidsWeb.Configuration;
using AstervoidsWeb.Hubs;
using AstervoidsWeb.Models;
using AstervoidsWeb.Services;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Moq;

namespace AstervoidsWeb.Tests;

public class ServiceConstructionTests
{
    [Theory]
    [InlineData("parameterless")]
    [InlineData("name-generator")]
    [InlineData("options-without-region")]
    [InlineData("options-with-region")]
    public void SessionService_DefaultConstructors_UseSettingsDefaults(string constructor)
    {
        var defaults = new SessionSettings();
        var nameGenerator = new Mock<ISessionNameGenerator>();
        nameGenerator
            .Setup(generator => generator.GenerateUniqueName(It.IsAny<IReadOnlySet<string>>()))
            .Returns("Test session");
        var service = constructor switch
        {
            "parameterless" => new SessionService(),
            "name-generator" => new SessionService(nameGenerator.Object),
            "options-without-region" => new SessionService(
                Options.Create(defaults), NullLogger<SessionService>.Instance, nameGenerator.Object),
            _ => TestServiceFactory.CreateSessionService(nameGenerator: nameGenerator.Object)
        };

        service.MaxSessions.Should().Be(defaults.MaxSessions);
        service.MaxMembersPerSession.Should().Be(defaults.MaxMembersPerSession);
        var created = service.CreateSession("creator");
        created.Success.Should().BeTrue();
        service.GetActiveSessions().Sessions.Should().ContainSingle()
            .Which.RegionId.Should().Be(new RegionSettings().Id);
        if (constructor != "parameterless")
            created.Session!.Name.Should().Be("Test session");

        var objects = new ObjectService(service);
        var session = created.Session!;
        service.JoinSession(session.Id, "client-1").Success.Should().BeTrue();
        service.JoinSession(session.Id, "client-2").Success.Should().BeTrue();
        for (var i = 0; i < 4; i++)
            objects.CreateObject(session.Id, created.Creator!.Id, ObjectScope.Session)
                .Should().NotBeNull();

        var rejoin = service.RejoinSession(
            session.Id, "creator-reconnected", created.Creator!.Id, created.Creator.ReconnectToken);

        rejoin.Success.Should().BeTrue();
        rejoin.Eviction!.MigratedObjects.Should().HaveCount(4);
        objects.GetSessionObjects(session.Id).Select(obj => obj.OwnerMemberId).Distinct()
            .Should().HaveCount(defaults.DistributeOrphanedObjects ? 2 : 1);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void SessionService_ConfiguredConstructor_PreservesLimitsRegionAndDistribution(bool distribute)
    {
        var service = TestServiceFactory.CreateSessionService(
            new SessionSettings
            {
                MaxSessions = 1,
                MaxMembersPerSession = 3,
                DistributeOrphanedObjects = distribute
            },
            new RegionSettings { Id = "test-region" });
        var created = service.CreateSession("creator");
        var session = created.Session!;
        var objects = new ObjectService(service);

        service.CreateSession("another-creator").Success.Should().BeFalse();
        service.JoinSession(session.Id, "client-1").Success.Should().BeTrue();
        service.JoinSession(session.Id, "client-2").Success.Should().BeTrue();
        service.JoinSession(session.Id, "client-over-capacity").Success.Should().BeFalse();
        service.GetActiveSessions().Sessions.Should().ContainSingle()
            .Which.RegionId.Should().Be("test-region");
        for (var i = 0; i < 4; i++)
            objects.CreateObject(session.Id, created.Creator!.Id, ObjectScope.Session)
                .Should().NotBeNull();

        var rejoin = service.RejoinSession(
            session.Id, "creator-reconnected", created.Creator!.Id, created.Creator.ReconnectToken);

        rejoin.Success.Should().BeTrue();
        rejoin.Eviction!.MigratedObjects.Should().HaveCount(4);
        objects.GetSessionObjects(session.Id).Select(obj => obj.OwnerMemberId).Distinct()
            .Should().HaveCount(distribute ? 2 : 1);
    }

    [Theory]
    [InlineData(typeof(SessionHub))]
    [InlineData(typeof(SessionCleanupService))]
    public void DependencyInjection_RequiresOperationCoordinator(Type serviceType)
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSignalR();
        services.AddSingleton<ISessionNameGenerator, FruitNameGenerator>();
        services.AddSingleton<ISessionService, SessionService>();
        services.AddSingleton<IObjectService, ObjectService>();
        services.AddSingleton<ServerMetricsService>();
        services.AddSingleton<SyncSchemaRegistry>();
        using var provider = services.BuildServiceProvider();

        var create = () => ActivatorUtilities.CreateInstance(provider, serviceType);

        create.Should().Throw<InvalidOperationException>()
            .WithMessage("*ISessionOperationCoordinator*");
    }

    [Fact]
    public async Task ApplicationDependencyInjection_SharesCoordinatorAcrossHubsAndCleanup()
    {
        using var factory = new AstervoidsWebFactory().WithWebHostBuilder(builder =>
            builder.ConfigureServices(services =>
            {
                services.PostConfigure<SessionSettings>(settings =>
                {
                    settings.MaxSessions = 2;
                    settings.MaxMembersPerSession = 3;
                    settings.AbsoluteTimeoutMinutes = 0;
                });
                services.PostConfigure<RegionSettings>(settings => settings.Id = "test-region");
            }));
        var provider = factory.Services;
        var cleanup = provider.GetServices<IHostedService>().OfType<SessionCleanupService>().Single();
        await cleanup.StopAsync(CancellationToken.None);
        var service = provider.GetRequiredService<ISessionService>();
        service.MaxSessions.Should().Be(2);
        service.MaxMembersPerSession.Should().Be(3);
        var session = service.CreateSession("connection-1").Session!;
        service.JoinSession(session.Id, "connection-2").Success.Should().BeTrue();
        service.GetActiveSessions().Sessions.Should().ContainSingle()
            .Which.RegionId.Should().Be("test-region");

        using var firstScope = provider.CreateScope();
        using var secondScope = provider.CreateScope();
        var coordinator = provider.GetRequiredService<ISessionOperationCoordinator>();
        firstScope.ServiceProvider.GetRequiredService<ISessionOperationCoordinator>()
            .Should().BeSameAs(coordinator);
        secondScope.ServiceProvider.GetRequiredService<ISessionOperationCoordinator>()
            .Should().BeSameAs(coordinator);
        using var firstHub = firstScope.ServiceProvider.GetRequiredService<IHubActivator<SessionHub>>().Create();
        using var secondHub = secondScope.ServiceProvider.GetRequiredService<IHubActivator<SessionHub>>().Create();
        firstHub.Should().NotBeSameAs(secondHub);
        firstHub.Context = Mock.Of<HubCallerContext>(context => context.ConnectionId == "connection-1");
        secondHub.Context = Mock.Of<HubCallerContext>(context => context.ConnectionId == "connection-2");

        using var gate = await coordinator.EnterAsync(session.Id);
        var firstSnapshot = firstHub.GetSessionState();
        var secondSnapshot = secondHub.GetSessionState();
        var expiration = cleanup.CleanupExpiredSessions();
        try
        {
            firstSnapshot.IsCompleted.Should().BeFalse();
            secondSnapshot.IsCompleted.Should().BeFalse();
            expiration.IsCompleted.Should().BeFalse();
            service.GetSession(session.Id).Should().NotBeNull();
        }
        finally
        {
            gate.Dispose();
            await Task.WhenAll(firstSnapshot, secondSnapshot, expiration)
                .WaitAsync(TimeSpan.FromSeconds(5));
        }

        service.GetSession(session.Id).Should().BeNull();
    }
}
