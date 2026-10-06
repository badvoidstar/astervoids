using System.Text.Json;
using AstervoidsWeb.Configuration;
using AstervoidsWeb.Identity;
using Azure;
using Azure.Data.Tables;
using Microsoft.Extensions.Options;
using static AstervoidsWeb.Tests.IdentityTestState;

namespace AstervoidsWeb.Tests;

public class PlayerIdentityServiceTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ConcurrentResolve_InsertsOneUnboundBrowser_WithoutIssuingAnIdentity(bool azure)
    {
        using var state = new IdentityTestState(azure);
        var browser = IdentitySecrets.NewToken();
        var results = await Task.WhenAll(Enumerable.Range(0, 24).Select(_ =>
            Task.Run(() => Resolve(state.Restart(), browser))));

        Assert.All(results, result =>
        {
            Assert.Null(result.Binding.Identity);
            Assert.Equal(0, result.Binding.Revision);
            Assert.Equal(results[0].Binding.Etag, result.Binding.Etag);
            Assert.Null(result.Invite);
            Assert.True(result.PromptOnRoot);
        });
    }

    [Theory]
    [InlineData(false, "A_b-1234")]
    [InlineData(true, "A_b-1234")]
    [InlineData(false, "A_b-12345")]
    [InlineData(true, "A_b-12345")]
    [InlineData(false, "A_b-123456")]
    [InlineData(true, "A_b-123456")]
    public async Task PromptDisabled_StaysAnonymous_UntilExplicitRootNaming(bool azure, string tag)
    {
        using var state = new IdentityTestState(azure);
        var browser = IdentitySecrets.NewToken();
        var service = state.Service(prompt: false);
        var resolved = await Resolve(service, browser);
        Assert.False(resolved.PromptOnRoot);
        Assert.Null(resolved.Binding.Identity);

        var (binding, _) = await Root(service, browser, tag);
        Assert.Equal(tag, binding.Identity!.Tag);
        Assert.Equal(1, binding.Revision);
        Assert.Equal(binding, (await Resolve(state.Restart(), browser)).Binding);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RootConcurrentExactRetry_ReturnsOneCommittedIdentityAndIdenticalBinding(bool azure)
    {
        using var state = new IdentityTestState(azure);
        var browser = IdentitySecrets.NewToken();
        var binding = (await Resolve(state.Service(), browser)).Binding;
        var request = new RootIdentityRequest(Guid.NewGuid(), Expect(binding), "Pilot");
        var results = await Task.WhenAll(Enumerable.Range(0, 16).Select(_ =>
            Task.Run(() => state.Restart().CreateRootAsync(browser, request))));
        var first = Read<BindingReply>(results[0], 201);
        Assert.All(results, result => Assert.Equal(first, Read<BindingReply>(result, 201)));
        Assert.Equal(1, first.Binding.Revision);
        Assert.Equal(first.Binding, (await Resolve(state.Restart(), browser)).Binding);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CompetingRootRequests_OnlyOneWins_WithoutRenaming(bool azure)
    {
        using var state = new IdentityTestState(azure);
        var browser = IdentitySecrets.NewToken();
        var expected = Expect((await Resolve(state.Service(), browser)).Binding);
        var results = await Task.WhenAll(new[] { "One", "Two" }.Select(tag =>
            Task.Run(() => state.Restart().CreateRootAsync(browser, new(Guid.NewGuid(), expected, tag)))));
        var winner = Assert.Single(results, result => result.Succeeded);
        Error(Assert.Single(results, result => !result.Succeeded), "binding_changed");
        Assert.Equal(Read<BindingReply>(winner, 201).Binding, (await Resolve(state.Service(), browser)).Binding);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RequestIdCannotBeReusedForAnotherBodyOrOperation(bool azure)
    {
        using var state = new IdentityTestState(azure);
        var browser = IdentitySecrets.NewToken();
        var service = state.Service();
        var (_, request) = await Root(service, browser);
        Error(await service.CreateRootAsync(browser, request with { Tag = "Other" }), "request_reused");
        Error(await service.CreateInviteAsync(browser, new(request.RequestId)), "request_reused");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task FriendInvite_IsPendingDistinctAndIdempotent_WithoutRebindingCreator(bool azure)
    {
        using var state = new IdentityTestState(azure);
        var service = state.Service();
        var browser = IdentitySecrets.NewToken();
        var (creator, _) = await Root(service, browser);
        var request = new CreateInviteRequest(Guid.NewGuid());
        var created = Read<InviteTokenReply>(await service.CreateInviteAsync(browser, request), 201);
        Assert.Equal(created, Read<InviteTokenReply>(await service.CreateInviteAsync(browser, request), 201));
        Assert.True(IdentitySecrets.IsToken(created.InviteToken));
        var resolved = await Resolve(state.Restart(), browser, created.InviteToken);
        Assert.Equal(creator, resolved.Binding);
        Assert.Equal("pending", resolved.Invite!.State);
        Assert.Null(resolved.Invite.Tag);
        Assert.NotEqual(creator.Identity!.Id, resolved.Invite.IdentityId);

        var another = Read<InviteTokenReply>(
            await service.CreateInviteAsync(browser, new(Guid.NewGuid())), 201);
        Assert.NotEqual(created.InviteToken, another.InviteToken);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task FirstClaimRace_LoserCannotRenameOrBind_AndCanExplicitlyConfirmWinner(bool azure)
    {
        using var state = new IdentityTestState(azure);
        var service = state.Service();
        var creator = IdentitySecrets.NewToken();
        await Root(service, creator);
        var token = Read<InviteTokenReply>(
            await service.CreateInviteAsync(creator, new(Guid.NewGuid())), 201).InviteToken;
        var browsers = new[] { IdentitySecrets.NewToken(), IdentitySecrets.NewToken() };
        var resolved = await Task.WhenAll(browsers.Select(browser => Resolve(service, browser, token)));
        var requests = resolved.Select((view, index) => new AcceptInviteRequest(
            Guid.NewGuid(), token, view.Invite!.Etag, Expect(view.Binding), $"Pilot{index}")).ToArray();
        var outcomes = await Task.WhenAll(browsers.Select((browser, index) =>
            Task.Run(() => state.Restart().AcceptInviteAsync(browser, requests[index]))));

        var winnerIndex = Array.FindIndex(outcomes, outcome => outcome.Succeeded);
        Assert.InRange(winnerIndex, 0, 1);
        var loserIndex = 1 - winnerIndex;
        var winner = Read<BindingReply>(outcomes[winnerIndex]).Binding;
        Error(outcomes[loserIndex], "invite_changed");
        var loserView = await Resolve(service, browsers[loserIndex], token);
        Assert.Equal(resolved[loserIndex].Binding, loserView.Binding);
        Assert.Equal($"Pilot{winnerIndex}", loserView.Invite!.Tag);
        Assert.Equal("active", loserView.Invite.State);
        Assert.Equal(winner, Read<BindingReply>(
            await service.AcceptInviteAsync(browsers[winnerIndex], requests[winnerIndex])).Binding);

        var confirm = requests[loserIndex] with
        {
            RequestId = Guid.NewGuid(), ExpectedInviteEtag = loserView.Invite.Etag, Tag = null
        };
        var confirmed = Read<BindingReply>(
            await service.AcceptInviteAsync(browsers[loserIndex], confirm)).Binding;
        Assert.Equal(winner.Identity, confirmed.Identity);
        Assert.Equal(token, await Self(service, browsers[loserIndex], confirmed));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task FailedExpectedBinding_DoesNotNameInviteOrConsumeRequestId(bool azure)
    {
        using var state = new IdentityTestState(azure);
        var service = state.Service();
        var creator = IdentitySecrets.NewToken();
        await Root(service, creator);
        var token = Read<InviteTokenReply>(
            await service.CreateInviteAsync(creator, new(Guid.NewGuid())), 201).InviteToken;
        var browser = IdentitySecrets.NewToken();
        var before = await Resolve(service, browser, token);
        var (ownIdentity, _) = await Root(service, browser, "Original");
        var request = new AcceptInviteRequest(Guid.NewGuid(), token,
            before.Invite!.Etag, Expect(before.Binding), "Invited");

        Error(await service.AcceptInviteAsync(browser, request), "binding_changed");
        var unchanged = await Resolve(service, browser, token);
        Assert.Equal("pending", unchanged.Invite!.State);
        Assert.Equal(before.Invite, unchanged.Invite);
        Assert.Equal(ownIdentity, unchanged.Binding);
        var retry = request with { ExpectedBinding = Expect(unchanged.Binding) };
        Assert.Equal("Invited", Read<BindingReply>(await service.AcceptInviteAsync(browser, retry))
            .Binding.Identity!.Tag);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ConflictingReplacements_CannotOverwriteBrowser_OrReplayOldBinding(bool azure)
    {
        using var state = new IdentityTestState(azure);
        var service = state.Service();
        var browser = IdentitySecrets.NewToken();
        var (original, originalRequest) = await Root(service, browser, "Original");
        var tokenOriginal = await Self(service, browser, original);
        var inviter = IdentitySecrets.NewToken();
        var (replacement, _) = await Root(service, inviter, "Next");
        var tokenNext = await Self(service, inviter, replacement);
        var tokenThird = Read<InviteTokenReply>(
            await service.CreateInviteAsync(inviter, new(Guid.NewGuid())), 201).InviteToken;
        var viewNext = await Resolve(service, browser, tokenNext);
        var viewThird = await Resolve(service, browser, tokenThird);
        var requests = new[]
        {
            new AcceptInviteRequest(Guid.NewGuid(), tokenNext, viewNext.Invite!.Etag, Expect(original)),
            new AcceptInviteRequest(Guid.NewGuid(), tokenThird, viewThird.Invite!.Etag, Expect(original), "Third")
        };
        var outcomes = await Task.WhenAll(requests.Select(request =>
            Task.Run(() => state.Restart().AcceptInviteAsync(browser, request))));
        var winner = Read<BindingReply>(Assert.Single(outcomes, outcome => outcome.Succeeded)).Binding;
        Error(Assert.Single(outcomes, outcome => !outcome.Succeeded), "binding_changed");
        Assert.Equal(2, winner.Revision);
        Error(await service.CreateRootAsync(browser, originalRequest), "binding_changed");
        Error(await service.SelfInviteAsync(browser, new(Expect(original))), "binding_changed");
        Assert.Equal(winner, (await Resolve(service, browser)).Binding);

        // Even a later return to the same identity cannot revive its old receipt.
        var old = await Resolve(service, browser, tokenOriginal);
        var returned = Read<BindingReply>(await service.AcceptInviteAsync(browser,
            new(Guid.NewGuid(), tokenOriginal, old.Invite!.Etag, Expect(winner)))).Binding;
        Assert.Equal(original.Identity, returned.Identity);
        Assert.Equal(3, returned.Revision);
        Error(await service.CreateRootAsync(browser, originalRequest), "binding_changed");
        Assert.Equal(returned, (await Resolve(service, browser)).Binding);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SameTokenSelfAndUnlimitedBrowserBindings_PreserveOriginalCapabilityAndImmutableName(bool azure)
    {
        using var state = new IdentityTestState(azure);
        var service = state.Service();
        var browser = IdentitySecrets.NewToken();
        var (original, _) = await Root(service, browser, "SameTag");
        var token = await Self(service, browser, original);
        Assert.Equal(token, await Self(state.Restart(), browser, original));
        Assert.Equal(original, (await Resolve(service, browser, token)).Binding);

        foreach (var index in Enumerable.Range(0, 12))
        {
            var other = IdentitySecrets.NewToken();
            var before = await Resolve(service, other, token);
            var request = new AcceptInviteRequest(
                Guid.NewGuid(), token, before.Invite!.Etag, Expect(before.Binding));
            var bound = Read<BindingReply>(await service.AcceptInviteAsync(other, request)).Binding;
            Assert.Equal(original.Identity, bound.Identity);
            Assert.Equal(token, await Self(state.Restart(), other, bound));
        }
        var equivalent = await Resolve(service, browser, token);
        var confirmation = new AcceptInviteRequest(Guid.NewGuid(), token,
            equivalent.Invite!.Etag, Expect(equivalent.Binding));
        Assert.Equal(original, Read<BindingReply>(
            await service.AcceptInviteAsync(browser, confirmation)).Binding);
        Error(await service.AcceptInviteAsync(browser,
            confirmation with { RequestId = Guid.NewGuid(), Tag = "Renamed" }), "invalid_request", 400);

        var (sameTag, _) = await Root(service, IdentitySecrets.NewToken(), "SameTag");
        Assert.Equal(original.Identity!.Tag, sameTag.Identity!.Tag);
        Assert.NotEqual(original.Identity.Id, sameTag.Identity.Id);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RebindInvalidatesInviteCreationAndAcceptReceiptsWithoutReapplyingThem(bool azure)
    {
        using var state = new IdentityTestState(azure);
        var service = state.Service();
        var browser = IdentitySecrets.NewToken();
        await Root(service, browser);
        var inviteRequest = new CreateInviteRequest(Guid.NewGuid());
        var token = Read<InviteTokenReply>(await service.CreateInviteAsync(browser, inviteRequest), 201).InviteToken;
        var before = await Resolve(service, browser, token);
        var acceptRequest = new AcceptInviteRequest(
            Guid.NewGuid(), token, before.Invite!.Etag, Expect(before.Binding), "Second");
        var second = Read<BindingReply>(await service.AcceptInviteAsync(browser, acceptRequest)).Binding;
        Error(await service.CreateInviteAsync(browser, inviteRequest), "binding_changed");
        var thirdToken = Read<InviteTokenReply>(
            await service.CreateInviteAsync(browser, new(Guid.NewGuid())), 201).InviteToken;
        var next = await Resolve(service, browser, thirdToken);
        var third = Read<BindingReply>(await service.AcceptInviteAsync(browser,
            new(Guid.NewGuid(), thirdToken, next.Invite!.Etag, Expect(second), "Third"))).Binding;
        Error(await service.AcceptInviteAsync(browser, acceptRequest), "binding_changed");
        Assert.Equal(third, (await Resolve(service, browser)).Binding);
    }

    [Theory]
    [InlineData("")]
    [InlineData("12345678901")]
    [InlineData(" bad")]
    [InlineData("Bad Tag")]
    [InlineData("é")]
    [InlineData("漢字")]
    [InlineData("line\n")]
    [InlineData("A.")]
    public async Task InvalidTagsNeverCreateIdentities(string tag)
    {
        using var state = new IdentityTestState();
        var service = state.Service();
        var browser = IdentitySecrets.NewToken();
        var before = await Resolve(service, browser);
        Error(await service.CreateRootAsync(browser,
            new(Guid.NewGuid(), Expect(before.Binding), tag)), "invalid_tag", 400);
        Assert.Equal(before.Binding, (await Resolve(service, browser)).Binding);
    }

    [Theory]
    [InlineData("")]
    [InlineData("abc")]
    [InlineData("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")]
    [InlineData("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+")]
    [InlineData("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB")]
    public async Task BrowserCredentialsAndInvitesRequireCanonical32ByteBase64Url(string invalid)
    {
        using var state = new IdentityTestState();
        var service = state.Service();
        Error(await service.ResolveAsync(invalid, new()), "invalid_browser_credential", 401);
        Error(await service.ResolveAsync(IdentitySecrets.NewToken(), new(invalid)), "invalid_request", 400);
        Error(await service.SelfInviteAsync(invalid, new(new(null, "etag"))),
            "invalid_browser_credential", 401);
    }

    [Fact]
    public async Task MissingInviteAndUnboundBrowserHaveTypedErrors()
    {
        using var state = new IdentityTestState();
        var service = state.Service();
        var browser = IdentitySecrets.NewToken();
        var before = await Resolve(service, browser);
        Error(await service.ResolveAsync(browser, new(IdentitySecrets.NewToken())), "invite_not_found", 404);
        Error(await service.CreateInviteAsync(browser, new(Guid.NewGuid())), "identity_required");
        Error(await service.SelfInviteAsync(browser, new(Expect(before.Binding))), "identity_required");
        Error(await service.CreateRootAsync(browser, new(Guid.Empty, Expect(before.Binding), "Pilot")),
            "invalid_request", 400);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("invalid!")]
    [InlineData("12345678901")]
    public async Task PendingInviteRequiresValidTag_AndRetainsPendingStateOnFailure(string? tag)
    {
        using var state = new IdentityTestState();
        var service = state.Service();
        var creator = IdentitySecrets.NewToken();
        await Root(service, creator);
        var token = Read<InviteTokenReply>(
            await service.CreateInviteAsync(creator, new(Guid.NewGuid())), 201).InviteToken;
        var browser = IdentitySecrets.NewToken();
        var before = await Resolve(service, browser, token);
        Error(await service.AcceptInviteAsync(browser,
            new(Guid.NewGuid(), token, before.Invite!.Etag, Expect(before.Binding), tag)), "invalid_tag", 400);
        Assert.Equal(before, await Resolve(service, browser, token));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PendingInviteAcceptsTenCharacterTag_AndPersistsAfterRestart(bool azure)
    {
        using var state = new IdentityTestState(azure);
        var service = state.Service();
        var creator = IdentitySecrets.NewToken();
        await Root(service, creator);
        var token = Read<InviteTokenReply>(
            await service.CreateInviteAsync(creator, new(Guid.NewGuid())), 201).InviteToken;
        var browser = IdentitySecrets.NewToken();
        var before = await Resolve(service, browser, token);
        const string tag = "A_b-123456";
        var accepted = Read<BindingReply>(await service.AcceptInviteAsync(browser,
            new(Guid.NewGuid(), token, before.Invite!.Etag, Expect(before.Binding), tag))).Binding;

        Assert.Equal(tag, accepted.Identity!.Tag);
        var restored = await Resolve(state.Restart(), browser, token);
        Assert.Equal(accepted, restored.Binding);
        Assert.Equal(tag, restored.Invite!.Tag);
        Assert.Equal("active", restored.Invite.State);
    }

    [Fact]
    public async Task AzureTransactions_UseOnePartitionAndNativeEtags_WithoutRawBrowserKeys()
    {
        using var state = new IdentityTestState(azure: true);
        var browser = IdentitySecrets.NewToken();
        var (binding, request) = await Root(state.Service(), browser);
        var root = Assert.Single(state.Table!.Transactions, transaction => transaction.Count == 4);
        Assert.All(root, action => Assert.Equal("identity", action.Entity.PartitionKey));
        Assert.Equal(3, root.Count(action => action.ActionType == TableTransactionActionType.Add));
        var replacement = Assert.Single(root, action => action.ActionType == TableTransactionActionType.UpdateReplace);
        Assert.NotEqual(ETag.All, replacement.ETag);
        Assert.NotEqual(binding.Etag, replacement.ETag.ToString());
        Assert.StartsWith("\"storage-", replacement.ETag.ToString());
        var rows = state.Table.Snapshot();
        Assert.Contains(rows, row => row.RowKey == IdentityRows.OperationKey(IdentitySecrets.Hash(browser), request.RequestId));
        Assert.All(rows, row =>
        {
            Assert.DoesNotContain(browser, row.RowKey);
            Assert.DoesNotContain(browser, row.GetString("Payload"));
        });
        var identity = rows.Single(row => row.RowKey.StartsWith("I:", StringComparison.Ordinal));
        Assert.Equal("active", JsonDocument.Parse(identity.GetString("Payload")).RootElement.GetProperty("state").GetString());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AzureTransactionFailure_NeverReturnsSuccess_AndRetryRecoversAtomicOutcome(bool ambiguousCommit)
    {
        using var state = new IdentityTestState(azure: true);
        var service = state.Service();
        var browser = IdentitySecrets.NewToken();
        var before = await Resolve(service, browser);
        var request = new RootIdentityRequest(Guid.NewGuid(), Expect(before.Binding), "Durable");
        state.Table!.FailNextCommit = 503;
        state.Table.CommitBeforeFailure = ambiguousCommit;
        Error(await service.CreateRootAsync(browser, request), "identity_unavailable", 503);
        var rowsAfterFailure = state.Table.Snapshot();
        Assert.Equal(ambiguousCommit ? 4 : 1, rowsAfterFailure.Count);
        var root = Read<BindingReply>(await state.Restart().CreateRootAsync(browser, request), 201).Binding;
        Assert.Equal(root, (await Resolve(state.Restart(), browser)).Binding);
        Assert.Equal(4, state.Table.Snapshot().Count);
    }

    [Fact]
    public async Task AzureMissingTable_IsUnavailableWithoutLocalFallback()
    {
        using var state = new IdentityTestState(azure: true);
        state.Table!.MissingTable = true;
        Error(await state.Service().ResolveAsync(IdentitySecrets.NewToken(), new()),
            "identity_unavailable", 503);
        Assert.Empty(state.Table.Snapshot());
        Assert.False(File.Exists(state.DataFile));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task BrowserChangesDuringClaimTransaction_RollBackNamingAndReceipt(bool azure)
    {
        using var state = new IdentityTestState(azure);
        var service = state.Service();
        var creator = IdentitySecrets.NewToken();
        await Root(service, creator);
        var token = Read<InviteTokenReply>(
            await service.CreateInviteAsync(creator, new(Guid.NewGuid())), 201).InviteToken;
        var browser = IdentitySecrets.NewToken();
        var before = await Resolve(service, browser, token);
        var gate = new GatedIdentityStore(state.Store,
            writes => writes.Any(write => write.Row is PlayerIdentityRow && write.ExpectedStorageEtag is not null));
        var gatedService = new PlayerIdentityService(gate, Options.Create(new IdentitySettings()));
        var claim = new AcceptInviteRequest(
            Guid.NewGuid(), token, before.Invite!.Etag, Expect(before.Binding), "Claim");
        var claiming = gatedService.AcceptInviteAsync(browser, claim);
        await gate.Reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
        BrowserBinding root;
        try
        {
            (root, _) = await Root(service, browser, "Original");
        }
        finally
        {
            gate.Release.TrySetResult();
        }
        Error(await claiming, "binding_changed");
        var after = await Resolve(state.Restart(), browser, token);
        Assert.Equal(root, after.Binding);
        Assert.Equal(before.Invite, after.Invite);
        Assert.Null(await state.Store.ReadAsync(
            IdentityRows.OperationKey(IdentitySecrets.Hash(browser), claim.RequestId), default));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task LateUnboundResolveInsertCannotResetAnAlreadyNamedBrowser(bool azure)
    {
        using var state = new IdentityTestState(azure);
        var browser = IdentitySecrets.NewToken();
        var gate = new GatedIdentityStore(state.Store,
            writes => writes.Count == 1 && writes[0].Row is BrowserIdentityRow);
        var gated = new PlayerIdentityService(gate, Options.Create(new IdentitySettings()));
        var resolving = gated.ResolveAsync(browser, new());
        await gate.Reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
        BrowserBinding named;
        try
        {
            (named, _) = await Root(state.Service(), browser);
        }
        finally
        {
            gate.Release.TrySetResult();
        }
        Assert.Equal(named, Read<ResolveIdentityReply>(await resolving).Binding);
        Assert.Equal(named, (await Resolve(state.Restart(), browser)).Binding);
    }

    [Fact]
    public async Task AzureAmbiguousInsertConflictReplaysCommittedReceipt()
    {
        using var state = new IdentityTestState(azure: true);
        var browser = IdentitySecrets.NewToken();
        var before = await Resolve(state.Service(), browser);
        state.Table!.CommitBeforeFailure = true;
        state.Table.FailNextCommit = 409;
        var result = await state.Service().CreateRootAsync(browser,
            new(Guid.NewGuid(), Expect(before.Binding), "Pilot"));
        Assert.Equal(201, result.StatusCode);
        Assert.Equal(4, state.Table.Snapshot().Count);
    }
}
