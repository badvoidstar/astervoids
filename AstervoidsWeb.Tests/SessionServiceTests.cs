using AstervoidsWeb.Models;
using AstervoidsWeb.Services;
using FluentAssertions;

namespace AstervoidsWeb.Tests;

public class SessionServiceTests
{
    private readonly SessionService _sessionService;

    public SessionServiceTests()
    {
        _sessionService = TestServiceFactory.CreateSessionService();
    }

    [Fact]
    public void CreateSession_ShouldCreateSessionWithFruitName()
    {
        // Act
        var result = _sessionService.CreateSession("connection-1");
        var session = result.Session!;

        // Assert
        result.Success.Should().BeTrue();
        session.Should().NotBeNull();
        session.Id.Should().NotBe(Guid.Empty);
        session.Name.Should().NotBeNullOrEmpty();
        session.Members.Should().HaveCount(1);
        session.CreatedAt.Should().BeCloseTo(DateTime.UtcNow, TimeSpan.FromSeconds(5));
    }

    [Fact]
    public void CreateSession_CreatorShouldBeServer()
    {
        // Act
        var result = _sessionService.CreateSession("connection-1");
        var session = result.Session!;
        var creator = result.Creator!;

        // Assert
        creator.Should().NotBeNull();
        creator.Role.Should().Be(MemberRole.Server);
        creator.ConnectionId.Should().Be("connection-1");
        creator.SessionId.Should().Be(session.Id);
    }

    [Fact]
    public void JoinSession_ShouldAddMemberAsClient()
    {
        // Arrange
        var session = _sessionService.CreateSession("connection-1").Session!;

        // Act
        var result = _sessionService.JoinSession(session.Id, "connection-2");

        // Assert
        Assert.True(result.Success);
        var joinedSession = result.Session!;
        var member = result.Member!;
        member.Role.Should().Be(MemberRole.Client);
        member.ConnectionId.Should().Be("connection-2");
        joinedSession.Members.Should().HaveCount(2);
    }

    [Fact]
    public void JoinSession_NonExistentSession_ShouldFail()
    {
        // Act
        var result = _sessionService.JoinSession(Guid.NewGuid(), "connection-1");

        // Assert
        result.Success.Should().BeFalse();
        result.Session.Should().BeNull();
        result.Member.Should().BeNull();
        result.ErrorMessage.Should().NotBeNullOrEmpty();
    }

    [Fact]
    public void LeaveSession_ServerLeaves_ShouldPromoteClient()
    {
        // Arrange
        var session = _sessionService.CreateSession("connection-1").Session!;
        _sessionService.JoinSession(session.Id, "connection-2");

        // Act
        var result = _sessionService.LeaveSession("connection-1");

        // Assert
        result.Should().NotBeNull();
        result!.PromotedMember.Should().NotBeNull();
        result.PromotedMember!.Role.Should().Be(MemberRole.Server);
        result.SessionDestroyed.Should().BeFalse();
    }

    [Fact]
    public void LeaveSession_LastMemberLeaves_ShouldKeepSessionForTimeout()
    {
        // Arrange
        var session = _sessionService.CreateSession("connection-1").Session!;

        // Act
        var result = _sessionService.LeaveSession("connection-1");

        // Assert
        result.Should().NotBeNull();
        result!.SessionDestroyed.Should().BeFalse();
        var remainingSession = _sessionService.GetSession(session.Id);
        remainingSession.Should().NotBeNull();
        remainingSession!.Members.Should().BeEmpty();
        remainingSession.LastMemberLeftAt.Should().NotBeNull();
    }

    [Fact]
    public void LeaveSession_ClientLeaves_ShouldNotPromote()
    {
        // Arrange
        var session = _sessionService.CreateSession("connection-1").Session!;
        _sessionService.JoinSession(session.Id, "connection-2");

        // Act
        var result = _sessionService.LeaveSession("connection-2");

        // Assert
        result.Should().NotBeNull();
        result!.PromotedMember.Should().BeNull();
        result.SessionDestroyed.Should().BeFalse();
    }

