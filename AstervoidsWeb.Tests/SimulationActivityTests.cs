using AstervoidsWeb.Hubs;
using AstervoidsWeb.Models;
using AstervoidsWeb.Services;
using FluentAssertions;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;
using Moq;

namespace AstervoidsWeb.Tests;

public class SimulationActivityTests
{
    private readonly SessionService _sessions = TestServiceFactory.CreateSessionService();

    [Fact]
    public void InactiveOwner_TransfersOnlySessionScope_WithCanonicalData()
    {
        var created = _sessions.CreateSession("owner");
        var session = created.Session!;
        var owner = created.Creator!;
        var other = _sessions.JoinSession(session.Id, "other").Member!;
        var objects = new ObjectService(_sessions);
        var canonical = new Dictionary<string, object?> { ["opaque"] = new object?[] { 3, "anchor" } };
        var shared = objects.CreateObject(session.Id, owner.Id, ObjectScope.Session, canonical)!;
        var personal = objects.CreateObject(session.Id, owner.Id, ObjectScope.Member, canonical)!;

        var result = _sessions.SetSimulationActive("owner", false)!;

        owner.Role.Should().Be(MemberRole.Server);
        owner.SimulationActive.Should().BeFalse();
        result.SimulationSuspended.Should().BeFalse();
        result.MigratedObjects.Should().ContainSingle(m =>
            m.ObjectId == shared.Id && m.NewOwnerId == other.Id && m.ValidAt == shared.ValidAt);
        result.MigratedObjects.Single().HandoffAt.Should().BeGreaterThan(0);
        var transfer = result.Objects.Single(o => o.Id == shared.Id);
        transfer.CreatorMemberId.Should().Be(owner.Id);
        transfer.Data.Should().BeEquivalentTo(canonical);
        objects.GetObject(session.Id, personal.Id)!.OwnerMemberId.Should().Be(owner.Id);
        transfer.Data["opaque"] = null;
        objects.GetObject(session.Id, shared.Id)!.Data.Should().BeEquivalentTo(canonical);
    }

    [Fact]
    public void AllInactive_Suspends_ThenResumesWithoutOldWallTime()
    {
        var created = _sessions.CreateSession("owner");
        var session = created.Session!;
        var other = _sessions.JoinSession(session.Id, "other").Member!;
        var objects = new ObjectService(_sessions);
        var shared = objects.CreateObject(session.Id, created.Creator!.Id, ObjectScope.Session,
            new() { ["sampleAt"] = 123L, ["opaque"] = "unchanged" },
            clientValidAt: 1000, serverReceiveTimeMs: 1000)!;
        _sessions.SetSimulationActive("owner", false);
        var suspended = _sessions.SetSimulationActive("other", false)!;
        var pausedObject = suspended.Objects.Single(o => o.Id == shared.Id);

        var resumed = _sessions.SetSimulationActive("owner", true)!;
        var resumedObject = resumed.Objects.Single(o => o.Id == shared.Id);

        suspended.SimulationSuspended.Should().BeTrue();
        pausedObject.ValidAt.Should().BeGreaterThan(1000);
        resumed.SimulationSuspended.Should().BeFalse();
        resumed.SimulationRevision.Should().BeGreaterThan(suspended.SimulationRevision);
        resumedObject.OwnerMemberId.Should().Be(created.Creator.Id);
        resumedObject.ValidAt.Should().BeGreaterThanOrEqualTo(pausedObject.ValidAt);
        resumedObject.Version.Should().BeGreaterThan(pausedObject.Version);
        resumedObject.SimulationAnchorReset.Should().BeTrue();
        resumedObject.Data.Should().BeEquivalentTo(shared.Data);
        other.SimulationActive.Should().BeFalse();
        objects.UpdateObjects(session.Id, created.Creator.Id, [new(shared.Id, new() { ["opaque"] = "new" })]);
        objects.GetObject(session.Id, shared.Id)!.SimulationAnchorReset.Should().BeFalse();
    }

    [Fact]
    public void HiddenJoinAndRejoin_DoNotWakeSuspendedSession()
    {
        var created = _sessions.CreateSession("owner", simulationActive: false);
        var session = created.Session!;
        var objects = new ObjectService(_sessions);
        var shared = objects.CreateObject(session.Id, created.Creator!.Id, ObjectScope.Session)!;
        var joined = _sessions.JoinSession(session.Id, "hidden", simulationActive: false);
        joined.Session!.SimulationSuspended.Should().BeTrue();
        joined.Member!.SimulationActive.Should().BeFalse();
        objects.GetObject(session.Id, shared.Id)!.OwnerMemberId.Should().Be(created.Creator.Id);

        var rejoined = _sessions.RejoinSession(session.Id, "hidden-new",
            joined.Member.Id, joined.Member.ReconnectToken, simulationActive: false);
        rejoined.Session!.SimulationSuspended.Should().BeTrue();
        rejoined.Member!.SimulationActive.Should().BeFalse();

        var visible = _sessions.JoinSession(session.Id, "visible");
        visible.Session!.SimulationSuspended.Should().BeFalse();
        objects.GetObject(session.Id, shared.Id)!.OwnerMemberId.Should().Be(visible.Member!.Id);
    }

