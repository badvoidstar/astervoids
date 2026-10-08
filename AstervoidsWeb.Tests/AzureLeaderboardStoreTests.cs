using System.Text.Json;
using System.Text.Json.Nodes;
using AstervoidsWeb.Identity;
using AstervoidsWeb.Leaderboards;
using Azure;
using Azure.Data.Tables;
using static AstervoidsWeb.Tests.LeaderboardTestState;

namespace AstervoidsWeb.Tests;

public class AzureLeaderboardStoreTests
{
    [Theory]
    [InlineData("wave", 9, 0, 9, 0)]
    [InlineData("team", 13, 4, 5, 4)]
    [InlineData("metadata", 16, 7, 2, 7)]
    [InlineData("score", 17, 8, 1, 8)]
    public async Task OverlappingIndexesAreReplacedInOneTransactionGuardedByCanonicalCas(
        string transition, int actionCount, int added, int replaced, int deleted)
    {
        using var state = new LeaderboardTestState(azure: true);
        var record = Record(score: 100, wave: 1, teamSize: 1, aspectRatio: 2, difficulty: 0.2);
        Assert.True(await state.Store.TryCommitAsync(null, record, default));
        var first = Assert.Single(state.Table!.Transactions);
        Assert.Equal(9, first.Count);
        Assert.All(first, action => Assert.Equal(TableTransactionActionType.Add, action.ActionType));
        var previous = (await state.Store.ReadAsync(record.PlayerId, record.RunId, default))!;
        var next = previous with { Version = Guid.NewGuid().ToString("N"), StorageEtag = null };
        next = transition switch
        {
            "wave" => next with { Wave = 2 },
            "team" => next with { TeamSize = 2 },
            "metadata" => next with { Wave = 2, TeamSize = 2, AspectRatio = 0.5, Difficulty = 0.35 },
            _ => next with { Score = 101 }
        };
        Assert.True(await state.Store.TryCommitAsync(previous, next, default));
        var actions = state.Table.Transactions[1];
        Assert.Equal(actionCount, actions.Count);
        Assert.Equal(added, actions.Count(action => action.ActionType == TableTransactionActionType.Add));
        Assert.Equal(replaced, actions.Count(action => action.ActionType == TableTransactionActionType.UpdateReplace));
        Assert.Equal(deleted, actions.Count(action => action.ActionType == TableTransactionActionType.Delete));
        Assert.Equal(actions.Count, actions.Select(action => action.Entity.RowKey).Distinct().Count());
        Assert.All(actions, action => Assert.Equal("leaderboard", action.Entity.PartitionKey));
        var canonical = Assert.Single(actions, action => action.Entity.RowKey.StartsWith("C:", StringComparison.Ordinal));
        Assert.Equal(previous.StorageEtag, canonical.ETag.ToString());
        Assert.NotEqual(ETag.All, canonical.ETag);
        Assert.All(actions.Where(action => action.Entity.RowKey != canonical.Entity.RowKey
                && action.ActionType != TableTransactionActionType.Add),
            action => Assert.Equal(ETag.All, action.ETag));
        var keys = state.Table.Snapshot().Select(row => row.RowKey).Order(StringComparer.Ordinal);
        Assert.Equal(LeaderboardRows.IndexKeys(next).Append(LeaderboardRows.CanonicalKey(next)).Order(StringComparer.Ordinal), keys);
        Assert.Equal(next, Assert.Single(await state.Store.QueryAsync(new(), 50, default)));
    }

    [Fact]
    public async Task QueriesUsePartitionAndOrderedRowKeyBoundsWithoutHistoryScansOrPointReads()
    {
        using var state = new LeaderboardTestState(azure: true);
        for (var index = 0; index < 7; index++)
            Assert.True(await state.Store.TryCommitAsync(null,
                Record(score: (uint)index, teamSize: 2, aspectRatio: 2, difficulty: 0.42), default));
        state.Table!.PageSize = 2;
        var result = await state.Store.QueryAsync(new(2, "landscape", 0.42), 3, default);
        Assert.Equal(new uint[] { 6, 5, 4 }, result.Select(record => record.Score));
        Assert.Equal(0, state.Table.ReadCount);
        Assert.Equal(2, state.Table.PageCount);
        var query = Assert.Single(state.Table.Queries);
        Assert.Equal(3, query.PageSize);
        Assert.Equal(new[] { "PartitionKey", "RowKey", "Timestamp", "Payload" }, query.Columns);
        var prefix = LeaderboardRows.QueryPrefix(new(2, "landscape", 0.42));
        Assert.Equal($"PartitionKey eq 'leaderboard' and RowKey ge '{prefix}' and RowKey lt '{prefix[..^1]};'", query.Filter);
        Assert.DoesNotContain("Score", query.Filter);
        Assert.DoesNotContain(" or ", query.Filter);
    }

    [Fact]
    public async Task EmptyContinuationPagesAreBoundedAndCannotReturnFalsePartialSuccess()
    {
        using var state = new LeaderboardTestState(azure: true);
        Assert.True(await state.Store.TryCommitAsync(null, Record(), default));
        state.Table!.EmptyQueryPages = AzureTableLeaderboardStore.MaximumQueryPages + 1;
        Error(await state.Service().QueryAsync(new()), "leaderboard_unavailable", 503);
        Assert.Equal(AzureTableLeaderboardStore.MaximumQueryPages, state.Table.PageCount);
    }