    [Fact]
    public void GetActiveSessions_ShouldReturnAllSessions()
    {
        // Arrange
        _sessionService.CreateSession("connection-1");
        _sessionService.CreateSession("connection-2");
        _sessionService.CreateSession("connection-3");

        // Act
        var sessions = _sessionService.GetActiveSessions().Sessions.ToList();

        // Assert
        sessions.Should().HaveCount(3);
    }

    [Fact]
    public void GetActiveSessions_DefaultRegionId_IsLocal_OnParameterlessConstructor()
    {
        // The parameter-less constructor is used by unit tests and legacy callers
        // that don't bind RegionSettings. It must stamp a stable default so the
        // client can still merge sessions across "local" and other regions
        // without crashing on a null id.
        var service = new SessionService();
        service.CreateSession("connection-1");

        var sessions = service.GetActiveSessions().Sessions.ToList();

        sessions.Should().AllSatisfy(s => s.RegionId.Should().Be("local"));
    }

    [Fact]
    public void GetActiveSessions_StampsConfiguredRegionId_WhenRegionSettingsBound()
    {
        // The DI-aware constructor takes IOptions<RegionSettings>; every
        // SessionInfo it emits must carry that region id so cross-region clients
        // know which region's hub to talk to for Join.
        var sessionSettings = Microsoft.Extensions.Options.Options.Create(
            new AstervoidsWeb.Configuration.SessionSettings { MaxSessions = 4, MaxMembersPerSession = 4 });
        var regionSettings = Microsoft.Extensions.Options.Options.Create(
            new AstervoidsWeb.Configuration.RegionSettings { Id = "westeurope", DisplayName = "Europe West" });
        var logger = Microsoft.Extensions.Logging.Abstractions.NullLogger<SessionService>.Instance;
        var svc = new SessionService(sessionSettings, logger, new FruitNameGenerator(), regionSettings);

        svc.CreateSession("conn-region-stamp");
        var sessions = svc.GetActiveSessions().Sessions.ToList();

        sessions.Should().NotBeEmpty();
        sessions.Should().AllSatisfy(s => s.RegionId.Should().Be("westeurope",
            "every SessionInfo is stamped with the configured RegionSettings.Id " +
            "so cross-region clients can route a Join call to the owning region"));
    }

    [Fact]
    public void GetMemberByConnectionId_ShouldReturnMember()
    {
        // Arrange
        var creator = _sessionService.CreateSession("connection-1").Creator!;

        // Act
        var member = _sessionService.GetMemberByConnectionId("connection-1");

        // Assert
        member.Should().NotBeNull();
        member!.Id.Should().Be(creator.Id);
    }

