using System.Text.Json;
using System.Text.RegularExpressions;
using AstervoidsWeb.Configuration;
using AstervoidsWeb.Identity;
using AstervoidsWeb.Leaderboards;
using Azure;
using Azure.Data.Tables;
using Microsoft.Extensions.Options;
using Moq;

namespace AstervoidsWeb.Tests;

internal sealed class LeaderboardTestState : IDisposable
{
    public IdentityTestState Identity { get; }
    public FakeLeaderboardTable? Table { get; }
    public string DataFile => LeaderboardHosting.CompanionDataFile(Identity.DataFile);
    public ILeaderboardStore Store { get; }

    public LeaderboardTestState(bool azure = false)
    {
        Identity = new(azure);
        Table = azure ? new() : null;
        Store = RestartStore();
    }

    public ILeaderboardStore RestartStore() => Table is null
        ? new FileLeaderboardStore(DataFile) : new AzureTableLeaderboardStore(Table.Client);

    public LeaderboardService Service(int limit = 50, int maxTeamSize = 4, ILeaderboardStore? store = null,
        PlayerIdentityService? identities = null) => new(
            store ?? RestartStore(), identities ?? Identity.Restart(),
            Options.Create(new LeaderboardSettings { MaxEntries = limit }),
            Options.Create(new SessionSettings { MaxMembersPerSession = maxTeamSize }));

    public async Task<(string Browser, PlayerIdentity Player)> Player(string tag = "Pilot")
    {
        var browser = IdentitySecrets.NewToken();
        var (binding, _) = await IdentityTestState.Root(Identity.Service(), browser, tag);
        return (browser, binding.Identity!);
    }

    public static SubmitScoreRequest Submission(Guid playerId, Guid? runId = null,
        uint score = 100, int wave = 1, int teamSize = 1, double aspectRatio = 1, double difficulty = 0.65) =>
        new(playerId, runId ?? Guid.NewGuid(), score, wave, teamSize, aspectRatio, difficulty);

    public static LeaderboardRecord Record(Guid? playerId = null, Guid? runId = null,
        uint score = 100, int wave = 1, int teamSize = 1, double aspectRatio = 1, double difficulty = 0.65,
        string name = "Pilot") => new(playerId ?? Guid.NewGuid(), runId ?? Guid.NewGuid(), name,
            score, wave, teamSize, aspectRatio, difficulty, Guid.NewGuid().ToString("N"));

    public static T Read<T>(LeaderboardResult result)
    {
        Assert.Equal(200, result.StatusCode);
        return result.Body.Deserialize<T>(IdentityJson.Options)!;
    }

    public static void Recorded(LeaderboardResult result) =>
        Assert.True(Read<RecordedScoreReply>(result).Recorded);

    public static void Error(LeaderboardResult result, string code, int status = 409)
    {
        Assert.Equal(status, result.StatusCode);
        Assert.Equal("{\"error\":{\"code\":\"" + code + "\"}}", result.Body.GetRawText());
    }

    public void Dispose() => Identity.Dispose();
}

// Substitutes only TableClient transport. Production row encoding, CAS,
// transaction composition, filter construction and page consumption run unchanged.
internal sealed class FakeLeaderboardTable
{
    private readonly object _gate = new();
    private readonly Dictionary<string, TableEntity> _rows = new(StringComparer.Ordinal);
    private readonly Mock<TableClient> _client = new();
    private long _version;
    public TableClient Client => _client.Object;
    public List<IReadOnlyList<TableTransactionAction>> Transactions { get; } = [];
    public List<QueryCall> Queries { get; } = [];
    public int ReadCount { get; private set; }
    public int PageCount { get; private set; }
    public int? PageSize { get; set; }
    public int EmptyQueryPages { get; set; }
    public int? FailNextCommit { get; set; }
    public bool CommitBeforeFailure { get; set; }
    public int ConflictingCommits { get; set; }
    public bool MissingTable { get; set; }
    public Func<IReadOnlyList<TableTransactionAction>, Task>? BeforeCommit { get; set; }
    public Func<IReadOnlyList<TableEntity>, IReadOnlyList<TableEntity>>? QueryTransform { get; set; }