    [Fact]
    public void Departure_PrefersActiveOwners_AndLastActiveDepartureSuspends()
    {
        var created = _sessions.CreateSession("owner");
        var session = created.Session!;
        _sessions.JoinSession(session.Id, "hidden", simulationActive: false);
        var active = _sessions.JoinSession(session.Id, "active").Member!;
        var objects = new ObjectService(_sessions);
        var shared = objects.CreateObject(session.Id, created.Creator!.Id, ObjectScope.Session)!;

        _sessions.LeaveSession("owner");
        objects.GetObject(session.Id, shared.Id)!.OwnerMemberId.Should().Be(active.Id);
        var departure = _sessions.LeaveSession("active")!;
        departure.SimulationActivity!.SimulationSuspended.Should().BeTrue();
        session.SimulationSuspended.Should().BeTrue();
    }

    [Fact]
    public void OldInactiveOwner_CannotUpdateDeleteOrReplaceAfterTransfer()
    {
        var created = _sessions.CreateSession("owner");
        var session = created.Session!;
        var owner = created.Creator!;
        var active = _sessions.JoinSession(session.Id, "active").Member!;
        var objects = new ObjectService(_sessions);
        var shared = objects.CreateObject(session.Id, owner.Id, ObjectScope.Session, new() { ["value"] = 1 })!;
        var personal = objects.CreateObject(session.Id, owner.Id, ObjectScope.Member)!;
        _sessions.SetSimulationActive("owner", false);

        objects.UpdateObjects(session.Id, owner.Id,
            [new(shared.Id, new() { ["value"] = 2 }), new(personal.Id, new() { ["value"] = 2 })])
            .Should().BeEmpty();
        objects.DeleteObject(session.Id, shared.Id, owner.Id).Should().BeNull();
        objects.DeleteObject(session.Id, personal.Id, owner.Id).Should().BeNull();
        objects.ReplaceObject(session.Id, shared.Id, owner.Id, []).Should().BeNull();
        objects.GetObject(session.Id, shared.Id)!.OwnerMemberId.Should().Be(active.Id);
        objects.GetObject(session.Id, shared.Id)!.Data["value"].Should().Be(1);
        objects.GetObject(session.Id, personal.Id).Should().NotBeNull();
        _sessions.LeaveSession("owner");
        _sessions.SetSimulationActive("owner", true).Should().BeNull();
    }

    [Fact]
    public void ActivityRetriesAreIdempotent_AndMemberObjectsResumeWithTheirOwner()
    {
        var created = _sessions.CreateSession("owner");
        var objects = new ObjectService(_sessions);
        var personal = objects.CreateObject(created.Session!.Id, created.Creator!.Id, ObjectScope.Member)!;
        var hidden = _sessions.SetSimulationActive("owner", false)!;
        var duplicate = _sessions.SetSimulationActive("owner", false)!;
        duplicate.SimulationRevision.Should().Be(hidden.SimulationRevision);
        duplicate.Objects.Should().BeEmpty();
        var resumed = _sessions.SetSimulationActive("owner", true)!;
        resumed.MigratedObjects.Should().BeEmpty();
        resumed.Objects.Should().ContainSingle(o =>
            o.Id == personal.Id && o.OwnerMemberId == created.Creator.Id && o.SimulationAnchorReset);
    }

    [Fact]
    public async Task TransferAndOldOwnerDelete_AreAtomic()
    {
        for (var i = 0; i < 32; i++)
        {
            var sessions = TestServiceFactory.CreateSessionService();
            var created = sessions.CreateSession("owner");
            var session = created.Session!;
            var active = sessions.JoinSession(session.Id, "active").Member!;
            var objects = new ObjectService(sessions);
            var shared = objects.CreateObject(session.Id, created.Creator!.Id, ObjectScope.Session)!;
            SessionObject? deleted = null;
            await Task.WhenAll(
                Task.Run(() => sessions.SetSimulationActive("owner", false)),
                Task.Run(() => deleted = objects.DeleteObject(session.Id, shared.Id, created.Creator.Id)));
            var remaining = objects.GetObject(session.Id, shared.Id);
            if (deleted == null) remaining!.OwnerMemberId.Should().Be(active.Id);
            else remaining.Should().BeNull();
        }
    }