    [Fact]
    public void GetSessionByConnectionId_ShouldReturnSession()
    {
        // Arrange
        var session = _sessionService.CreateSession("connection-1").Session!;

        // Act
        var foundSession = _sessionService.GetSessionByConnectionId("connection-1");

        // Assert
        foundSession.Should().NotBeNull();
        foundSession!.Id.Should().Be(session.Id);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void SessionLookup_ReturnsDetachedStateInsteadOfAnUnauthorizedMutationSurface(bool byConnection)
    {
        var created = _sessionService.CreateSession("connection-1", new Dictionary<string, object?>
        {
            ["settings"] = new Dictionary<string, object?> { ["bytes"] = new byte[] { 7 } }
        });
        var live = created.Session!;
        var owner = created.Creator!;
        var objectService = new ObjectService(_sessionService);
        var obj = objectService.CreateObject(live.Id, owner.Id, ObjectScope.Session,
            new Dictionary<string, object?>
            {
                ["nested"] = new Dictionary<string, object?> { ["values"] = new object?[] { 1, 2 } },
                ["bytes"] = new byte[] { 3, 4 }
            })!;

        var snapshot = byConnection
            ? _sessionService.GetSessionByConnectionId("connection-1")!
            : _sessionService.GetSession(live.Id)!;
        snapshot.Should().NotBeSameAs(live);
        snapshot.SyncRoot.Should().NotBeSameAs(live.SyncRoot);
        snapshot.Members[owner.Id].Should().NotBeSameAs(owner);
        var originalObjectSnapshot = snapshot.Objects[obj.Id];
        originalObjectSnapshot.OwnerMemberId = Guid.NewGuid();
        originalObjectSnapshot.Version = 99;
        ((object?[])((Dictionary<string, object?>)originalObjectSnapshot.Data["nested"]!)["values"]!)[0] = -1;
        ((byte[])originalObjectSnapshot.Data["bytes"]!)[0] = 0;
        ((byte[])((Dictionary<string, object?>)snapshot.Metadata["settings"]!)["bytes"]!)[0] = 0;
        snapshot.Members[owner.Id].Role = MemberRole.Client;
        snapshot.Members[owner.Id].EventSequence = 99;
        snapshot.Members.Clear();
        snapshot.LifecycleState = SessionLifecycleState.Destroyed;
        snapshot.Version = 99;
        snapshot.LastMemberLeftAt = DateTime.UtcNow;
        lock (snapshot.SyncRoot)
        {
            snapshot.TryGetObjectByHandle(obj.Handle, out var indexed).Should().BeTrue();
            indexed.Should().BeSameAs(originalObjectSnapshot);
            snapshot.RemoveObject(obj.Id, out _).Should().BeTrue();
            snapshot.AllocateObjectHandle().Should().Be(obj.Handle + 1);
        }

        objectService.GetObject(live.Id, obj.Id).Should().BeEquivalentTo(obj);
        var fresh = _sessionService.GetSession(live.Id)!;
        fresh.Members.Should().ContainKey(owner.Id);
        fresh.Members[owner.Id].Role.Should().Be(MemberRole.Server);
        fresh.Members[owner.Id].EventSequence.Should().Be(0);
        fresh.Version.Should().Be(1);
        fresh.LifecycleState.Should().Be(SessionLifecycleState.Active);
        fresh.LastMemberLeftAt.Should().BeNull();
        ((byte[])((Dictionary<string, object?>)fresh.Metadata["settings"]!)["bytes"]!)[0].Should().Be(7);
        objectService.CreateObject(live.Id, owner.Id, ObjectScope.Session)!.Handle.Should().Be(obj.Handle + 1);
    }

    [Fact]
    public void SessionLookup_DoesNotChangeAfterLaterServiceMutations()
    {
        var created = _sessionService.CreateSession("connection-1");
        var live = created.Session!;
        var owner = created.Creator!;
        var objectService = new ObjectService(_sessionService);
        var obj = objectService.CreateObject(live.Id, owner.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["value"] = 1 })!;
        var snapshot = _sessionService.GetSession(live.Id)!;

        objectService.UpdateObject(live.Id, obj.Id, owner.Id,
            new Dictionary<string, object?> { ["value"] = 2 });
        _sessionService.JoinSession(live.Id, "connection-2");
        _sessionService.LeaveSession("connection-1");

        snapshot.Members.Should().ContainSingle().Which.Key.Should().Be(owner.Id);
        snapshot.Objects[obj.Id].Should().BeEquivalentTo(obj);
        _sessionService.GetSessionForSynchronization(live.Id).Should().BeSameAs(live,
            "only the explicitly synchronized infrastructure lookup returns live state");
    }

    [Fact]
    public async Task SessionLookup_ConcurrentUpdates_CapturesDataAndVersionUnderTheSameLock()
    {
        var created = _sessionService.CreateSession("connection-1");
        var session = created.Session!;
        var owner = created.Creator!;
        var objectService = new ObjectService(_sessionService);
        var obj = objectService.CreateObject(session.Id, owner.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["value"] = 0 })!;
        var writer = Task.Run(() =>
        {
            for (var value = 1; value <= 100; value++)
                objectService.UpdateObject(session.Id, obj.Id, owner.Id,
                    new Dictionary<string, object?> { ["value"] = value });
        });