    [Theory]
    [InlineData("reverse")]
    [InlineData("duplicate")]
    public async Task UnexpectedQueryOrderOrDuplicateCanonicalRowsFailsClosed(string corruption)
    {
        using var state = new LeaderboardTestState(azure: true);
        Assert.True(await state.Store.TryCommitAsync(null, Record(score: 100), default));
        Assert.True(await state.Store.TryCommitAsync(null, Record(score: 200), default));
        state.Table!.QueryTransform = corruption == "reverse" ? rows => rows.Reverse().ToArray()
            : rows => [rows[0], rows[0]];
        Error(await state.Service().QueryAsync(new()), "leaderboard_unavailable", 503);
    }

    [Theory]
    [InlineData("missing-payload")]
    [InlineData("wrong-payload-type")]
    [InlineData("null")]
    [InlineData("duplicate-field")]
    [InlineData("unknown-field")]
    [InlineData("ignored-etag")]
    [InlineData("ignored-aspect")]
    [InlineData("invalid-name")]
    [InlineData("invalid-score")]
    [InlineData("invalid-difficulty")]
    [InlineData("invalid-version")]
    [InlineData("mismatched-key")]
    [InlineData("wrong-partition")]
    [InlineData("missing-etag")]
    [InlineData("unknown-column")]
    public async Task CorruptAzureCanonicalAndIndexRowsCannotEscapeTheSafeBoundary(string corruption)
    {
        using var state = new LeaderboardTestState(azure: true);
        var record = Record();
        Assert.True(await state.Store.TryCommitAsync(null, record, default));
        foreach (var key in new[] { LeaderboardRows.CanonicalKey(record), LeaderboardRows.IndexKeys(record)[0] })
            state.Table!.Corrupt(key, entity =>
            {
                var payload = entity.GetString("Payload");
                var json = JsonNode.Parse(payload)!;
                switch (corruption)
                {
                    case "missing-payload": entity.Remove("Payload"); return;
                    case "wrong-payload-type": entity["Payload"] = 42; return;
                    case "null": entity["Payload"] = "null"; return;
                    case "duplicate-field": entity["Payload"] = payload[..^1] + ",\"score\":100}"; return;
                    case "unknown-field": json["unknown"] = "not-allowed"; break;
                    case "ignored-etag": json["storageEtag"] = "*"; break;
                    case "ignored-aspect": json["aspect"] = "portrait"; break;
                    case "invalid-name": json["name"] = "not a tag"; break;
                    case "invalid-score": json["score"] = -1; break;
                    case "invalid-difficulty": json["difficulty"] = 3; break;
                    case "invalid-version": json["version"] = "invalid"; break;
                    case "mismatched-key": json["playerId"] = Guid.NewGuid().ToString(); break;
                    case "wrong-partition": entity.PartitionKey = "identity"; return;
                    case "missing-etag": entity.ETag = default; return;
                    case "unknown-column": entity["PrivateData"] = "not-allowed"; return;
                }
                entity["Payload"] = json.ToJsonString();
            });
        await Assert.ThrowsAsync<LeaderboardStoreUnavailableException>(() =>
            state.Store.ReadAsync(record.PlayerId, record.RunId, default));
        Error(await state.Service().QueryAsync(new()), "leaderboard_unavailable", 503);
    }

    [Fact]
    public async Task MissingOldIndexCannotPartiallyCommitACanonicalUpdate()
    {
        using var state = new LeaderboardTestState(azure: true);
        var original = Record();
        Assert.True(await state.Store.TryCommitAsync(null, original, default));
        var previous = (await state.Store.ReadAsync(original.PlayerId, original.RunId, default))!;
        state.Table!.Remove(LeaderboardRows.IndexKeys(original)[0]);
        var next = previous with { Score = 200, Version = Guid.NewGuid().ToString("N"), StorageEtag = null };
        Assert.False(await state.Store.TryCommitAsync(previous, next, default));
        Assert.Equal(original, (await state.Store.ReadAsync(original.PlayerId, original.RunId, default))!
            with { StorageEtag = null });
        Assert.Equal(8, state.Table.Snapshot().Count);
    }

    [Fact]
    public async Task MissingProvisionedTableIsUnavailableAndNeverCreatesLocalFallback()
    {
        using var state = new LeaderboardTestState(azure: true);
        var (browser, player) = await state.Player();
        state.Table!.MissingTable = true;
        Error(await state.Service().QueryAsync(new()), "leaderboard_unavailable", 503);
        Error(await state.Service().SubmitAsync(browser, Submission(player.Id)), "leaderboard_unavailable", 503);
        Assert.Empty(state.Table.Snapshot());
        Assert.False(File.Exists(state.DataFile));
        Assert.False(File.Exists(state.Identity.DataFile));
    }

    [Fact]
    public void BothDomainsUseTheSameRestrictedPrimaryTableClientConfiguration()
    {
        var settings = new AstervoidsWeb.Configuration.IdentitySettings
        {
            Provider = "AzureTable", TableEndpoint = "https://table.example.com", TableName = "PlayerIdentity"
        };
        var table = IdentityTableClient.Create(settings);
        Assert.NotNull(table);
        Assert.Equal(settings.TableName, table.Name);
        Assert.Equal("https://table.example.com/PlayerIdentity", table.Uri.AbsoluteUri.TrimEnd('/'));
        settings.TableEndpoint = "https://table.example.com/?credential=disallowed";
        Assert.Null(IdentityTableClient.Create(settings));
        settings.TableEndpoint = "http://table.example.com";
        Assert.Null(IdentityTableClient.Create(settings));
        settings.TableEndpoint = "https://table.example.com";
        settings.TableName = "invalid-table";
        Assert.Null(IdentityTableClient.Create(settings));
    }
}
