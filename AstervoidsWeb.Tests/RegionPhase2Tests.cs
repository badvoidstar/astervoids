using AstervoidsWeb.Configuration;
using AstervoidsWeb.Hubs;
using AstervoidsWeb.Models;
using AstervoidsWeb.Services;
using FluentAssertions;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Moq;

namespace AstervoidsWeb.Tests;

/// <summary>
/// Tests for the regional deployment features introduced in Phase 2.
/// </summary>
public class RegionPhase2Tests
{
    // ── Session.RegionId stamping ─────────────────────────────────────

    [Fact]
    public void CreateSession_StampsRegionId_FromRegionsOptions()
    {
        var regionsOptions = Options.Create(new RegionsOptions { Self = "westus2" });
        var sessionSettings = Options.Create(new SessionSettings());

        var service = new SessionService(
            sessionSettings,
            Mock.Of<ILogger<SessionService>>(),
            new FruitNameGenerator(),
            regionsOptions);

        var result = service.CreateSession("conn-1");

        result.Success.Should().BeTrue();
        result.Session!.RegionId.Should().Be("westus2");
    }

    [Fact]
    public void CreateSession_DefaultsRegionId_ToLocal_WhenNoRegionsOptions()
    {
        // The zero-arg constructor and the simple (nameGenerator) ctor both default to "local"
        var service = new SessionService();

        var result = service.CreateSession("conn-1");

        result.Success.Should().BeTrue();
        result.Session!.RegionId.Should().Be("local");
    }

    // ── GetActiveSessions includes RegionId ───────────────────────────

    [Fact]
    public void GetActiveSessions_IncludesRegionId()
    {
        var regionsOptions = Options.Create(new RegionsOptions { Self = "eastus" });
        var sessionSettings = Options.Create(new SessionSettings());

        var service = new SessionService(
            sessionSettings,
            Mock.Of<ILogger<SessionService>>(),
            new FruitNameGenerator(),
            regionsOptions);

        service.CreateSession("conn-1");

        var sessions = service.GetActiveSessions().Sessions.ToList();

        sessions.Should().ContainSingle();
        sessions[0].RegionId.Should().Be("eastus");
    }

    // ── SessionHub.GetActiveSessions union ────────────────────────────

    [Fact]
    public async Task GetActiveSessions_ReturnsLocalSessions_WithRegionId()
    {
        var directory = new InMemorySessionDirectory();
        var sessionService = new SessionService();
        var objectService = new ObjectService(sessionService);
        var hub = CreateHub(sessionService, objectService, directory, "conn-1");

        // Create a session via the hub
        var createResponse = await hub.CreateSession(null);
        createResponse.Should().NotBeNull();

        // GetActiveSessions should return the session with a regionId
        var response = await hub.GetActiveSessions();
        response.Sessions.Should().ContainSingle(s => s.RegionId == "local");
    }

    [Fact]
    public async Task GetActiveSessions_MergesDirectoryEntries()
    {
        var directory = new InMemorySessionDirectory();
        var sessionService = new SessionService();
        var objectService = new ObjectService(sessionService);
        var hub = CreateHub(sessionService, objectService, directory, "conn-1");

        // Seed a "remote" session in the directory
        var remoteId = Guid.NewGuid();
        var remoteEntry = new SessionDirectoryEntry(
            remoteId, "RemoteSession", "westus2", 2, 4, DateTime.UtcNow);
        await directory.UpsertAsync(remoteEntry);

        // Create a local session
        await hub.CreateSession(null);

        var response = await hub.GetActiveSessions();
        var sessions = response.Sessions.ToList();

        sessions.Should().HaveCount(2);
        sessions.Should().Contain(s => s.RegionId == "westus2" && s.Name == "RemoteSession");
        sessions.Should().Contain(s => s.RegionId == "local");
    }

    [Fact]
    public async Task GetActiveSessions_LocalSessionTakesPrecedenceOverDirectory()
    {
        var directory = new InMemorySessionDirectory();
        var sessionService = new SessionService();
        var objectService = new ObjectService(sessionService);
        var hub = CreateHub(sessionService, objectService, directory, "conn-1");

        // Create a local session
        var createResponse = await hub.CreateSession(null);
        var sessionId = createResponse!.SessionId;

        // Seed the same session in the directory with different data
        var directoryEntry = new SessionDirectoryEntry(
            sessionId, "WrongName", "wrongregion", 99, 4, DateTime.UtcNow);
        await directory.UpsertAsync(directoryEntry);

        var response = await hub.GetActiveSessions();
        var sessions = response.Sessions.ToList();

        // Local takes precedence
        sessions.Should().ContainSingle(s => s.Id == sessionId);
        var entry = sessions.Single(s => s.Id == sessionId);
        entry.RegionId.Should().Be("local");
        entry.Name.Should().NotBe("WrongName");
    }

    // ── SessionDirectoryMirror ─────────────────────────────────────────

    [Fact]
    public async Task SessionDirectoryMirror_BroadcastsOnSessionsChanged_OnDirectoryUpsert()
    {
        var directory = new InMemorySessionDirectory();

        string? broadcastMethod = null;
        var clientProxy = new Mock<IClientProxy>();
        clientProxy
            .Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Callback<string, object?[], CancellationToken>((method, _, _) => broadcastMethod = method)
            .Returns(Task.CompletedTask);

        var hubContext = new Mock<IHubContext<SessionHub>>();
        hubContext.Setup(h => h.Clients.Group(It.IsAny<string>())).Returns(clientProxy.Object);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var mirror = new SessionDirectoryMirror(
            directory,
            hubContext.Object,
            Mock.Of<ILogger<SessionDirectoryMirror>>());

        // Start the mirror
        var mirrorTask = mirror.StartAsync(cts.Token);
        await Task.Delay(50, CancellationToken.None);

        // Trigger a directory change
        await directory.UpsertAsync(new SessionDirectoryEntry(
            Guid.NewGuid(), "Test", "local", 1, 4, DateTime.UtcNow));

        // Wait briefly for the mirror to process and broadcast
        await Task.Delay(100, CancellationToken.None);

        cts.Cancel();
        try { await mirror.StopAsync(CancellationToken.None); } catch { }

        broadcastMethod.Should().Be("OnSessionsChanged");
    }

    // ── Helpers ──────────────────────────────────────────────────────

    private static SessionHub CreateHub(
        ISessionService sessionService,
        IObjectService objectService,
        ISessionDirectory directory,
        string connectionId)
    {
        var hub = new SessionHub(
            sessionService,
            objectService,
            Mock.Of<ILogger<SessionHub>>(),
            new ServerMetricsService(),
            new SyncSchemaRegistry(),
            directory);

        var context = new Mock<HubCallerContext>();
        context.SetupGet(c => c.ConnectionId).Returns(connectionId);
        hub.Context = context.Object;

        var clientProxy = new Mock<IClientProxy>();
        clientProxy
            .Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);

        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.OthersInGroup(It.IsAny<string>())).Returns(clientProxy.Object);
        clients.Setup(c => c.Group(It.IsAny<string>())).Returns(clientProxy.Object);
        hub.Clients = clients.Object;

        var groups = new Mock<IGroupManager>();
        groups.Setup(g => g.AddToGroupAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);
        groups.Setup(g => g.RemoveFromGroupAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);
        hub.Groups = groups.Object;

        return hub;
    }
}