    public FakeLeaderboardTable()
    {
        _client.Setup(client => client.GetEntityAsync<TableEntity>(
                It.IsAny<string>(), It.IsAny<string>(), It.IsAny<IEnumerable<string>>(), It.IsAny<CancellationToken>()))
            .Returns((string partition, string row, IEnumerable<string>? _, CancellationToken cancellation) =>
                ReadAsync(partition, row, cancellation));
        _client.Setup(client => client.SubmitTransactionAsync(
                It.IsAny<IEnumerable<TableTransactionAction>>(), It.IsAny<CancellationToken>()))
            .Returns((IEnumerable<TableTransactionAction> actions, CancellationToken cancellation) =>
                CommitAsync(actions.ToArray(), cancellation));
        _client.Setup(client => client.QueryAsync<TableEntity>(
                It.IsAny<string>(), It.IsAny<int?>(), It.IsAny<IEnumerable<string>>(), It.IsAny<CancellationToken>()))
            .Returns((string filter, int? pageSize, IEnumerable<string>? select, CancellationToken cancellation) =>
                Query(filter, pageSize, select, cancellation));
    }

    public IReadOnlyList<TableEntity> Snapshot()
    {
        lock (_gate)
            return _rows.Values.Select(Copy).ToArray();
    }

    public void Corrupt(string key, Action<TableEntity> mutate)
    {
        lock (_gate)
            mutate(_rows[key]);
    }

    public void Remove(string key)
    {
        lock (_gate)
            _rows.Remove(key);
    }

    private async Task<Response<TableEntity>> ReadAsync(string partition, string row, CancellationToken cancellation)
    {
        await Task.Yield();
        cancellation.ThrowIfCancellationRequested();
        Assert.Equal(LeaderboardRows.PartitionKey, partition);
        lock (_gate)
        {
            ReadCount++;
            if (MissingTable)
                throw new RequestFailedException(404, "Unavailable table.", "TableNotFound", null);
            if (!_rows.TryGetValue(row, out var entity))
                throw new RequestFailedException(404, "Missing row.", "ResourceNotFound", null);
            return Response.FromValue(Copy(entity), Mock.Of<Response>());
        }
    }

    private async Task<Response<IReadOnlyList<Response>>> CommitAsync(
        IReadOnlyList<TableTransactionAction> actions, CancellationToken cancellation)
    {
        await Task.Yield();
        if (BeforeCommit is not null)
            await BeforeCommit(actions);
        cancellation.ThrowIfCancellationRequested();
        lock (_gate)
        {
            Transactions.Add(actions);
            if (MissingTable)
                throw new RequestFailedException(404, "Unavailable table.", "TableNotFound", null);
            if (ConflictingCommits > 0)
            {
                ConflictingCommits--;
                throw new RequestFailedException(412, "Version conflict.");
            }
            var failure = FailNextCommit;
            FailNextCommit = null;
            if (failure is not null && !CommitBeforeFailure)
                throw new RequestFailedException(failure.Value, "Unavailable storage.");
            Assert.Equal(actions.Count, actions.Select(action => action.Entity.RowKey).Distinct().Count());
            Assert.InRange(actions.Count, 9, 17);
            foreach (var action in actions)
            {
                Assert.Equal(LeaderboardRows.PartitionKey, action.Entity.PartitionKey);
                var exists = _rows.TryGetValue(action.Entity.RowKey, out var current);
                switch (action.ActionType)
                {
                    case TableTransactionActionType.Add when exists:
                        throw new RequestFailedException(409, "Insert conflict.");
                    case TableTransactionActionType.UpdateReplace:
                    case TableTransactionActionType.Delete:
                        if (!exists)
                            throw new RequestFailedException(404, "Missing index.", "ResourceNotFound", null);
                        if (action.ETag != ETag.All && current!.ETag != action.ETag)
                            throw new RequestFailedException(412, "Version conflict.");
                        if (action.Entity.RowKey.StartsWith("C:", StringComparison.Ordinal))
                            Assert.NotEqual(ETag.All, action.ETag);
                        break;
                    case TableTransactionActionType.Add:
                        break;
                    default:
                        throw new InvalidOperationException("Upserts and partial merges are not allowed.");
                }
            }
            foreach (var action in actions)
            {
                if (action.ActionType == TableTransactionActionType.Delete)
                {
                    _rows.Remove(action.Entity.RowKey);
                    continue;
                }
                var stored = Copy((TableEntity)action.Entity);
                stored.ETag = new ETag($"\"storage-{++_version}\"");
                _rows[action.Entity.RowKey] = stored;
            }
            if (failure is not null)
                throw new RequestFailedException(failure.Value, "Ambiguous storage failure.");
            return Response.FromValue<IReadOnlyList<Response>>(
                actions.Select(_ => Mock.Of<Response>()).ToArray(), Mock.Of<Response>());
        }
    }

