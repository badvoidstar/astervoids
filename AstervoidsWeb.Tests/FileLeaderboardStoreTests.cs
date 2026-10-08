using System.Text.Json.Nodes;
using AstervoidsWeb.Leaderboards;
using static AstervoidsWeb.Tests.LeaderboardTestState;

namespace AstervoidsWeb.Tests;

public class FileLeaderboardStoreTests
{
    [Fact]
    public async Task ReopeningPreservesCanonicalRecordsAllIndexesAndSeparatesIdentityData()
    {
        using var state = new LeaderboardTestState();
        var (browser, player) = await state.Player("Persist");
        var identityBefore = await File.ReadAllTextAsync(state.Identity.DataFile);
        var request = Submission(player.Id, score: 0, teamSize: 3, aspectRatio: 2, difficulty: 0.42);
        Recorded(await state.Service().SubmitAsync(browser, request));
        var record = await state.RestartStore().ReadAsync(player.Id, request.RunId, default);
        Assert.NotNull(record);
        Assert.Equal(record.Version, record.StorageEtag);
        Assert.Equal(record with { StorageEtag = null },
            Assert.Single(await state.RestartStore().QueryAsync(new(3, "landscape", 0.42), 50, default)));
        Assert.Equal(identityBefore, await File.ReadAllTextAsync(state.Identity.DataFile));
        var text = await File.ReadAllTextAsync(state.DataFile);
        Assert.DoesNotContain(browser, text);
        Assert.DoesNotContain("inviteToken", text);
        Assert.DoesNotContain("binding", text);
        Assert.DoesNotContain("storageEtag", text);
        Assert.Equal(9, JsonNode.Parse(text)!["rows"]!.AsObject().Count);
        Assert.Empty(Directory.GetFiles(state.Identity.DirectoryPath, "*.write"));
        Assert.True(File.Exists(state.DataFile + ".lock"));
        Assert.Equal(state.Identity.DataFile + ".leaderboard.json", state.DataFile);
        Assert.NotEqual(LeaderboardHosting.CompanionDataFile("same.json"), LeaderboardHosting.CompanionDataFile("same.data"));
    }

    [Theory]
    [InlineData("")]
    [InlineData("not json")]
    [InlineData("null")]
    [InlineData("{}")]
    [InlineData("{\"formatVersion\":2,\"rows\":{}}")]
    [InlineData("{\"formatVersion\":1,\"rows\":null}")]
    [InlineData("{\"formatVersion\":1,\"rows\":{\"invalid\":null}}")]
    [InlineData("{\"formatVersion\":1,\"rows\":{},\"rows\":{}}")]
    [InlineData("{\"formatVersion\":1,\"formatVersion\":1,\"rows\":{}}")]
    [InlineData("{\"formatVersion\":1,\"rows\":{},\"unknown\":0}")]
    public async Task InvalidExistingFileFailsClosedWithoutResetOrReplacement(string corrupt)
    {
        using var state = new LeaderboardTestState();
        Directory.CreateDirectory(state.Identity.DirectoryPath);
        await File.WriteAllTextAsync(state.DataFile, corrupt);
        var record = Record();
        await Assert.ThrowsAsync<LeaderboardStoreUnavailableException>(() =>
            state.RestartStore().ReadAsync(record.PlayerId, record.RunId, default));
        await Assert.ThrowsAsync<LeaderboardStoreUnavailableException>(() =>
            state.RestartStore().QueryAsync(new(), 50, default));
        await Assert.ThrowsAsync<LeaderboardStoreUnavailableException>(() =>
            state.RestartStore().TryCommitAsync(null, record, default));
        Assert.Equal(corrupt, await File.ReadAllTextAsync(state.DataFile));
        Assert.Empty(Directory.GetFiles(state.Identity.DirectoryPath, "*.write"));
    }

