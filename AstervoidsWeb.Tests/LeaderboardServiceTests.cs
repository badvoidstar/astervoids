using AstervoidsWeb.Identity;
using AstervoidsWeb.Leaderboards;
using static AstervoidsWeb.Tests.LeaderboardTestState;

namespace AstervoidsWeb.Tests;

public class LeaderboardServiceTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ExcludedPlayersNeverReachScoreStorageBeforeDuringOrAfterAutomationAndRebinding(bool azure)
    {
        using var state = new LeaderboardTestState(azure);
        var (browser, player) = await state.Player("SameTag", excludeFromLeaderboards: true);
        var service = state.Service();
        var request = Submission(player.Id, score: 0);
        Assert.Empty(Read<LeaderboardQueryReply>(await service.QueryAsync(new())).Entries);
        Error(await state.Service(store: new UnavailableLeaderboardStore()).SubmitAsync(browser, request),
            "leaderboard_ineligible", 403);
        Error(await service.SubmitAsync(browser, request), "leaderboard_ineligible", 403);
        Assert.Empty(Read<LeaderboardQueryReply>(await service.QueryAsync(new())).Entries);
        Assert.False(File.Exists(state.DataFile));
        if (state.Table is not null)
        {
            Assert.Equal(0, state.Table.ReadCount);
            Assert.Empty(state.Table.Transactions);
        }

        var (eligibleBrowser, eligible) = await state.Player("SameTag");
        Recorded(await service.SubmitAsync(eligibleBrowser, Submission(eligible.Id, score: 17)));
        var expected = new LeaderboardEntry(1, "SameTag", 17, 1, 0.65, 1, "square");
        foreach (var checkpoint in new uint[] { 1, 100, uint.MaxValue })
        {
            Error(await state.Service().SubmitAsync(browser, request with { Score = checkpoint }),
                "leaderboard_ineligible", 403);
            Assert.Equal(expected, Assert.Single(Read<LeaderboardQueryReply>(
                await state.Service().QueryAsync(new())).Entries));
            Assert.Equal(expected, Assert.Single(Read<LeaderboardQueryReply>(
                await state.Service().QueryAsync(new(1, "square", 0.65))).Entries));
        }

        var binding = (await IdentityTestState.Resolve(state.Identity.Restart(), browser)).Binding;
        var invitation = await IdentityTestState.Self(state.Identity.Restart(), browser, binding);
        var anotherBrowser = IdentitySecrets.NewToken();
        var view = await IdentityTestState.Resolve(state.Identity.Restart(), anotherBrowser, invitation);
        var accepted = IdentityTestState.Read<BindingReply>(await state.Identity.Restart().AcceptInviteAsync(
            anotherBrowser, new(Guid.NewGuid(), invitation, view.Invite!.Etag, IdentityTestState.Expect(view.Binding))));
        Assert.True(accepted.Binding.Identity!.ExcludeFromLeaderboards);
        var results = await Task.WhenAll(Enumerable.Range(0, 8).Select(index =>
            state.Service().SubmitAsync(index % 2 == 0 ? browser : anotherBrowser,
                request with { Score = uint.MaxValue })));
        Assert.All(results, result => Error(result, "leaderboard_ineligible", 403));
        Assert.Null(await state.RestartStore().ReadAsync(request.PlayerId, request.RunId, default));
        Assert.Equal(expected, Assert.Single(Read<LeaderboardQueryReply>(
            await state.Service().QueryAsync(new())).Entries));
        if (state.Table is not null)
        {
            Assert.Single(state.Table.Transactions);
            Assert.Equal(9, state.Table.Snapshot().Count);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task VerifiedIdentitySuppliesImmutableTagAndPublicQueryExposesOnlyRankedScoreMetadata(bool azure)
    {
        using var state = new LeaderboardTestState(azure);
        var (browser, player) = await state.Player("Exact_Tag");
        var request = Submission(player.Id, score: 0, wave: 1, teamSize: 7, aspectRatio: 0.5, difficulty: 0.42);
        Recorded(await state.Service(limit: 3, maxTeamSize: 7).SubmitAsync(browser, request));
        Recorded(await state.Service(limit: 3, maxTeamSize: 7).SubmitAsync(browser, request));
        var result = await state.Service(limit: 3, maxTeamSize: 7).QueryAsync(new());
        var reply = Read<LeaderboardQueryReply>(result);
        Assert.Equal(3, reply.Limit);
        Assert.Equal(7, reply.MaxTeamSize);
        Assert.Equal(new LeaderboardEntry(1, "Exact_Tag", 0, 1, 0.42, 7, "portrait"), Assert.Single(reply.Entries));
        Assert.DoesNotContain(player.Id.ToString(), result.Body.GetRawText());
        Assert.DoesNotContain(request.RunId.ToString(), result.Body.GetRawText());
        Assert.DoesNotContain(browser, result.Body.GetRawText());
        Assert.Equal(new[] { "entries", "limit", "maxTeamSize" },
            result.Body.EnumerateObject().Select(property => property.Name).Order().ToArray());
        Assert.Equal(new[] { "aspect", "difficulty", "name", "rank", "score", "teamSize", "wave" },
            result.Body.GetProperty("entries")[0].EnumerateObject().Select(property => property.Name).Order().ToArray());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task GuestsForgedCredentialsAndWrongIdentityCannotRecordOrCreateBindings(bool azure)
    {
        using var state = new LeaderboardTestState(azure);
        var (browser, player) = await state.Player();
        var request = Submission(player.Id);
        var forged = IdentitySecrets.NewToken();
        Error(await state.Service().SubmitAsync("bad-token", request), "invalid_browser_credential", 401);
        Error(await state.Service().SubmitAsync(forged, request), "identity_required");
        Assert.Null(await state.Identity.Store.ReadAsync(IdentityRows.BrowserKey(IdentitySecrets.Hash(forged)), default));
        var guest = IdentitySecrets.NewToken();
        await IdentityTestState.Resolve(state.Identity.Service(), guest);
        Error(await state.Service().SubmitAsync(guest, request), "identity_required");
        Error(await state.Service().SubmitAsync(browser, request with { PlayerId = Guid.NewGuid() }), "binding_changed");
        Assert.Empty(Read<LeaderboardQueryReply>(await state.Service().QueryAsync(new())).Entries);
        Assert.Null(await state.Store.ReadAsync(request.PlayerId, request.RunId, default));
        if (state.Table is not null)
            Assert.Empty(state.Table.Transactions);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task BestScoreWaveSnapshotAndIndependentTeamHighWaterSurviveReorderedRetries(bool azure)
    {
        using var state = new LeaderboardTestState(azure);
        var (browser, player) = await state.Player();
        var service = state.Service();
        var original = Submission(player.Id, score: 100, wave: 2, aspectRatio: 2, difficulty: 0.2);
        Recorded(await service.SubmitAsync(browser, original));
        var lower = original with { Score = 90, Wave = 99, TeamSize = 4, AspectRatio = 0.5, Difficulty = 2 };
        Recorded(await state.Service().SubmitAsync(browser, lower));
        Recorded(await service.SubmitAsync(browser, original with { AspectRatio = 0.5, Difficulty = 1 }));
        Assert.Equal(new LeaderboardEntry(1, "Pilot", 100, 2, 0.2, 4, "landscape"),
            Assert.Single(Read<LeaderboardQueryReply>(await service.QueryAsync(new())).Entries));
        Assert.Empty(Read<LeaderboardQueryReply>(await service.QueryAsync(new(1))).Entries);
        Assert.Empty(Read<LeaderboardQueryReply>(await service.QueryAsync(new(4, "portrait", 2))).Entries);

        var nextWave = original with { Wave = 3, TeamSize = 2, AspectRatio = 0.5, Difficulty = 0.35 };
        Recorded(await state.Service().SubmitAsync(browser, nextWave));
        Recorded(await state.Service().SubmitAsync(browser, original));
        Assert.Equal(new LeaderboardEntry(1, "Pilot", 100, 3, 0.35, 4, "portrait"),
            Assert.Single(Read<LeaderboardQueryReply>(await service.QueryAsync(new(4, "portrait", 0.35))).Entries));

        var higherScore = original with { Score = 101, Wave = 1, AspectRatio = 1, Difficulty = 0.42 };
        Recorded(await state.Service().SubmitAsync(browser, higherScore));
        Recorded(await service.SubmitAsync(browser, nextWave));
        Assert.Equal(new LeaderboardEntry(1, "Pilot", 101, 1, 0.42, 4, "square"),
            Assert.Single(Read<LeaderboardQueryReply>(await state.Service().QueryAsync(new())).Entries));
        if (state.Table is not null)
            Assert.Equal(9, state.Table.Snapshot().Count);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ConcurrentBindingsOfOnePlayerMergeOneRunWithoutRegressingScoreOrTeam(bool azure)
    {
        using var state = new LeaderboardTestState(azure);
        var (browser, player) = await state.Player();
        var identity = state.Identity.Service();
        var binding = (await IdentityTestState.Resolve(identity, browser)).Binding;
        var invitation = await IdentityTestState.Self(identity, browser, binding);
        var another = IdentitySecrets.NewToken();
        var view = await IdentityTestState.Resolve(identity, another, invitation);
        IdentityTestState.Read<BindingReply>(await identity.AcceptInviteAsync(another,
            new(Guid.NewGuid(), invitation, view.Invite!.Etag, IdentityTestState.Expect(view.Binding))));
        var original = Submission(player.Id, score: 200, wave: 3, aspectRatio: 2, difficulty: 0.35);
        var gate = new GatedLeaderboardStore(state.RestartStore());
        var pending = state.Service(store: gate).SubmitAsync(browser, original);
        await gate.Reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
        try
        {
            Recorded(await state.Service().SubmitAsync(another,
                original with { Score = 10, Wave = 1, TeamSize = 4, AspectRatio = 0.5, Difficulty = 0.2 }));
        }
        finally
        {
            gate.Release.TrySetResult();
        }
        Recorded(await pending);
        var retries = await Task.WhenAll(Enumerable.Range(0, 12).Select(index =>
            state.Service().SubmitAsync(index % 2 == 0 ? browser : another, original)));
        Assert.All(retries, Recorded);
        Assert.Equal(new LeaderboardEntry(1, "Pilot", 200, 3, 0.35, 4, "landscape"),
            Assert.Single(Read<LeaderboardQueryReply>(await state.Service().QueryAsync(new())).Entries));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AuthorizationIsBindingAtReadAndLaterRequestsCannotWriteTheSupersededPlayer(bool azure)
    {
        using var state = new LeaderboardTestState(azure);
        var (browser, player) = await state.Player("Original");
        var (otherBrowser, replacement) = await state.Player("Next");
        var identity = state.Identity.Service();
        var otherBinding = (await IdentityTestState.Resolve(identity, otherBrowser)).Binding;
        var invitation = await IdentityTestState.Self(identity, otherBrowser, otherBinding);
        var gate = new GatedLeaderboardStore(state.Store);
        var request = Submission(player.Id);
        var inFlight = state.Service(store: gate).SubmitAsync(browser, request);
        await gate.Reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
        try
        {
            var view = await IdentityTestState.Resolve(identity, browser, invitation);
            IdentityTestState.Read<BindingReply>(await identity.AcceptInviteAsync(browser,
                new(Guid.NewGuid(), invitation, view.Invite!.Etag, IdentityTestState.Expect(view.Binding))));
        }
        finally
        {
            gate.Release.TrySetResult();
        }
        Recorded(await inFlight);
        Error(await state.Service().SubmitAsync(browser, request with { Score = 500 }), "binding_changed");
        Recorded(await state.Service().SubmitAsync(browser, request with { PlayerId = replacement.Id, Score = 50 }));
        var reply = Read<LeaderboardQueryReply>(await state.Service().QueryAsync(new()));
        Assert.Equal(new[] { "Original", "Next" }, reply.Entries.Select(entry => entry.Name));
        Assert.Equal(new uint[] { 100, 50 }, reply.Entries.Select(entry => entry.Score));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(501)]
    public async Task InvalidConfiguredLimitOnlyDisablesLeaderboardOperations(int limit)
    {
        using var state = new LeaderboardTestState();
        Error(await state.Service(limit).QueryAsync(new()), "leaderboard_unavailable", 503);
        var (browser, player) = await state.Player();
        Error(await state.Service(limit).SubmitAsync(browser, Submission(player.Id)), "leaderboard_unavailable", 503);
        Assert.False(File.Exists(state.DataFile));
    }

    [Fact]
    public async Task InvalidMetadataIsRejectedBeforeLeaderboardStorageIsAccessed()
    {
        using var state = new LeaderboardTestState();
        var (browser, player) = await state.Player();
        var request = Submission(player.Id);
        var invalid = new[]
        {
            request with { PlayerId = Guid.Empty }, request with { RunId = Guid.Empty },
            request with { Wave = 0 }, request with { Wave = -1 },
            request with { TeamSize = 0 }, request with { TeamSize = 5 },
            request with { AspectRatio = 0 }, request with { AspectRatio = -1 },
            request with { AspectRatio = double.NaN }, request with { AspectRatio = double.PositiveInfinity },
            request with { Difficulty = 0.009 }, request with { Difficulty = 2.001 },
            request with { Difficulty = double.NaN }, request with { Difficulty = double.PositiveInfinity }
        };
        foreach (var candidate in invalid)
            Error(await state.Service().SubmitAsync(browser, candidate), "invalid_request", 400);
        foreach (var query in new[]
        {
            new LeaderboardQueryRequest(0), new(5), new(null, "Portrait"), new(null, ""),
            new(null, null, 0.009), new(null, null, 2.001), new(null, null, double.NaN),
            new(null, null, double.PositiveInfinity)
        })
            Error(await state.Service().QueryAsync(query), "invalid_request", 400);
        Assert.False(File.Exists(state.DataFile));
    }

    [Theory]
    [InlineData(0.01, double.Epsilon, "portrait")]
    [InlineData(2, double.MaxValue, "landscape")]
    [InlineData(0.42, 0.75, "square")]
    [InlineData(0.42, 1.3333333333333333, "square")]
    public async Task NumericExtremesAndCustomDifficultiesAreValid(double difficulty, double ratio, string aspect)
    {
        using var state = new LeaderboardTestState();
        var (browser, player) = await state.Player();
        Recorded(await state.Service().SubmitAsync(browser,
            Submission(player.Id, score: uint.MaxValue, wave: int.MaxValue, aspectRatio: ratio, difficulty: difficulty)));
        Assert.Equal(new LeaderboardEntry(1, "Pilot", uint.MaxValue, int.MaxValue, difficulty, 1, aspect),
            Assert.Single(Read<LeaderboardQueryReply>(await state.Service().QueryAsync(new(null, aspect, difficulty))).Entries));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AzureAmbiguousFailuresRemainRetryableAndNeverDuplicateRows(bool committed)
    {
        using var state = new LeaderboardTestState(azure: true);
        var (browser, player) = await state.Player();
        var request = Submission(player.Id);
        state.Table!.FailNextCommit = 503;
        state.Table.CommitBeforeFailure = committed;
        Error(await state.Service().SubmitAsync(browser, request), "leaderboard_unavailable", 503);
        Assert.Equal(committed ? 9 : 0, state.Table.Snapshot().Count);
        Recorded(await state.Service().SubmitAsync(browser, request));
        Assert.Equal(9, state.Table.Snapshot().Count);
        Assert.Single(Read<LeaderboardQueryReply>(await state.Service().QueryAsync(new())).Entries);
    }

    [Fact]
    public async Task AzureConflictRetryCountIsBoundedAndDuplicateWritesDoNotCauseTransactions()
    {
        using var state = new LeaderboardTestState(azure: true);
        var (browser, player) = await state.Player();
        var request = Submission(player.Id);
        state.Table!.ConflictingCommits = 100;
        Error(await state.Service().SubmitAsync(browser, request), "leaderboard_unavailable", 503);
        Assert.Equal(LeaderboardService.MaximumCommitAttempts, state.Table.Transactions.Count);
        state.Table.ConflictingCommits = 0;
        state.Table.FailNextCommit = 409;
        state.Table.CommitBeforeFailure = true;
        Recorded(await state.Service().SubmitAsync(browser, request));
        var transactions = state.Table.Transactions.Count;
        Recorded(await state.Service().SubmitAsync(browser, request));
        Assert.Equal(transactions, state.Table.Transactions.Count);
    }

    [Fact]
    public async Task UnavailableIdentityDoesNotPreventPublicQueriesButCannotAuthorizeScores()
    {
        using var state = new LeaderboardTestState();
        var identity = new PlayerIdentityService(new UnavailableIdentityStore(),
            Microsoft.Extensions.Options.Options.Create(new AstervoidsWeb.Configuration.IdentitySettings()));
        var service = state.Service(identities: identity);
        Assert.Empty(Read<LeaderboardQueryReply>(await service.QueryAsync(new())).Entries);
        Error(await service.SubmitAsync(IdentitySecrets.NewToken(), Submission(Guid.NewGuid())),
            "leaderboard_unavailable", 503);
        Assert.False(File.Exists(state.Identity.DataFile));
    }
}