    private AsyncPageable<TableEntity> Query(
        string filter, int? pageSize, IEnumerable<string>? select, CancellationToken cancellation)
    {
        var match = Regex.Match(filter,
            "^PartitionKey eq 'leaderboard' and RowKey ge '([^']+)' and RowKey lt '([^']+)'$");
        Assert.True(match.Success, "Queries must specify only one partition and a bounded row-key range.");
        Assert.InRange(pageSize ?? 0, 1, LeaderboardSettings.MaximumEntries);
        IReadOnlyList<TableEntity> rows;
        lock (_gate)
        {
            Queries.Add(new(filter, pageSize, select?.ToArray() ?? []));
            if (MissingTable)
                throw new RequestFailedException(404, "Unavailable table.", "TableNotFound", null);
            rows = _rows.Values.Where(row =>
                    StringComparer.Ordinal.Compare(row.RowKey, match.Groups[1].Value) >= 0
                    && StringComparer.Ordinal.Compare(row.RowKey, match.Groups[2].Value) < 0)
                .OrderBy(row => row.RowKey, StringComparer.Ordinal).Select(Copy).ToArray();
        }
        if (QueryTransform is not null)
            rows = QueryTransform(rows);
        return AsyncPageable<TableEntity>.FromPages(Pages(rows, PageSize ?? pageSize!.Value, cancellation));
    }

    private IEnumerable<Page<TableEntity>> Pages(
        IReadOnlyList<TableEntity> rows, int pageSize, CancellationToken cancellation)
    {
        for (var index = 0; index < EmptyQueryPages; index++)
        {
            cancellation.ThrowIfCancellationRequested();
            PageCount++;
            yield return Page<TableEntity>.FromValues([], "more", Mock.Of<Response>());
        }
        for (var offset = 0; offset < rows.Count || offset == 0; offset += pageSize)
        {
            cancellation.ThrowIfCancellationRequested();
            PageCount++;
            yield return Page<TableEntity>.FromValues(rows.Skip(offset).Take(pageSize).ToArray(),
                offset + pageSize < rows.Count ? "more" : null, Mock.Of<Response>());
        }
    }

    private static TableEntity Copy(TableEntity entity)
    {
        var copy = new TableEntity(entity.PartitionKey, entity.RowKey) { ETag = entity.ETag };
        foreach (var (key, value) in entity)
            copy[key] = value;
        return copy;
    }

    internal sealed record QueryCall(string Filter, int? PageSize, IReadOnlyList<string> Columns);
}

internal sealed class GatedLeaderboardStore(ILeaderboardStore inner) : ILeaderboardStore
{
    private int _blocked;
    public TaskCompletionSource Reached { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public Task<LeaderboardRecord?> ReadAsync(Guid playerId, Guid runId, CancellationToken cancellationToken) =>
        inner.ReadAsync(playerId, runId, cancellationToken);

    public Task<IReadOnlyList<LeaderboardRecord>> QueryAsync(
        LeaderboardQueryRequest query, int limit, CancellationToken cancellationToken) =>
        inner.QueryAsync(query, limit, cancellationToken);

    public async Task<bool> TryCommitAsync(
        LeaderboardRecord? previous, LeaderboardRecord next, CancellationToken cancellationToken)
    {
        if (Interlocked.CompareExchange(ref _blocked, 1, 0) == 0)
        {
            Reached.TrySetResult();
            await Release.Task.WaitAsync(TimeSpan.FromSeconds(10), cancellationToken);
        }
        return await inner.TryCommitAsync(previous, next, cancellationToken);
    }
}