        for (var i = 0; i < 100; i++)
        {
            var snapshot = _sessionService.GetSession(session.Id)!.Objects[obj.Id];
            snapshot.Version.Should().Be((int)snapshot.Data["value"]! + 1);
        }
        await writer;
    }

    [Fact]
    public void CreateSession_MultipleSessions_ShouldHaveUniqueFruitNames()
    {
        // Arrange & Act
        var names = new HashSet<string>();
        for (int i = 0; i < 6; i++)
        {
            var result = _sessionService.CreateSession($"connection-{i}");
            names.Add(result.Session!.Name);
        }

        // Assert
        names.Should().HaveCount(6, "all session names should be unique");
    }

    [Fact]
    public void CreateSession_ExceedsMaxSessions_ShouldFail()
    {
        // Arrange - create max sessions (6)
        for (int i = 0; i < 6; i++)
        {
            var result = _sessionService.CreateSession($"connection-{i}");
            result.Success.Should().BeTrue($"session {i} should be created successfully");
        }

        // Act - try to create one more
        var failedResult = _sessionService.CreateSession("connection-overflow");

        // Assert
        failedResult.Success.Should().BeFalse();
        failedResult.Session.Should().BeNull();
        failedResult.Creator.Should().BeNull();
        failedResult.ErrorMessage.Should().NotBeNullOrEmpty();
    }

    [Fact]
    public void CreateSession_WhileAlreadyInSession_ShouldFail()
    {
        // Arrange - create a session first
        var result = _sessionService.CreateSession("connection-1");
        result.Success.Should().BeTrue();

        // Act - try to create another session with the same connection
        var failedResult = _sessionService.CreateSession("connection-1");

        // Assert
        failedResult.Success.Should().BeFalse();
        failedResult.Session.Should().BeNull();
        failedResult.Creator.Should().BeNull();
        failedResult.ErrorMessage.Should().NotBeNullOrEmpty();
    }

    [Fact]
    public void JoinSession_WhileAlreadyInSession_ShouldFail()
    {
        // Arrange - create two sessions
        var session1 = _sessionService.CreateSession("connection-1").Session!;
        var session2 = _sessionService.CreateSession("connection-2").Session!;

        // Join session1 with connection-3
        var joinResult = _sessionService.JoinSession(session1.Id, "connection-3");
        Assert.True(joinResult.Success);

        // Act - try to join session2 with the same connection
        var failedResult = _sessionService.JoinSession(session2.Id, "connection-3");

        // Assert
        failedResult.Success.Should().BeFalse();
        failedResult.Session.Should().BeNull();
        failedResult.Member.Should().BeNull();
        failedResult.ErrorMessage.Should().NotBeNullOrEmpty();
    }

    [Fact]
    public void JoinSession_SessionFull_ShouldFail()
    {
        // Arrange - create a session and fill it with 4 members (max)
        var session = _sessionService.CreateSession("connection-1").Session!;
        _sessionService.JoinSession(session.Id, "connection-2");
        _sessionService.JoinSession(session.Id, "connection-3");
        _sessionService.JoinSession(session.Id, "connection-4");

        // Verify session is full
        var fullSession = _sessionService.GetSession(session.Id);
        fullSession!.Members.Should().HaveCount(4);

        // Act - try to join with a 5th member
        var failedResult = _sessionService.JoinSession(session.Id, "connection-5");

        // Assert
        failedResult.Success.Should().BeFalse();
        failedResult.Session.Should().BeNull();
        failedResult.Member.Should().BeNull();
        failedResult.ErrorMessage.Should().NotBeNullOrEmpty();
    }

    [Fact]
    public void CreateSession_ShouldStoreMetadata()
    {
        // Act
        var metadata = new Dictionary<string, object?> { ["aspectRatio"] = 1.7777, ["gameMode"] = "classic" };
        var result = _sessionService.CreateSession("connection-1", metadata);
        var session = result.Session!;

        // Assert
        session.Metadata.Should().ContainKey("aspectRatio").WhoseValue.Should().Be(1.7777);
        session.Metadata.Should().ContainKey("gameMode").WhoseValue.Should().Be("classic");
    }

    [Fact]
    public void CreateSession_NullMetadata_ShouldDefaultToEmptyDictionary()
    {
        // Act
        var result = _sessionService.CreateSession("connection-1");
        var session = result.Session!;

        // Assert
        session.Metadata.Should().NotBeNull().And.BeEmpty();
    }

    [Fact]
    public void JoinSession_ShouldReturnSessionWithMetadata()
    {
        // Arrange
        var metadata = new Dictionary<string, object?> { ["aspectRatio"] = 1.333 };
        var createResult = _sessionService.CreateSession("connection-1", metadata);
        var session = createResult.Session!;

        // Act
        var joinResult = _sessionService.JoinSession(session.Id, "connection-2");

        // Assert
        joinResult.Success.Should().BeTrue();
        joinResult.Session!.Metadata.Should().ContainKey("aspectRatio").WhoseValue.Should().Be(1.333);
    }

    [Fact]
    public void JoinSession_EmptySession_ShouldBecomeServer()
    {
        // Arrange - create session, then all members leave
        var session = _sessionService.CreateSession("connection-1").Session!;
        _sessionService.LeaveSession("connection-1");

        // Act - join the empty session
        var joinResult = _sessionService.JoinSession(session.Id, "connection-2");

        // Assert
        joinResult.Success.Should().BeTrue();
        joinResult.Member!.Role.Should().Be(MemberRole.Server);
    }

    [Fact]
    public void JoinSession_EmptySession_ShouldClearLastMemberLeftAt()
    {
        // Arrange
        var session = _sessionService.CreateSession("connection-1").Session!;
        _sessionService.LeaveSession("connection-1");
        session.LastMemberLeftAt.Should().NotBeNull();

        // Act
        _sessionService.JoinSession(session.Id, "connection-2");

        // Assert
        session.LastMemberLeftAt.Should().BeNull();
    }

    [Fact]
    public void GetAllSessions_ShouldIncludeEmptySessions()
    {
        // Arrange - create sessions, leave one empty
        _sessionService.CreateSession("connection-1");
        var session2 = _sessionService.CreateSession("connection-2").Session!;
        _sessionService.LeaveSession("connection-2");

        // Act
        var allSessions = _sessionService.GetAllSessions().ToList();
        var activeSessions = _sessionService.GetActiveSessions().Sessions.ToList();

        // Assert
        allSessions.Should().HaveCount(2);
        activeSessions.Should().HaveCount(1); // Empty sessions excluded from active list
    }

    [Fact]
    public void ForceDestroySession_ShouldRemoveSessionAndMembers()
    {
        // Arrange
        var session = _sessionService.CreateSession("connection-1").Session!;
        _sessionService.JoinSession(session.Id, "connection-2");

        // Act
        var result = _sessionService.ForceDestroySession(session.Id);

        // Assert
        result.Should().NotBeNull();
        result!.ConnectionIds.Should().HaveCount(2);
        result.ConnectionIds.Should().Contain("connection-1");
        result.ConnectionIds.Should().Contain("connection-2");
        result.SessionName.Should().Be(session.Name);
        _sessionService.GetSession(session.Id).Should().BeNull();
        _sessionService.GetMemberByConnectionId("connection-1").Should().BeNull();
        _sessionService.GetMemberByConnectionId("connection-2").Should().BeNull();
    }

    [Fact]
    public void ForceDestroySession_EmptySession_ShouldReturnEmptyConnectionIds()
    {
        // Arrange
        var session = _sessionService.CreateSession("connection-1").Session!;
        _sessionService.LeaveSession("connection-1");

        // Act
        var result = _sessionService.ForceDestroySession(session.Id);

        // Assert
        result.Should().NotBeNull();
        result!.ConnectionIds.Should().BeEmpty();
        _sessionService.GetSession(session.Id).Should().BeNull();
    }

    [Fact]
    public void ForceDestroySession_NonExistentSession_ShouldReturnNull()
    {
        // Act
        var result = _sessionService.ForceDestroySession(Guid.NewGuid());

        // Assert
        result.Should().BeNull();
    }
}
