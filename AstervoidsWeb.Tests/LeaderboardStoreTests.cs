using AstervoidsWeb.Identity;
using AstervoidsWeb.Leaderboards;
using static AstervoidsWeb.Tests.LeaderboardTestState;

namespace AstervoidsWeb.Tests;

public class LeaderboardStoreTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AllEightWildcardExactCombinationsReturnOnlyTheirOrderedRows(bool azure)
    {
        using var state = new LeaderboardTestState(azure);
        var records = new List<LeaderboardRecord>();
        foreach (var team in new[] { 1, 2 })
        foreach (var ratio in new[] { 0.5, 1.0, 2.0 })
        foreach (var difficulty in new[] { 0.2, 0.35, 0.42 })
        {
            var record = Record(score: (uint)records.Count * 7, wave: records.Count + 1,
                teamSize: team, aspectRatio: ratio, difficulty: difficulty, name: $"Pilot{records.Count}");
            records.Add(record);
            Assert.True(await state.Store.TryCommitAsync(null, record, default));
        }

        for (var mask = 0; mask < 8; mask++)
        {
            var team = (mask & 1) == 0 ? (int?)null : 2;
            var aspect = (mask & 2) == 0 ? null : "landscape";
            var difficulty = (mask & 4) == 0 ? (double?)null : 0.35;
            var query = new LeaderboardQueryRequest(team, aspect, difficulty);
            var expected = Ordered(records.Where(record =>
                (team is null || record.TeamSize == team)
                && (aspect is null || record.Aspect == aspect)
                && (difficulty is null || record.Difficulty == difficulty))).Take(5).ToArray();
            var actual = await state.RestartStore().QueryAsync(query, 5, default);
            Assert.Equal(expected, actual);
        }
        Assert.Equal(6, (await state.Store.QueryAsync(new(null, null, 0.42), 50, default)).Count);
        Assert.Empty(await state.Store.QueryAsync(new(null, null, 0.35000000000000003), 50, default));
        Assert.Equal(records.Count, (await state.Store.QueryAsync(new(), 50, default)).Count);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ExactTopLimitUsesScoreThenNormalizedPlayerThenRunAndNotWave(bool azure)
    {
        using var state = new LeaderboardTestState(azure);
        var player1 = Guid.Parse("00000001-0000-0000-0000-000000000001");
        var player2 = Guid.Parse("ABCDEF01-0000-0000-0000-000000000001");
        var run1 = Guid.Parse("00000001-0000-0000-0000-000000000001");
        var run2 = Guid.Parse("ABCDEF02-0000-0000-0000-000000000001");
        var records = new[]
        {
            Record(player2, run2, score: 100, wave: 100),
            Record(player1, run2, score: 100, wave: 999),
            Record(player1, run1, score: 100, wave: 1),
            Record(score: uint.MaxValue),
            Record(score: 0)
        };
        foreach (var record in records)
            Assert.True(await state.Store.TryCommitAsync(null, record, default));
        var ordered = Ordered(records).ToArray();
        Assert.Equal(records[3], ordered[0]);
        Assert.Equal(records[2], ordered[1]);
        Assert.Equal(records[1], ordered[2]);
        Assert.Equal(records[0], ordered[3]);
        Assert.Equal(records[4], ordered[4]);
        Assert.Equal(ordered.Take(3), await state.Store.QueryAsync(new(), 3, default));
        Assert.Equal(ordered, await state.RestartStore().QueryAsync(new(), 500, default));
        var reply = Read<LeaderboardQueryReply>(await state.Service(limit: 3).QueryAsync(new()));
        Assert.Equal(new[] { 1, 2, 3 }, reply.Entries.Select(entry => entry.Rank));
        Assert.Equal(new uint[] { uint.MaxValue, 100, 100 }, reply.Entries.Select(entry => entry.Score));
        Assert.Contains(":0000000000:", LeaderboardRows.RankKey(records[3], new()));
        Assert.Contains(":4294967295:", LeaderboardRows.RankKey(records[4], new()));
        Assert.DoesNotContain("ABCDEF", LeaderboardRows.CanonicalKey(records[0]));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task StaleCanonicalCasCannotPartiallyReplaceIndexesOrRegressWinningMetadata(bool azure)
    {
        using var state = new LeaderboardTestState(azure);
        var original = Record(score: 100, wave: 2, teamSize: 1, aspectRatio: 0.5, difficulty: 0.2);
        Assert.True(await state.Store.TryCommitAsync(null, original, default));
        var stale = (await state.RestartStore().ReadAsync(original.PlayerId, original.RunId, default))!;
        var player = new PlayerIdentity(original.PlayerId, original.Name);
        var winning = Submission(player.Id, original.RunId, score: 200, wave: 1, aspectRatio: 2, difficulty: 0.35);
        Assert.True(await state.Store.TryCommitAsync(stale, LeaderboardRules.Merge(stale, player, winning), default));
        var largerTeam = winning with { Score = 50, Wave = 99, TeamSize = 4, AspectRatio = 1, Difficulty = 2 };
        Assert.False(await state.RestartStore().TryCommitAsync(
            stale, LeaderboardRules.Merge(stale, player, largerTeam), default));
        Assert.False(await state.Store.TryCommitAsync(null, original, default));
        var current = (await state.Store.ReadAsync(original.PlayerId, original.RunId, default))!;
        Assert.Equal(200u, current.Score);
        Assert.Equal(1, current.TeamSize);
        Assert.True(await state.RestartStore().TryCommitAsync(
            current, LeaderboardRules.Merge(current, player, largerTeam), default));
        var final = Assert.Single(await state.RestartStore().QueryAsync(new(), 50, default));
        Assert.Equal(200u, final.Score);
        Assert.Equal(1, final.Wave);
        Assert.Equal(4, final.TeamSize);
        Assert.Equal(0.35, final.Difficulty);
        Assert.Equal("landscape", final.Aspect);
        Assert.Empty(await state.Store.QueryAsync(new(1), 50, default));
        Assert.Single(await state.Store.QueryAsync(new(4, "landscape", 0.35), 50, default));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SharedStorageContractRejectsRegressiveOrUnconditionalWrites(bool azure)
    {
        using var state = new LeaderboardTestState(azure);
        var original = Record(score: 100, wave: 3, teamSize: 3);
        Assert.True(await state.Store.TryCommitAsync(null, original, default));
        var previous = (await state.Store.ReadAsync(original.PlayerId, original.RunId, default))!;
        var next = previous with { Version = Guid.NewGuid().ToString("N"), StorageEtag = null };
        foreach (var invalid in new[]
        {
            next with { Score = 99 }, next with { Wave = 2 }, next with { TeamSize = 2 },
            next with { AspectRatio = 2 }, next with { Difficulty = 0.2 }, next with { Name = "Changed" },
            next with { RunId = Guid.NewGuid() }, next with { Version = original.Version }
        })
            await Assert.ThrowsAsync<LeaderboardStoreUnavailableException>(() =>
                state.Store.TryCommitAsync(previous, invalid, default));
        await Assert.ThrowsAsync<LeaderboardStoreUnavailableException>(() =>
            state.Store.TryCommitAsync(previous with { StorageEtag = "*" }, next, default));
        await Assert.ThrowsAsync<LeaderboardStoreUnavailableException>(() =>
            state.Store.TryCommitAsync(previous with { StorageEtag = null }, next, default));
        Assert.Equal(original, Assert.Single(await state.Store.QueryAsync(new(), 50, default)));
    }

    [Theory]
    [InlineData(0.7499999999999999, "portrait")]
    [InlineData(0.75, "square")]
    [InlineData(1.3333333333333333, "square")]
    [InlineData(1.3333333333333335, "landscape")]
    public void AspectBoundariesAreInclusiveOnlyInTheMiddle(double ratio, string expected) =>
        Assert.Equal(expected, LeaderboardRules.ClassifyAspect(ratio));

    private static IOrderedEnumerable<LeaderboardRecord> Ordered(IEnumerable<LeaderboardRecord> records) =>
        records.OrderByDescending(record => record.Score)
            .ThenBy(record => record.PlayerId.ToString("N"), StringComparer.Ordinal)
            .ThenBy(record => record.RunId.ToString("N"), StringComparer.Ordinal);
}