    [Fact]
    public async Task Hub_ActivityDeliveryCannotBeOvertakenByNewOwnerMutation()
    {
        var created = _sessions.CreateSession("owner");
        var session = created.Session!;
        var other = _sessions.JoinSession(session.Id, "other").Member!;
        var objects = new ObjectService(_sessions);
        var shared = objects.CreateObject(session.Id, created.Creator!.Id, ObjectScope.Session)!;
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var proxy = new Mock<IClientProxy>();
        proxy.Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Returns(async (string method, object?[] _, CancellationToken _) =>
            {
                if (method == "OnSimulationActivityChanged")
                {
                    entered.TrySetResult();
                    await release.Task;
                }
            });
        using var metrics = new ServerMetricsService();
        var coordinator = new SessionOperationCoordinator();
        var ownerHub = CreateHub("owner", proxy.Object, objects, metrics, coordinator);
        var otherHub = CreateHub("other", proxy.Object, objects, metrics, coordinator);
        var activity = ownerHub.SetSimulationActive(false);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var deletion = otherHub.DeleteObject(shared.Id);
        deletion.IsCompleted.Should().BeFalse();
        objects.GetObject(session.Id, shared.Id)!.OwnerMemberId.Should().Be(other.Id);
        release.SetResult();

        var info = await activity;
        info!.Objects.Should().ContainSingle(o => o.Id == shared.Id);
        (await deletion)!.Success.Should().BeTrue();
    }

    [Fact]
    public async Task Hub_SnapshotsPreserveResetAnchorsWithoutChangingPositionalObjects()
    {
        var created = _sessions.CreateSession("owner");
        var objects = new ObjectService(_sessions);
        var shared = objects.CreateObject(created.Session!.Id, created.Creator!.Id,
            ObjectScope.Session, new() { ["opaque"] = 1 })!;
        _sessions.SetSimulationActive("owner", false);
        var proxy = new Mock<IClientProxy>();
        proxy.Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);
        using var metrics = new ServerMetricsService();
        var coordinator = new SessionOperationCoordinator();
        var hub = CreateHub("owner", proxy.Object, objects, metrics, coordinator);

        var snapshot = await hub.GetSessionState();
        snapshot!.SimulationSuspended.Should().BeTrue();
        snapshot.ResetObjectIds.Should().Contain(shared.Id);
        snapshot.Members.Should().ContainSingle(m => !m.SimulationActive);
        var wire = MessagePack.MessagePackSerializer.Serialize(snapshot);
        var roundTrip = MessagePack.MessagePackSerializer.Deserialize<SessionStateSnapshot>(wire);
        roundTrip.ResetObjectIds.Should().Contain(shared.Id);

        var joining = CreateHub("visible", proxy.Object, objects, metrics, coordinator);
        var joined = await joining.JoinSession(created.Session.Id);
        joined!.SimulationSuspended.Should().BeFalse();
        joined.ResetObjectIds.Should().Contain(shared.Id);
        joined.Objects.Should().ContainSingle(o => o.OwnerMemberId == joined.MemberId);
    }

    [Fact]
    public async Task Hub_InactiveMemberCannotEmitObjectEventsEvenForRetainedMemberObjects()
    {
        var created = _sessions.CreateSession("owner");
        var objects = new ObjectService(_sessions);
        var personal = objects.CreateObject(created.Session!.Id, created.Creator!.Id, ObjectScope.Member)!;
        _sessions.SetSimulationActive("owner", false);
        using var metrics = new ServerMetricsService();
        var hub = CreateHub("owner", Mock.Of<IClientProxy>(), objects, metrics, new SessionOperationCoordinator());

        (await hub.BroadcastObjectEvent(personal.Id, 1, [1, 2])).Should().BeFalse();
        created.Creator.EventSequence.Should().Be(0);
    }

    private SessionHub CreateHub(string connection, IClientProxy proxy, ObjectService objects,
        ServerMetricsService metrics, SessionOperationCoordinator coordinator)
    {
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.Group(It.IsAny<string>())).Returns(proxy);
        clients.Setup(c => c.OthersInGroup(It.IsAny<string>())).Returns(proxy);
        var context = new Mock<HubCallerContext>();
        context.SetupGet(c => c.ConnectionId).Returns(connection);
        return new SessionHub(_sessions, objects, Mock.Of<ILogger<SessionHub>>(),
            metrics, new SyncSchemaRegistry(), coordinator)
        {
            Context = context.Object,
            Clients = clients.Object,
            Groups = Mock.Of<IGroupManager>()
        };
    }
}