    [Theory]
    [InlineData("missing-index")]
    [InlineData("orphan-index")]
    [InlineData("stale-index")]
    [InlineData("bad-key")]
    [InlineData("empty-player")]
    [InlineData("invalid-name")]
    [InlineData("invalid-score")]
    [InlineData("invalid-wave")]
    [InlineData("invalid-team")]
    [InlineData("invalid-ratio")]
    [InlineData("invalid-difficulty")]
    [InlineData("invalid-version")]
    [InlineData("unknown-field")]
    [InlineData("ignored-etag")]
    [InlineData("ignored-aspect")]
    public async Task CorruptCanonicalOrIndexRowsNeverProducePartialLeaderboards(string corruption)
    {
        using var state = new LeaderboardTestState();
        var record = Record();
        Assert.True(await state.Store.TryCommitAsync(null, record, default));
        var document = JsonNode.Parse(await File.ReadAllTextAsync(state.DataFile))!;
        var rows = document["rows"]!.AsObject();
        var canonicalKey = LeaderboardRows.CanonicalKey(record);
        var indexKey = LeaderboardRows.IndexKeys(record)[0];
        switch (corruption)
        {
            case "missing-index": rows.Remove(indexKey); break;
            case "orphan-index": rows.Remove(canonicalKey); break;
            case "stale-index": rows[indexKey]!["wave"] = record.Wave + 1; break;
            case "bad-key":
                var value = rows[canonicalKey];
                rows.Remove(canonicalKey);
                rows["C:invalid"] = value;
                break;
            case "empty-player": rows[canonicalKey]!["playerId"] = Guid.Empty.ToString(); break;
            case "invalid-name": rows[canonicalKey]!["name"] = "not a tag"; break;
            case "invalid-score": rows[canonicalKey]!["score"] = -1; break;
            case "invalid-wave": rows[canonicalKey]!["wave"] = 0; break;
            case "invalid-team": rows[canonicalKey]!["teamSize"] = 0; break;
            case "invalid-ratio": rows[canonicalKey]!["aspectRatio"] = 0; break;
            case "invalid-difficulty": rows[canonicalKey]!["difficulty"] = 3; break;
            case "invalid-version": rows[canonicalKey]!["version"] = "not-a-version"; break;
            case "unknown-field": rows[canonicalKey]!["private"] = "not-allowed"; break;
            case "ignored-etag": rows[canonicalKey]!["storageEtag"] = "*"; break;
            case "ignored-aspect": rows[canonicalKey]!["aspect"] = "portrait"; break;
        }
        var corrupt = document.ToJsonString();
        await File.WriteAllTextAsync(state.DataFile, corrupt);
        Error(await state.Service().QueryAsync(new()), "leaderboard_unavailable", 503);
        await Assert.ThrowsAsync<LeaderboardStoreUnavailableException>(() =>
            state.Store.TryCommitAsync(null, Record(), default));
        Assert.Equal(corrupt, await File.ReadAllTextAsync(state.DataFile));
    }

    [Fact]
    public async Task StableExclusiveLockCoordinatesIndependentInstancesAndAtomicReplacement()
    {
        using var state = new LeaderboardTestState();
        var record = Record();
        Assert.True(await state.Store.TryCommitAsync(null, record, default));
        var previous = (await state.Store.ReadAsync(record.PlayerId, record.RunId, default))!;
        var next = previous with { Score = 200, Version = Guid.NewGuid().ToString("N"), StorageEtag = null };
        using var held = new FileStream(state.DataFile + ".lock", FileMode.Open, FileAccess.ReadWrite, FileShare.None);
        var committing = state.RestartStore().TryCommitAsync(previous, next, default);
        await Task.Delay(50);
        Assert.False(committing.IsCompleted);
        held.Dispose();
        Assert.True(await committing);
        Assert.Equal(next, Assert.Single(await state.RestartStore().QueryAsync(new(), 50, default)));
        Assert.True(File.Exists(state.DataFile + ".lock"));
        Assert.Empty(Directory.GetFiles(state.Identity.DirectoryPath, "*.write"));
    }

    [Fact]
    public async Task CancellationWhileWaitingForLockDoesNotWriteOrRemoveCommittedData()
    {
        using var state = new LeaderboardTestState();
        var record = Record();
        Assert.True(await state.Store.TryCommitAsync(null, record, default));
        var before = await File.ReadAllTextAsync(state.DataFile);
        using (var held = new FileStream(state.DataFile + ".lock", FileMode.Open, FileAccess.ReadWrite, FileShare.None))
        using (var cancellation = new CancellationTokenSource())
        {
            var query = state.RestartStore().QueryAsync(new(), 50, cancellation.Token);
            await Task.Delay(30);
            Assert.False(query.IsCompleted);
            cancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => query);
        }
        Assert.Equal(before, await File.ReadAllTextAsync(state.DataFile));
        Assert.Single(await state.RestartStore().QueryAsync(new(), 50, default));
    }

    [Fact]
    public async Task DirectoryAtDataPathIsUnavailableNotAnEmptyLeaderboard()
    {
        using var state = new LeaderboardTestState();
        Directory.CreateDirectory(state.DataFile);
        Error(await state.Service().QueryAsync(new()), "leaderboard_unavailable", 503);
        Assert.True(Directory.Exists(state.DataFile));
    }
}
