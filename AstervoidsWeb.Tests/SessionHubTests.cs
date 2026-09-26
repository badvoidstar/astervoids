using AstervoidsWeb.Hubs;
using AstervoidsWeb.Models;
using AstervoidsWeb.Services;
using FluentAssertions;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;
using Moq;

namespace AstervoidsWeb.Tests;

public class SessionHubTests
{
    private readonly SessionService _sessionService = TestServiceFactory.CreateSessionService();
    private readonly ObjectService _objectService;
    private readonly SessionOperationCoordinator _operationCoordinator = new();
    private readonly SyncSchemaRegistry _schemaRegistry = new();

    public SessionHubTests()
    {
        _objectService = new ObjectService(_sessionService);
    }

    [Fact]
    public void Constructor_NullCoordinator_IsRejected()
    {
        using var metrics = new ServerMetricsService();
        var create = () => new SessionHub(
            _sessionService, _objectService, Mock.Of<ILogger<SessionHub>>(),
            metrics, _schemaRegistry, null!);

        create.Should().Throw<ArgumentNullException>()
            .WithParameterName("operationCoordinator");
    }

    [Fact]
    public async Task JoinSession_ShouldReturnMaterializedSessionSnapshot()
    {
        // Arrange
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        var creator = createResult.Creator!;
        var createdObject = _objectService.CreateObject(
            session.Id,
            creator.Id,
            Models.ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" });

        var hub = CreateHub("connection-2");

        // Act
        var response = await hub.JoinSession(session.Id);

        // Assert
        response.Should().NotBeNull();
        response!.Members.Should().BeOfType<MemberInfo[]>();
        response.Objects.Should().BeOfType<ObjectInfo[]>();
        response.Members.Should().HaveCount(2);
        response.Objects.Should().ContainSingle(o => o.Id == createdObject!.Id);
        response.ReconnectToken.Should().Be(
            _sessionService.GetMemberByConnectionId("connection-2")!.ReconnectToken);
    }

    [Fact]
    public async Task GetSessionState_ShouldReturnMaterializedSnapshot()
    {
        // Arrange
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        var creator = createResult.Creator!;
        var client = _sessionService.JoinSession(session.Id, "connection-2").Member!;
        var createdObject = _objectService.CreateObject(
            session.Id,
            creator.Id,
            Models.ObjectScope.Member,
            new Dictionary<string, object?> { ["type"] = "bullet" },
            ownerMemberId: client.Id);

        var hub = CreateHub("connection-1");

        // Act
        var snapshot = await hub.GetSessionState();

        // Assert
        snapshot.Should().NotBeNull();
        snapshot!.Members.Should().BeOfType<MemberInfo[]>();
        snapshot.Objects.Should().BeOfType<ObjectInfo[]>();
        snapshot.Members.Should().HaveCount(2);
        snapshot.Objects.Should().ContainSingle(o => o.Id == createdObject!.Id);
        snapshot.MemberSequences.Should().Contain(p => p.Id == creator.Id);
        snapshot.MemberSequences.Should().Contain(p => p.Id == client.Id);
    }

    /// <summary>
    /// Verifies that the snapshot is captured AFTER AddToGroupAsync so that any
    /// concurrent broadcast during the group-add window is delivered to the joiner
    /// (in-group) and the snapshot reflects the now-current state.
    ///
    /// The reverse order would leave a window where a broadcast is sent to the group
    /// before the new connection is in it — the joiner would never receive it, and
    /// the snapshot would carry an older view of the affected object. Sticky update
    /// content (e.g. pendingHit flags that don't repeat in subsequent updates) would
    /// be lost permanently. The client deduplicates by version in handleSessionJoined
    /// and handleRemoteObjectsUpdated, so any double-delivery is harmless.
    /// </summary>
    [Fact]
    public async Task JoinSession_AddsToGroupBeforeSnapshot_ConcurrentObjectIncludedInSnapshot()
    {
        // Arrange
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        var creator = createResult.Creator!;

        var preJoinObject = _objectService.CreateObject(
            session.Id, creator.Id, Models.ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" });

        Guid? concurrentObjectId = null;

        // When AddToGroupAsync fires, simulate another client creating an object.
        // With correct ordering (AddToGroup first, then snapshot), this object MUST
        // appear in the join response because the snapshot is captured after the add.
        var groups = new Mock<IGroupManager>();
        groups
            .Setup(g => g.AddToGroupAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .Callback<string, string, CancellationToken>((_, _, _) =>
            {
                var concurrent = _objectService.CreateObject(
                    session.Id, creator.Id, Models.ObjectScope.Session,
                    new Dictionary<string, object?> { ["type"] = "concurrent-asteroid" });
                concurrentObjectId = concurrent?.Id;
            })
            .Returns(Task.CompletedTask);

        var hub = CreateHub("connection-2", groups);

        // Act
        var response = await hub.JoinSession(session.Id);

        // Assert
        response.Should().NotBeNull();
        response!.Members.Should().HaveCount(2);
        concurrentObjectId.Should().NotBeNull("concurrent object should have been created during AddToGroupAsync");

        // Pre-join object must be in the snapshot
        response.Objects.Should().Contain(o => o.Id == preJoinObject!.Id,
            "objects that existed before the join must appear in the snapshot");

        // Concurrent object MUST be in the snapshot — snapshot is taken after AddToGroup,
        // so the joiner sees the up-to-date state. Any duplicate live broadcast is
        // deduplicated client-side via version comparison.
        response.Objects.Should().Contain(o => o.Id == concurrentObjectId,
            "snapshot taken after AddToGroupAsync must reflect concurrent state changes");
    }

    [Fact]
    public async Task JoinSession_SnapshotIncludesJoiningMember()
    {
        // Arrange
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        var hub = CreateHub("connection-2");

        // Act
        var response = await hub.JoinSession(session.Id);

        // Assert — the joiner's own member record must appear in the snapshot because
        // SessionService.JoinSession() adds them to session.Members before returning,
        // so the snapshot taken immediately after always reflects the full post-join membership.
        response.Should().NotBeNull();
        response!.Members.Should().HaveCount(2, "snapshot must include both the creator and the joiner");
        response.Members.Should().Contain(m => m.Role == MemberRole.Client,
            "the joining member should appear as Client in the snapshot");
    }

    [Fact]
    public async Task CreateSession_GroupRegistrationFailure_RollsBackMembership()
    {
        var groups = new Mock<IGroupManager>();
        groups
            .Setup(g => g.AddToGroupAsync(
                It.IsAny<string>(),
                It.IsAny<string>(),
                It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("group unavailable"));
        var hub = CreateHub("connection-new", groups);

        var act = () => hub.CreateSession();

        await act.Should().ThrowAsync<InvalidOperationException>();
        _sessionService.GetAllSessions().Should().BeEmpty();
        _sessionService.GetMemberByConnectionId("connection-new").Should().BeNull();
    }

    [Fact]
    public async Task CreateSession_DuplicateSchemaIds_ReturnsNormalRejectionWithoutPublishingSession()
    {
        var hub = CreateHub("connection-new");
        var metadata = new Dictionary<string, object?>
        {
            ["schemas"] = new object[]
            {
                new Dictionary<string, object?>
                {
                    ["id"] = 1,
                    ["fields"] = new object[] { new object[] { "x", "f64" } }
                },
                new Dictionary<string, object?>
                {
                    ["id"] = 1,
                    ["fields"] = new object[] { new object[] { "y", "f64" } }
                }
            }
        };

        (await hub.CreateSession(metadata)).Should().BeNull();

        _sessionService.GetAllSessions().Should().BeEmpty();
        _sessionService.GetMemberByConnectionId("connection-new").Should().BeNull();
    }

    [Fact]
    public async Task CreateSession_RegistersSchemasBeforePublishingSession()
    {
        var registry = new SyncSchemaRegistry();
        var sessionService = new Mock<ISessionService>();
        var schemaWasPublished = false;
        var publishedSessionId = Guid.Empty;
        sessionService
            .Setup(service => service.CreateSession(
                "connection-new",
                It.IsAny<Dictionary<string, object?>?>(),
                It.IsAny<Guid?>()))
            .Returns((
                string _,
                Dictionary<string, object?>? _,
                Guid? sessionId) =>
            {
                publishedSessionId = sessionId!.Value;
                schemaWasPublished =
                    registry.GetSchema(publishedSessionId, 1) != null;
                return new CreateSessionResult(
                    false, null, null, "expected test failure");
            });
        var hub = new SessionHub(
            sessionService.Object,
            Mock.Of<IObjectService>(),
            Mock.Of<ILogger<SessionHub>>(),
            new ServerMetricsService(),
            registry,
            _operationCoordinator);
        var context = new Mock<HubCallerContext>();
        context.SetupGet(value => value.ConnectionId)
            .Returns("connection-new");
        hub.Context = context.Object;
        var metadata = new Dictionary<string, object?>
        {
            ["schemas"] = new object?[]
            {
                new Dictionary<string, object?>
                {
                    ["id"] = 1,
                    ["fields"] = new object?[]
                    {
                        new object?[] { "x", "f64" }
                    }
                }
            }
        };

        var response = await hub.CreateSession(metadata);

        response.Should().BeNull();
        schemaWasPublished.Should().BeTrue();
        registry.HasAnySchemas(publishedSessionId).Should().BeFalse();
    }

    [Fact]
    public async Task JoinSession_GroupRegistrationFailure_RollsBackMembership()
    {
        var session = _sessionService.CreateSession("connection-old").Session!;
        var groups = new Mock<IGroupManager>();
        groups
            .Setup(g => g.AddToGroupAsync(
                It.IsAny<string>(),
                It.IsAny<string>(),
                It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("group unavailable"));
        var hub = CreateHub("connection-new", groups);

        var act = () => hub.JoinSession(session.Id);

        await act.Should().ThrowAsync<InvalidOperationException>();
        session.Members.Should().ContainSingle();
        _sessionService.GetMemberByConnectionId("connection-new").Should().BeNull();
    }

    [Fact]
    public async Task JoinSession_MemberBroadcastFailure_RollsBackMembership()
    {
        var session = _sessionService.CreateSession("connection-old").Session!;
        var proxy = new Mock<IClientProxy>();
        proxy
            .Setup(p => p.SendCoreAsync(
                It.IsAny<string>(),
                It.IsAny<object?[]>(),
                It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("broadcast unavailable"));
        var hub = CreateHubWithProxy("connection-new", proxy);

        var act = () => hub.JoinSession(session.Id);

        await act.Should().ThrowAsync<InvalidOperationException>();
        session.Members.Should().ContainSingle();
        _sessionService.GetMemberByConnectionId("connection-new").Should().BeNull();
    }

    [Fact]
    public void Ping_ShouldReturnUtcMillisecondsCloseToNow()
    {
        // Arrange — Ping requires no session membership, but the existing
        // CreateHub helper sets up a connection context. Just call directly.
        var hub = CreateHub("connection-ping");
        var before = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        // Act
        var result = hub.Ping();

        // Assert
        var after = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        result.Should().BeGreaterThanOrEqualTo(before);
        result.Should().BeLessThanOrEqualTo(after);
    }

    [Fact]
    public void Ping_ShouldSucceedWithoutSessionMembership()
    {
        // Arrange — fresh hub with no session, no member.
        var hub = CreateHub("connection-no-session");

        // Act + Assert — does not throw, returns a positive UTC ms value.
        var act = () => hub.Ping();
        var result = act.Should().NotThrow().Which;
        result.Should().BeGreaterThan(0);
    }

    [Fact]
    public async Task BroadcastObjectEvent_RelaysOpaqueBytesFromCurrentOwner()
    {
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        var creator = createResult.Creator!;
        var owned = _objectService.CreateObject(
            session.Id,
            creator.Id,
            ObjectScope.Member,
            new Dictionary<string, object?> { ["type"] = "ship" })!;
        object?[]? capturedArgs = null;
        var proxy = new Mock<IClientProxy>();
        proxy
            .Setup(p => p.SendCoreAsync(
                "OnObjectEvent",
                It.IsAny<object?[]>(),
                It.IsAny<CancellationToken>()))
            .Callback<string, object?[], CancellationToken>((_, args, _) =>
                capturedArgs = args)
            .Returns(Task.CompletedTask);
        var hub = CreateHubWithProxy("connection-1", proxy);
        var payload = new byte[] { 0x82, 0xa2, 0x73, 0x63, 0x64, 0xa2, 0x68, 0x63, 0x02 };
        var clientValidAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        var result = await hub.BroadcastObjectEvent(
            owned.Id, 1, payload, clientValidAt);

        result.Should().BeTrue();
        capturedArgs.Should().NotBeNull();
        capturedArgs!.Length.Should().Be(5);
        var eventInfo = capturedArgs[0].Should().BeOfType<ObjectEventInfo>().Subject;
        eventInfo.ObjectId.Should().Be(owned.Id);
        eventInfo.EventKind.Should().Be(1);
        eventInfo.Payload.Should().Equal(payload);
        eventInfo.Payload.Should().NotBeSameAs(payload);
        capturedArgs[4].Should().Be(clientValidAt);
    }

    private SessionHub CreateHub(
        string connectionId,
        Mock<IGroupManager>? groupsMock = null,
        Mock<IClientProxy>? clientProxyMock = null)
    {
        var hub = new SessionHub(
            _sessionService,
            _objectService,
            Mock.Of<ILogger<SessionHub>>(),
            new ServerMetricsService(),
            _schemaRegistry,
            _operationCoordinator);

        var context = new Mock<HubCallerContext>();
        context.SetupGet(c => c.ConnectionId).Returns(connectionId);
        hub.Context = context.Object;

        var clientProxy = clientProxyMock ?? new Mock<IClientProxy>();
        if (clientProxyMock == null)
        {
            clientProxy
                .Setup(p => p.SendCoreAsync(
                    It.IsAny<string>(),
                    It.IsAny<object?[]>(),
                    It.IsAny<CancellationToken>()))
                .Returns(Task.CompletedTask);
        }

        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.OthersInGroup(It.IsAny<string>())).Returns(clientProxy.Object);
        clients.Setup(c => c.Group(It.IsAny<string>())).Returns(clientProxy.Object);
        hub.Clients = clients.Object;

        var groups = groupsMock ?? new Mock<IGroupManager>();
        if (groupsMock == null)
        {
            groups
                .Setup(g => g.AddToGroupAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
                .Returns(Task.CompletedTask);
            groups
                .Setup(g => g.RemoveFromGroupAsync(
                    It.IsAny<string>(),
                    It.IsAny<string>(),
                    It.IsAny<CancellationToken>()))
                .Returns(Task.CompletedTask);
        }
        hub.Groups = groups.Object;

        return hub;
    }

    /// <summary>
    /// Verifies the eviction broadcast in JoinSession runs BEFORE AddToGroupAsync
    /// for the new connection. This ordering ensures the joiner does not receive
    /// an OnMemberLeft event for a member they never saw join. The order is:
    /// 1. EvictMemberInternal removes stale member
    /// 2. RemoveFromGroupAsync drops stale connection
    /// 3. SendAsync OnMemberLeft to group (joiner not yet in group)
    /// 4. AddToGroupAsync adds new joiner
    /// 5. ToSessionSnapshot captures state
    /// </summary>
    [Fact]
    public async Task JoinSession_WithEviction_BroadcastsEvictionBeforeAddingJoinerToGroup()
    {
        // Arrange: existing member that will be evicted (simulating stale reconnect)
        var createResult = _sessionService.CreateSession("connection-old");
        var session = createResult.Session!;
        var staleMember = createResult.Creator!;

        var callOrder = new List<string>();
        var groups = new Mock<IGroupManager>();
        groups
            .Setup(g => g.AddToGroupAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .Callback<string, string, CancellationToken>((conn, _, _) => callOrder.Add($"add:{conn}"))
            .Returns(Task.CompletedTask);
        groups
            .Setup(g => g.RemoveFromGroupAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .Callback<string, string, CancellationToken>((conn, _, _) => callOrder.Add($"remove:{conn}"))
            .Returns(Task.CompletedTask);

        var clientProxy = new Mock<IClientProxy>();
        clientProxy
            .Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Callback<string, object?[], CancellationToken>((method, _, _) => callOrder.Add($"send:{method}"))
            .Returns(Task.CompletedTask);

        var hub = CreateHub("connection-new", groups, clientProxy);

        // Act: join with eviction
        var response = await hub.RejoinSession(
            session.Id, staleMember.Id, staleMember.ReconnectToken);

        // Assert
        response.Should().NotBeNull();
        var evictRemoveIdx = callOrder.IndexOf("remove:connection-old");
        var evictBroadcastIdx = callOrder.IndexOf("send:OnMemberLeft");
        var addNewJoinerIdx = callOrder.IndexOf("add:connection-new");

        evictRemoveIdx.Should().BeGreaterThanOrEqualTo(0, "stale connection must be removed from group");
        evictBroadcastIdx.Should().BeGreaterThanOrEqualTo(0, "eviction OnMemberLeft must be broadcast");
        addNewJoinerIdx.Should().BeGreaterThanOrEqualTo(0, "new joiner must be added to group");

        evictBroadcastIdx.Should().BeLessThan(addNewJoinerIdx,
            "eviction broadcast must complete before new joiner is added to group");
    }

    /// <summary>
    /// Verifies AddToGroupAsync for the new joiner happens BEFORE the snapshot is
    /// captured, so any concurrent broadcast in the gap is delivered to the joiner
    /// (in-group) and the snapshot reflects current state. The reverse order would
    /// cause sticky update content (e.g. pendingHit flags) to be lost.
    /// </summary>
    [Fact]
    public async Task JoinSession_AddsToGroupBeforeCapturingSnapshot()
    {
        // Arrange
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;

        var addToGroupCalled = false;
        var snapshotCapturedAfterAdd = false;

        var groups = new Mock<IGroupManager>();
        groups
            .Setup(g => g.AddToGroupAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .Callback<string, string, CancellationToken>((_, _, _) =>
            {
                addToGroupCalled = true;
                // Mutate session state mid-add: snapshot taken AFTER must include this
                _objectService.CreateObject(session.Id, createResult.Creator!.Id,
                    Models.ObjectScope.Session,
                    new Dictionary<string, object?> { ["type"] = "post-add" });
            })
            .Returns(Task.CompletedTask);
        groups
            .Setup(g => g.RemoveFromGroupAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);

        var hub = CreateHub("connection-2", groups);

        // Act
        var response = await hub.JoinSession(session.Id);

        // Assert
        response.Should().NotBeNull();
        addToGroupCalled.Should().BeTrue();
        snapshotCapturedAfterAdd = response!.Objects.Any(o =>
        {
            var inner = SyncPayloadCodec.DecodeDict(o.Data);
            return inner.TryGetValue("type", out var t) && (t as string) == "post-add";
        });
        snapshotCapturedAfterAdd.Should().BeTrue(
            "snapshot must be captured after AddToGroupAsync to include concurrent state changes");
    }

    /// <summary>
    /// Regression: BroadcastToOthersAsync / BroadcastToAllAsync MUST use SendCoreAsync,
    /// not SendAsync. SendAsync has no params object?[] overload, so SendAsync(method, args)
    /// would resolve to SendAsync(string, object?) and wrap the entire args array as a
    /// single client argument — clients expect multiple positional args (e.g.
    /// OnObjectCreated(objectInfo, memberId, sequence, timestamp) → 4 args). This test
    /// verifies CreateObject's broadcast spreads its args correctly.
    /// </summary>
    [Fact]
    public async Task CreateObject_BroadcastsArgsAsMultiplePositionalArguments()
    {
        // Arrange
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;

        object?[]? capturedArgs = null;
        string? capturedMethod = null;

        var clientProxy = new Mock<IClientProxy>();
        clientProxy
            .Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Callback<string, object?[], CancellationToken>((m, a, _) =>
            {
                capturedMethod = m;
                capturedArgs = a;
            })
            .Returns(Task.CompletedTask);

        var hub = CreateHub("connection-1", clientProxyMock: clientProxy);

        // Act
        var response = await hub.CreateObject(
            SyncPayloadCodec.EncodeDict(new Dictionary<string, object?> { ["type"] = "asteroid" }), "Session");

        // Assert
        response.Should().NotBeNull();
        capturedMethod.Should().Be("OnObjectCreated");
        capturedArgs.Should().NotBeNull();
        // OnObjectCreated(objectInfo, memberId, memberSequence, serverTimestamp, validAt) = 5 args.
        // validAt is a single batch-level trailing argument.
        // If SendAsync wrapping bug regresses, this will be 1 (an object?[] of length 5).
        capturedArgs!.Length.Should().Be(5,
            "broadcast helpers must spread args via SendCoreAsync, not wrap them through SendAsync(string, object?)");
    }

    /// <summary>
    /// Owner-stamped validAt (unified server-time interpolation axis): ReplaceObject
    /// should accept an optional clientValidAt and stamp it on each child's
    /// ObjectInfo.ValidAt when within ±2s of the server's hub-entry timestamp.
    /// </summary>
    [Fact]
    public async Task ReplaceObject_ShouldUseClientValidAt_WhenWithinSanityBounds()
    {
        // Arrange — create a session and an object owned by the connecting member.
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        var creator = createResult.Creator!;
        _sessionService.JoinSession(session.Id, "connection-2");
        var parent = _objectService.CreateObject(
            session.Id, creator.Id, Models.ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" })!;

        object?[]? capturedArgs = null;
        var clientProxy = new Mock<IClientProxy>();
        clientProxy
            .Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Callback<string, object?[], CancellationToken>((_, a, _) => capturedArgs = a)
            .Returns(Task.CompletedTask);

        var hub = CreateHubWithProxy("connection-1", clientProxy);

        // clientValidAt within sanity bounds AND newer than the parent's stored
        // ValidAt (which the monotonic cap protects against regression).
        var hubEntry = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var clientStamp = hubEntry + 100;

        // Act
        var result = await hub.ReplaceObject(parent.Id,
            new List<SyncPayload>
            {
                SyncPayloadCodec.EncodeDict(new Dictionary<string, object?> { ["type"] = "asteroid" })
            },
            scope: "Session",
            ownerMemberId: null,
            clientValidAt: clientStamp);

        // Assert — broadcast carries 5 args: replaceEvent, memberId, memberSeq, serverTimestamp, validAt.
        result.Should().NotBeNull();
        capturedArgs.Should().NotBeNull();
        capturedArgs!.Length.Should().Be(5,
            "OnObjectReplaced broadcast must include serverTimestamp (hub-entry, for recordPacketArrival) and a single batch-level validAt trailing argument");
        var replaceEvent = (ObjectReplacedEvent)capturedArgs[0]!;
        replaceEvent.CreatedObjects.Should().NotBeEmpty();
        var batchValidAt = (long)capturedArgs[4]!;
        batchValidAt.Should().Be(clientStamp,
            "in-bounds clientValidAt should be forwarded verbatim as the batch-level validAt");
        result!.CreatedObjects.Should().Equal(replaceEvent.CreatedObjects);
        result.MemberSequence.Should().Be((long)capturedArgs[2]!);
        result.ValidAt.Should().Be(batchValidAt);
        Mock.Get(hub.Clients).Verify(
            clients => clients.OthersInGroup(session.Id.ToString()), Times.Once);
        Mock.Get(hub.Clients).Verify(
            clients => clients.Group(It.IsAny<string>()), Times.Never);
    }

    [Fact]
    public async Task ReplaceObject_ShouldFallBackToServerTimestamp_WhenClientStampOutOfBounds()
    {
        // Arrange
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        var creator = createResult.Creator!;
        _sessionService.JoinSession(session.Id, "connection-2");
        var parent = _objectService.CreateObject(
            session.Id, creator.Id, Models.ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" })!;

        object?[]? capturedArgs = null;
        var clientProxy = new Mock<IClientProxy>();
        clientProxy
            .Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Callback<string, object?[], CancellationToken>((_, a, _) => capturedArgs = a)
            .Returns(Task.CompletedTask);

        var hub = CreateHubWithProxy("connection-1", clientProxy);

        // Wildly out-of-bounds: 10s in the past (would mean 10s clock skew, far above 2s tolerance).
        var hubEntryEstimate = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var clientStamp = hubEntryEstimate - 10_000;

        // Act
        var result = await hub.ReplaceObject(parent.Id,
            new List<SyncPayload>
            {
                SyncPayloadCodec.EncodeDict(new Dictionary<string, object?> { ["type"] = "asteroid" })
            },
            scope: "Session",
            ownerMemberId: null,
            clientValidAt: clientStamp);

        // Assert
        result.Should().NotBeNull();
        capturedArgs.Should().NotBeNull();
        capturedArgs!.Length.Should().Be(5);
        var serverTimestamp = (long)capturedArgs[3]!;
        var batchValidAt = (long)capturedArgs[4]!;
        batchValidAt.Should().BeCloseTo(serverTimestamp, 50,
            "out-of-bounds clientValidAt must be rejected and the batch-level validAt should fall back to the hub-entry serverTimestamp");
        result!.ValidAt.Should().Be(batchValidAt);
    }

    [Fact]
    public async Task ReplaceObject_ShouldFallBackToServerTimestamp_WhenClientStampOmitted()
    {
        // Arrange
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        var creator = createResult.Creator!;
        _sessionService.JoinSession(session.Id, "connection-2");
        var parent = _objectService.CreateObject(
            session.Id, creator.Id, Models.ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" })!;

        object?[]? capturedArgs = null;
        var clientProxy = new Mock<IClientProxy>();
        clientProxy
            .Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Callback<string, object?[], CancellationToken>((_, a, _) => capturedArgs = a)
            .Returns(Task.CompletedTask);

        var hub = CreateHubWithProxy("connection-1", clientProxy);

        // Act — omit clientValidAt (older clients, or unbootstrapped offset).
        var result = await hub.ReplaceObject(parent.Id,
            new List<SyncPayload>
            {
                SyncPayloadCodec.EncodeDict(new Dictionary<string, object?> { ["type"] = "asteroid" })
            });

        // Assert
        result.Should().NotBeNull();
        capturedArgs.Should().NotBeNull();
        capturedArgs!.Length.Should().Be(5);
        var serverTimestamp = (long)capturedArgs[3]!;
        var batchValidAt = (long)capturedArgs[4]!;
        batchValidAt.Should().BeCloseTo(serverTimestamp, 50,
            "null clientValidAt must fall back to the hub-entry serverTimestamp");
        result!.ValidAt.Should().Be(batchValidAt);
    }

    [Fact]
    public async Task ReplaceObject_EmptySuccessAndFailure_HaveDistinctResponses()
    {
        var created = _sessionService.CreateSession("connection-1");
        var parent = _objectService.CreateObject(
            created.Session!.Id, created.Creator!.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "counter" })!;
        var hub = CreateHub("connection-1");

        var response = await hub.ReplaceObject(parent.Id, []);

        response.Should().NotBeNull();
        response!.CreatedObjects.Should().BeEmpty();
        response.MemberSequence.Should().BeGreaterThan(0);
        response.ValidAt.Should().BeGreaterThan(0);
        created.Session.Objects.Should().NotContainKey(parent.Id);
        (await hub.ReplaceObject(parent.Id, [])).Should().BeNull();
        Mock.Get(hub.Clients).Verify(
            clients => clients.Group(It.IsAny<string>()), Times.Never);
    }

    // ─────────────────────────────────────────────────────────────────────
    // CreateObject / UpdateObjects — clientValidAt clamp + fallback coverage
    //
    // These mirror the ReplaceObject tests above. The shared ValidAtPolicy
    // helper (in ObjectService) applies a ±2s sanity bound vs. the hub-entry
    // serverTimestamp. Within bounds: client value wins (eliminates upload-time
    // bias from the unified server-time interpolation axis). Out-of-bounds or
    // null: fall back to serverTimestamp so receivers always have a usable
    // anchor. The validated value is stored on SessionObject.ValidAt and
    // surfaced to receivers via ObjectInfo.ValidAt / ObjectUpdateInfo.ValidAt.
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task CreateObject_ShouldUseClientValidAt_WhenWithinSanityBounds()
    {
        // Arrange — second member so the OthersInGroup broadcast captures args
        // (the creating member is excluded by OthersInGroup).
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        _sessionService.JoinSession(session.Id, "connection-2");

        object?[]? capturedArgs = null;
        var clientProxy = new Mock<IClientProxy>();
        clientProxy
            .Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Callback<string, object?[], CancellationToken>((_, a, _) => capturedArgs = a)
            .Returns(Task.CompletedTask);

        var hub = CreateHubWithProxy("connection-1", clientProxy);

        var hubEntry = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var clientStamp = hubEntry - 250;

        // Act
        var response = await hub.CreateObject(
            SyncPayloadCodec.EncodeDict(new Dictionary<string, object?> { ["type"] = "asteroid" }),
            scope: "Session",
            ownerMemberId: null,
            clientValidAt: clientStamp);

        // Assert — broadcast is OnObjectCreated(objectInfo, memberId, memberSeq, serverTimestamp, validAt) = 5 args.
        response.Should().NotBeNull();
        capturedArgs.Should().NotBeNull();
        capturedArgs!.Length.Should().Be(5,
            "OnObjectCreated broadcast carries serverTimestamp + a single batch-level validAt trailing argument");
        var batchValidAt = (long)capturedArgs[4]!;
        batchValidAt.Should().Be(clientStamp,
            "in-bounds clientValidAt should be forwarded verbatim as the batch-level validAt");
    }

    [Fact]
    public async Task CreateObject_ShouldFallBackToServerTimestamp_WhenClientStampOutOfBounds()
    {
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        _sessionService.JoinSession(session.Id, "connection-2");

        object?[]? capturedArgs = null;
        var clientProxy = new Mock<IClientProxy>();
        clientProxy
            .Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Callback<string, object?[], CancellationToken>((_, a, _) => capturedArgs = a)
            .Returns(Task.CompletedTask);

        var hub = CreateHubWithProxy("connection-1", clientProxy);

        var hubEntryEstimate = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var clientStamp = hubEntryEstimate - 10_000; // 10s in the past — far outside the 2s window.

        var response = await hub.CreateObject(
            SyncPayloadCodec.EncodeDict(new Dictionary<string, object?> { ["type"] = "asteroid" }),
            scope: "Session",
            ownerMemberId: null,
            clientValidAt: clientStamp);

        response.Should().NotBeNull();
        capturedArgs.Should().NotBeNull();
        capturedArgs!.Length.Should().Be(5);
        var serverTimestamp = (long)capturedArgs[3]!;
        var batchValidAt = (long)capturedArgs[4]!;
        batchValidAt.Should().BeCloseTo(serverTimestamp, 50,
            "out-of-bounds clientValidAt must fall back to the hub-entry serverTimestamp");
    }

    [Fact]
    public async Task CreateObject_ShouldFallBackToServerTimestamp_WhenClientStampOmitted()
    {
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        _sessionService.JoinSession(session.Id, "connection-2");

        object?[]? capturedArgs = null;
        var clientProxy = new Mock<IClientProxy>();
        clientProxy
            .Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Callback<string, object?[], CancellationToken>((_, a, _) => capturedArgs = a)
            .Returns(Task.CompletedTask);

        var hub = CreateHubWithProxy("connection-1", clientProxy);

        var response = await hub.CreateObject(
            SyncPayloadCodec.EncodeDict(new Dictionary<string, object?> { ["type"] = "asteroid" }),
            scope: "Session");

        response.Should().NotBeNull();
        capturedArgs.Should().NotBeNull();
        capturedArgs!.Length.Should().Be(5);
        var serverTimestamp = (long)capturedArgs[3]!;
        var batchValidAt = (long)capturedArgs[4]!;
        batchValidAt.Should().BeCloseTo(serverTimestamp, 50,
            "null clientValidAt must fall back to the hub-entry serverTimestamp");
    }

    [Fact]
    public async Task UpdateObjects_ShouldUseClientValidAt_WhenWithinSanityBounds()
    {
        // Arrange — owner needs an existing object to update.
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        var creator = createResult.Creator!;
        _sessionService.JoinSession(session.Id, "connection-2");
        var obj = _objectService.CreateObject(
            session.Id, creator.Id, Models.ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" })!;

        object?[]? capturedArgs = null;
        var clientProxy = new Mock<IClientProxy>();
        clientProxy
            .Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Callback<string, object?[], CancellationToken>((_, a, _) => capturedArgs = a)
            .Returns(Task.CompletedTask);

        var hub = CreateHubWithProxy("connection-1", clientProxy);

        var hubEntry = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Newer than the existing object's ValidAt so the monotonic cap doesn't override.
        var clientStamp = hubEntry + 100;

        var updates = new List<ObjectUpdateRequest>
        {
            new(obj.Handle, SyncPayloadCodec.EncodeDict(new Dictionary<string, object?> { ["x"] = 0.5 }))
        };

        // Act
        var response = await hub.UpdateObjects(
            updates,
            senderSequence: 1,
            senderSendIntervalMs: 100,
            clientValidAt: clientStamp);

        // Assert — broadcast is OnObjectsUpdated(updateInfos, memberId, senderSeq, memberSeq, serverTimestamp, senderSendIntervalMs, validAt) = 7 args.
        response.Should().NotBeNull();
        capturedArgs.Should().NotBeNull();
        capturedArgs!.Length.Should().Be(7,
            "OnObjectsUpdated broadcast carries serverTimestamp + senderSendIntervalMs + a single batch-level validAt trailing argument");
        var batchValidAt = (long)capturedArgs[6]!;
        batchValidAt.Should().Be(clientStamp,
            "in-bounds clientValidAt should be forwarded verbatim as the batch-level validAt");
    }

    [Fact]
    public async Task UpdateObjects_ShouldFallBackToServerTimestamp_WhenClientStampOutOfBounds()
    {
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        var creator = createResult.Creator!;
        _sessionService.JoinSession(session.Id, "connection-2");
        var obj = _objectService.CreateObject(
            session.Id, creator.Id, Models.ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" })!;

        object?[]? capturedArgs = null;
        var clientProxy = new Mock<IClientProxy>();
        clientProxy
            .Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Callback<string, object?[], CancellationToken>((_, a, _) => capturedArgs = a)
            .Returns(Task.CompletedTask);

        var hub = CreateHubWithProxy("connection-1", clientProxy);

        var hubEntryEstimate = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var clientStamp = hubEntryEstimate + 10_000; // 10s in the future — far outside the 2s window.

        var updates = new List<ObjectUpdateRequest>
        {
            new(obj.Handle, SyncPayloadCodec.EncodeDict(new Dictionary<string, object?> { ["x"] = 0.5 }))
        };

        var response = await hub.UpdateObjects(
            updates,
            senderSequence: 1,
            senderSendIntervalMs: 100,
            clientValidAt: clientStamp);

        response.Should().NotBeNull();
        capturedArgs.Should().NotBeNull();
        capturedArgs!.Length.Should().Be(7);
        var serverTimestamp = (long)capturedArgs[4]!;
        var batchValidAt = (long)capturedArgs[6]!;
        batchValidAt.Should().BeCloseTo(serverTimestamp, 50,
            "out-of-bounds clientValidAt must fall back to the hub-entry serverTimestamp");
    }

    [Fact]
    public async Task UpdateObjects_ShouldFallBackToServerTimestamp_WhenClientStampOmitted()
    {
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        var creator = createResult.Creator!;
        _sessionService.JoinSession(session.Id, "connection-2");
        var obj = _objectService.CreateObject(
            session.Id, creator.Id, Models.ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" })!;

        object?[]? capturedArgs = null;
        var clientProxy = new Mock<IClientProxy>();
        clientProxy
            .Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Callback<string, object?[], CancellationToken>((_, a, _) => capturedArgs = a)
            .Returns(Task.CompletedTask);

        var hub = CreateHubWithProxy("connection-1", clientProxy);

        var updates = new List<ObjectUpdateRequest>
        {
            new(obj.Handle, SyncPayloadCodec.EncodeDict(new Dictionary<string, object?> { ["x"] = 0.5 }))
        };

        var response = await hub.UpdateObjects(updates);

        response.Should().NotBeNull();
        capturedArgs.Should().NotBeNull();
        capturedArgs!.Length.Should().Be(7);
        var serverTimestamp = (long)capturedArgs[4]!;
        var batchValidAt = (long)capturedArgs[6]!;
        batchValidAt.Should().BeCloseTo(serverTimestamp, 50,
            "null clientValidAt must fall back to the hub-entry serverTimestamp");
    }

    [Fact]
    public async Task ConcurrentHubOperations_CommitAndBroadcastInSessionOrder()
    {
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        _sessionService.JoinSession(session.Id, "connection-2");
        var firstSendEntered = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFirstSend = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);

        var firstProxy = new Mock<IClientProxy>();
        firstProxy
            .Setup(p => p.SendCoreAsync(
                "OnObjectCreated",
                It.IsAny<object?[]>(),
                It.IsAny<CancellationToken>()))
            .Callback(() => firstSendEntered.TrySetResult())
            .Returns(releaseFirstSend.Task);
        var secondProxy = new Mock<IClientProxy>();
        secondProxy
            .Setup(p => p.SendCoreAsync(
                It.IsAny<string>(),
                It.IsAny<object?[]>(),
                It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);

        var firstHub = CreateHubWithProxy(
            "connection-1", firstProxy);
        var secondHub = CreateHubWithProxy(
            "connection-2", secondProxy);

        var first = firstHub.CreateObject(
            SyncPayloadCodec.EncodeDict(
                new Dictionary<string, object?> { ["order"] = 1 }),
            scope: "Session");
        await firstSendEntered.Task.WaitAsync(TimeSpan.FromSeconds(1));

        var second = secondHub.CreateObject(
            SyncPayloadCodec.EncodeDict(
                new Dictionary<string, object?> { ["order"] = 2 }),
            scope: "Session");
        await Task.Delay(25);

        _objectService.GetSessionObjects(session.Id).Should().ContainSingle(
            "the second mutation must wait until the first broadcast completes");

        releaseFirstSend.TrySetResult();
        await Task.WhenAll(first, second);
        _objectService.GetSessionObjects(session.Id).Should().HaveCount(2);
    }

    // ── Positional UpdateObjects acknowledgement ───────────────────────────────
    //
    // Versions[i] is the version assigned to request element i, or 0 when that
    // element was not applied. The alignment relies on ObjectService returning an
    // order-preserving subsequence of the requested updates, so these cover the
    // mixed accept/reject and duplicate-id cases that exercise that invariant.

    [Fact]
    public async Task UpdateObjects_ShouldReturnVersionsPositionallyAlignedToRequest()
    {
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        var creator = createResult.Creator!;
        var first = _objectService.CreateObject(
            session.Id, creator.Id, Models.ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" })!;
        var second = _objectService.CreateObject(
            session.Id, creator.Id, Models.ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" })!;

        var hub = CreateHub("connection-1");

        var updates = new List<ObjectUpdateRequest>
        {
            new(first.Handle, SyncPayloadCodec.EncodeDict(new Dictionary<string, object?> { ["x"] = 0.5 })),
            new(second.Handle, SyncPayloadCodec.EncodeDict(new Dictionary<string, object?> { ["x"] = 0.25 })),
        };

        var response = await hub.UpdateObjects(updates);

        response.Should().NotBeNull();
        response!.Versions.Should().HaveCount(2, "one entry per request element");
        response.Versions[0].Should().Be(first.Version + 1);
        response.Versions[1].Should().Be(second.Version + 1);
    }

    [Fact]
    public async Task UpdateObjects_ShouldReportZeroForUnappliedUpdates()
    {
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        var creator = createResult.Creator!;
        var joinResult = _sessionService.JoinSession(session.Id, "connection-2");
        var other = joinResult.Member!;

        var owned = _objectService.CreateObject(
            session.Id, creator.Id, Models.ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" })!;
        // Owned by the other member, so the caller's update must be rejected.
        var foreign = _objectService.CreateObject(
            session.Id, other.Id, Models.ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" })!;

        var hub = CreateHub("connection-1");

        var payload = SyncPayloadCodec.EncodeDict(new Dictionary<string, object?> { ["x"] = 0.5 });
        var updates = new List<ObjectUpdateRequest>
        {
            new(0, payload),                // unknown handle
            new(owned.Handle, payload),     // accepted
            new(foreign.Handle, payload),   // not owned by caller
        };

        var response = await hub.UpdateObjects(updates);

        response.Should().NotBeNull();
        response!.Versions.Should().HaveCount(3);
        response.Versions[0].Should().Be(0, "unknown handles are not applied");
        response.Versions[1].Should().Be(owned.Version + 1, "the accepted update keeps its own index");
        response.Versions[2].Should().Be(0, "objects owned by another member are not applied");
    }

    [Fact]
    public async Task UpdateObjects_ShouldReturnEmptyVersions_WhenNothingApplied()
    {
        _sessionService.CreateSession("connection-1");
        var hub = CreateHub("connection-1");

        var response = await hub.UpdateObjects(new List<ObjectUpdateRequest>());

        response.Should().NotBeNull();
        response!.Versions.Should().BeEmpty();
    }

    [Fact]
    public async Task UpdateObjects_ShouldGiveEachDuplicateIdItsOwnVersion()
    {
        // A batch carrying the same id twice applies twice, so each request index
        // must receive its own successive version rather than sharing one.
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        var creator = createResult.Creator!;
        var obj = _objectService.CreateObject(
            session.Id, creator.Id, Models.ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" })!;

        var hub = CreateHub("connection-1");

        var updates = new List<ObjectUpdateRequest>
        {
            new(obj.Handle, SyncPayloadCodec.EncodeDict(new Dictionary<string, object?> { ["x"] = 0.5 })),
            new(obj.Handle, SyncPayloadCodec.EncodeDict(new Dictionary<string, object?> { ["x"] = 0.75 })),
        };

        var response = await hub.UpdateObjects(updates);

        response.Should().NotBeNull();
        response!.Versions.Should().HaveCount(2);
        response.Versions[0].Should().Be(obj.Version + 1);
        response.Versions[1].Should().Be(obj.Version + 2,
            "the second occurrence is applied on top of the first");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task UpdateObjects_RepeatedHandles_BroadcastsEachAcceptedPatchWithItsOwnVersion(bool positional)
    {
        var created = _sessionService.CreateSession("connection-1");
        var session = created.Session!;
        var owner = created.Creator!;
        var other = _sessionService.JoinSession(session.Id, "connection-2").Member!;
        var schemaId = positional ? (byte)1 : (byte)0;
        if (positional)
            _schemaRegistry.SetSessionSchemas(session.Id,
                [new PositionalSchemaCodec.Schema(1, [new("x", "u8"), new("y", "u8")])]);
        var obj = _objectService.CreateObject(session.Id, owner.Id, ObjectScope.Session, schemaId: schemaId)!;
        var foreign = _objectService.CreateObject(session.Id, other.Id, ObjectScope.Session)!;
        var x = SyncPayloadCodec.EncodeDict(schemaId, new Dictionary<string, object?> { ["x"] = 1 }, _schemaRegistry, session.Id);
        var y = SyncPayloadCodec.EncodeDict(schemaId, new Dictionary<string, object?> { ["y"] = 2 }, _schemaRegistry, session.Id);
        object?[]? broadcast = null;
        var proxy = new Mock<IClientProxy>();
        proxy.Setup(p => p.SendCoreAsync("OnObjectsUpdated", It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Callback<string, object?[], CancellationToken>((_, args, _) => broadcast = args)
            .Returns(Task.CompletedTask);
        var hub = CreateHubWithProxy("connection-1", proxy);

        var response = await hub.UpdateObjects(new[]
        {
            new ObjectUpdateRequest(0, x),
            new ObjectUpdateRequest(foreign.Handle, x),
            new ObjectUpdateRequest(obj.Handle, x),
            new ObjectUpdateRequest(0, y),
            new ObjectUpdateRequest(foreign.Handle, y),
            new ObjectUpdateRequest(obj.Handle, y),
            new ObjectUpdateRequest(0, x)
        });

        response!.Versions.Should().Equal(0, 0, 2, 0, 0, 3, 0);
        var updates = ((IEnumerable<ObjectUpdateInfo>)broadcast![0]!).ToArray();
        updates.Select(u => u.Version).Should().Equal(2, 3);
        updates.Select(u => u.Handle).Should().Equal(obj.Handle, obj.Handle);
        updates[0].Data.Should().BeSameAs(x, "each accepted request must retain its original bytes");
        updates[1].Data.Should().BeSameAs(y);
        var replica = new Dictionary<string, object?>();
        foreach (var update in updates)
            foreach (var entry in SyncPayloadCodec.DecodeDict(update.Data, session.Id, _schemaRegistry))
                replica[entry.Key] = entry.Value;
        replica.Should().BeEquivalentTo(_objectService.GetObject(session.Id, obj.Id)!.Data);
        _objectService.GetObject(session.Id, foreign.Id)!.Version.Should().Be(1);
    }

    // ── Session-scoped object handles on the wire ──────────────────────────────

    [Fact]
    public async Task CreateObject_ShouldPublishTheHandleAlongsideTheId()
    {
        // Clients learn the handle→id mapping from ordinary ObjectInfo traffic,
        // so the create response (and the broadcast built from the same
        // projection) must carry it.
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;

        var hub = CreateHub("connection-1");
        var response = await hub.CreateObject(
            SyncPayloadCodec.EncodeDict(new Dictionary<string, object?> { ["type"] = "asteroid" }),
            scope: "Session");

        response.Should().NotBeNull();
        var stored = _objectService.GetObject(session.Id, response!.ObjectInfo.Id)!;
        response.ObjectInfo.Handle.Should().Be(stored.Handle).And.BeGreaterThan(0);
    }

    [Fact]
    public async Task UpdateObjects_ShouldBroadcastHandlesRatherThanObjectIds()
    {
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        var creator = createResult.Creator!;
        _sessionService.JoinSession(session.Id, "connection-2");
        var obj = _objectService.CreateObject(
            session.Id, creator.Id, Models.ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" })!;

        object?[]? capturedArgs = null;
        var clientProxy = new Mock<IClientProxy>();
        clientProxy
            .Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Callback<string, object?[], CancellationToken>((_, a, _) => capturedArgs = a)
            .Returns(Task.CompletedTask);

        var hub = CreateHubWithProxy("connection-1", clientProxy);

        await hub.UpdateObjects(
        [
            new(obj.Handle, SyncPayloadCodec.EncodeDict(new Dictionary<string, object?> { ["x"] = 0.5 }))
        ]);

        capturedArgs.Should().NotBeNull();
        var broadcast = capturedArgs![0].Should().BeAssignableTo<IEnumerable<ObjectUpdateInfo>>().Subject.ToList();
        broadcast.Should().ContainSingle();
        broadcast[0].Handle.Should().Be(obj.Handle,
            "receivers resolve the object from the handle they were taught at create time");
        broadcast[0].Version.Should().Be(obj.Version + 1);
    }

    [Fact]
    public async Task UpdateObjects_ShouldRejectAStaleHandleWithoutDisturbingItsNeighbours()
    {
        // Handles are never reused, so an update addressed to a deleted object
        // simply fails to resolve — it must not shift the positional ack.
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        var creator = createResult.Creator!;
        var deleted = _objectService.CreateObject(
            session.Id, creator.Id, Models.ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" })!;
        var live = _objectService.CreateObject(
            session.Id, creator.Id, Models.ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" })!;
        _objectService.DeleteObject(session.Id, deleted.Id, creator.Id);

        var hub = CreateHub("connection-1");
        var payload = SyncPayloadCodec.EncodeDict(new Dictionary<string, object?> { ["x"] = 0.5 });

        var response = await hub.UpdateObjects(
        [
            new(deleted.Handle, payload),
            new(live.Handle, payload)
        ]);

        response.Should().NotBeNull();
        response!.Versions.Should().HaveCount(2);
        response.Versions[0].Should().Be(0, "the deleted object's handle no longer resolves");
        response.Versions[1].Should().Be(live.Version + 1, "the live update keeps its own index");
    }

    private SessionHub CreateHubWithProxy(
        string connectionId,
        Mock<IClientProxy> proxy)
        => CreateHub(
            connectionId,
            clientProxyMock: proxy);

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("unknown")]
    [InlineData("0")]
    [InlineData("1")]
    [InlineData("Member, Session")]
    public async Task ObjectOptions_InvalidExplicitScope_RejectsCreateAndReplaceWithoutMutation(string? scope)
    {
        var created = _sessionService.CreateSession("connection-1");
        var session = created.Session!;
        var parent = _objectService.CreateObject(session.Id, created.Creator!.Id, ObjectScope.Session)!;
        var proxy = new Mock<IClientProxy>(MockBehavior.Strict);
        var hub = CreateHubWithProxy("connection-1", proxy);
        var payload = SyncPayloadCodec.EncodeDict(new Dictionary<string, object?>());

        (await hub.CreateObject(payload, scope: scope!)).Should().BeNull();
        (await hub.ReplaceObject(parent.Id, [payload], scope: scope!)).Should().BeNull();

        _objectService.GetSessionObjects(session.Id).Should().ContainSingle()
            .Which.Should().BeEquivalentTo(parent);
        created.Creator.EventSequence.Should().Be(0);
        proxy.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData("not-a-guid")]
    [InlineData("empty-guid")]
    [InlineData("unknown")]
    [InlineData("other-session")]
    [InlineData("departed")]
    public async Task ObjectOptions_InvalidExplicitOwner_RejectsCreateAndReplaceWithoutMutation(string kind)
    {
        var created = _sessionService.CreateSession("connection-1");
        var session = created.Session!;
        var parent = _objectService.CreateObject(session.Id, created.Creator!.Id, ObjectScope.Session)!;
        var owner = kind switch
        {
            "empty-guid" => Guid.Empty.ToString(),
            "unknown" => Guid.NewGuid().ToString(),
            "other-session" => _sessionService.CreateSession("other-session").Creator!.Id.ToString(),
            "departed" => _sessionService.JoinSession(session.Id, "departed").Member!.Id.ToString(),
            _ => kind
        };
        if (kind == "departed")
            _sessionService.LeaveSession("departed");
        var proxy = new Mock<IClientProxy>(MockBehavior.Strict);
        var hub = CreateHubWithProxy("connection-1", proxy);
        var payload = SyncPayloadCodec.EncodeDict(new Dictionary<string, object?>());

        (await hub.CreateObject(payload, ownerMemberId: owner)).Should().BeNull();
        (await hub.ReplaceObject(parent.Id, [payload], ownerMemberId: owner)).Should().BeNull();
        (await hub.ReplaceObject(parent.Id, [], ownerMemberId: owner)).Should().BeNull();

        _objectService.GetSessionObjects(session.Id).Should().ContainSingle()
            .Which.Should().BeEquivalentTo(parent);
        created.Creator.EventSequence.Should().Be(0);
        proxy.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task ObjectOptions_OmittedDefaultsAndCaseInsensitiveScopes_RemainValid()
    {
        var created = _sessionService.CreateSession("connection-1");
        var session = created.Session!;
        var other = _sessionService.JoinSession(session.Id, "connection-2").Member!;
        var hub = CreateHub("connection-1");
        var payload = SyncPayloadCodec.EncodeDict(new Dictionary<string, object?>());

        var first = (await hub.CreateObject(payload))!.ObjectInfo;
        first.Scope.Should().Be(ObjectScope.Member);
        first.OwnerMemberId.Should().Be(created.Creator!.Id);
        var replaced = (await hub.ReplaceObject(first.Id, [payload]))!.CreatedObjects.Single();
        replaced.Scope.Should().Be(ObjectScope.Session);
        replaced.OwnerMemberId.Should().Be(created.Creator.Id);
        var explicitChild = (await hub.ReplaceObject(replaced.Id, [payload],
            scope: "mEmBeR", ownerMemberId: other.Id.ToString()))!.CreatedObjects.Single();
        explicitChild.Scope.Should().Be(ObjectScope.Member);
        explicitChild.OwnerMemberId.Should().Be(other.Id);
        var explicitObject = (await hub.CreateObject(payload, scope: "sEsSiOn",
            ownerMemberId: other.Id.ToString()))!.ObjectInfo;
        explicitObject.Scope.Should().Be(ObjectScope.Session);
        explicitObject.OwnerMemberId.Should().Be(other.Id);
    }
}
