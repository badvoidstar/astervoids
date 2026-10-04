using System.Text.Json;
using AstervoidsWeb.Configuration;
using AstervoidsWeb.Identity;
using Azure;
using Azure.Data.Tables;
using Microsoft.Extensions.Options;
using Moq;

namespace AstervoidsWeb.Tests;

internal sealed class IdentityTestState : IDisposable
{
    public string DirectoryPath { get; } = Path.GetFullPath(Path.Combine(
        "App_Data", "identity-tests", Guid.NewGuid().ToString("N")));
    public string DataFile => Path.Combine(DirectoryPath, "identity.json");
    public FakeIdentityTable? Table { get; }
    public IIdentityStore Store { get; }

    public IdentityTestState(bool azure = false)
    {
        if (azure)
        {
            Table = new FakeIdentityTable();
            Store = new AzureTableIdentityStore(Table.Client);
        }
        else
        {
            Store = new FileIdentityStore(DataFile);
        }
    }

    public PlayerIdentityService Service(bool prompt = true) =>
        new(Store, Options.Create(new IdentitySettings { PromptOnRoot = prompt }));

    public PlayerIdentityService Restart() =>
        new(Table is null ? new FileIdentityStore(DataFile) : new AzureTableIdentityStore(Table.Client),
            Options.Create(new IdentitySettings()));

    public static T Read<T>(IdentityResult result, int status = 200)
    {
        Assert.Equal(status, result.StatusCode);
        return result.Body.Deserialize<T>(IdentityJson.Options)!;
    }

    public static void Error(IdentityResult result, string code, int status = 409)
    {
        Assert.Equal(status, result.StatusCode);
        Assert.Equal(code, result.Body.GetProperty("error").GetProperty("code").GetString());
        Assert.Single(result.Body.EnumerateObject());
        Assert.Single(result.Body.GetProperty("error").EnumerateObject());
    }

    public static ExpectedBinding Expect(BrowserBinding binding) => new(binding.Identity?.Id, binding.Etag);

    public static async Task<ResolveIdentityReply> Resolve(
        PlayerIdentityService service, string browser, string? invite = null) =>
        Read<ResolveIdentityReply>(await service.ResolveAsync(browser, new(invite)));

    public static async Task<(BrowserBinding Binding, RootIdentityRequest Request)> Root(
        PlayerIdentityService service, string browser, string tag = "Pilot")
    {
        var resolved = await Resolve(service, browser);
        var request = new RootIdentityRequest(Guid.NewGuid(), Expect(resolved.Binding), tag);
        return (Read<BindingReply>(await service.CreateRootAsync(browser, request), 201).Binding, request);
    }

    public static async Task<string> Self(PlayerIdentityService service, string browser, BrowserBinding binding) =>
        Read<InviteTokenReply>(await service.SelfInviteAsync(browser, new(Expect(binding)))).InviteToken;

    public void Dispose()
    {
        if (Directory.Exists(DirectoryPath))
            Directory.Delete(DirectoryPath, recursive: true);
    }
}

// Exercises the real Azure provider's row serialization and transaction actions.
// Only the remote TableClient transport is substituted; this is not a cloud test.
internal sealed class FakeIdentityTable
{
    private readonly object _gate = new();
    private readonly Dictionary<string, TableEntity> _rows = new(StringComparer.Ordinal);
    private long _version;
    private readonly Mock<TableClient> _client = new();
    public TableClient Client => _client.Object;
    public List<IReadOnlyList<TableTransactionAction>> Transactions { get; } = [];
    public int? FailNextCommit { get; set; }
    public bool CommitBeforeFailure { get; set; }
    public bool MissingTable { get; set; }
    public Func<IReadOnlyList<TableTransactionAction>, Task>? BeforeCommit { get; set; }

    public FakeIdentityTable()
    {
        _client.Setup(client => client.GetEntityAsync<TableEntity>(
                It.IsAny<string>(), It.IsAny<string>(), It.IsAny<IEnumerable<string>>(),
                It.IsAny<CancellationToken>()))
            .Returns((string partition, string row, IEnumerable<string>? _, CancellationToken cancellation) =>
                ReadAsync(partition, row, cancellation));
        _client.Setup(client => client.SubmitTransactionAsync(
                It.IsAny<IEnumerable<TableTransactionAction>>(), It.IsAny<CancellationToken>()))
            .Returns((IEnumerable<TableTransactionAction> actions, CancellationToken cancellation) =>
                CommitAsync(actions.ToArray(), cancellation));
    }

    public IReadOnlyList<TableEntity> Snapshot()
    {
        lock (_gate)
            return _rows.Values.Select(Copy).ToArray();
    }

    private async Task<Response<TableEntity>> ReadAsync(string partition, string key, CancellationToken cancellation)
    {
        await Task.Yield();
        cancellation.ThrowIfCancellationRequested();
        Assert.Equal(IdentityRows.PartitionKey, partition);
        lock (_gate)
        {
            if (MissingTable)
                throw new RequestFailedException(404, "Unavailable table.", "TableNotFound", null);
            if (!_rows.TryGetValue(key, out var entity))
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
            var failure = FailNextCommit;
            FailNextCommit = null;
            if (MissingTable)
                throw new RequestFailedException(404, "Unavailable table.", "TableNotFound", null);
            if (failure is not null && !CommitBeforeFailure)
                throw new RequestFailedException(failure.Value, "Unavailable storage.");
            Assert.Equal(actions.Count, actions.Select(action => action.Entity.RowKey).Distinct().Count());
            foreach (var action in actions)
            {
                Assert.Equal(IdentityRows.PartitionKey, action.Entity.PartitionKey);
                var exists = _rows.TryGetValue(action.Entity.RowKey, out var current);
                switch (action.ActionType)
                {
                    case TableTransactionActionType.Add when exists:
                        throw new RequestFailedException(409, "Insert conflict.");
                    case TableTransactionActionType.UpdateReplace
                        when !exists || current!.ETag != action.ETag:
                        throw new RequestFailedException(412, "Version conflict.");
                    case TableTransactionActionType.Add:
                    case TableTransactionActionType.UpdateReplace:
                        break;
                    default:
                        throw new InvalidOperationException("Only insert and ETag replace are permitted.");
                }
            }
            foreach (var action in actions)
            {
                var entity = (TableEntity)action.Entity;
                var stored = Copy(entity);
                stored.ETag = new ETag($"\"storage-{++_version}\"");
                _rows[entity.RowKey] = stored;
            }
            if (failure is not null)
                throw new RequestFailedException(failure.Value, "Ambiguous transport failure.");
            return Response.FromValue<IReadOnlyList<Response>>(
                actions.Select(_ => Mock.Of<Response>()).ToArray(), Mock.Of<Response>());
        }
    }

    private static TableEntity Copy(TableEntity entity) => new(entity.PartitionKey, entity.RowKey)
    {
        ETag = entity.ETag,
        ["Payload"] = entity.GetString("Payload")
    };
}

internal sealed class GatedIdentityStore(
    IIdentityStore inner, Func<IReadOnlyList<IdentityWrite>, bool> shouldBlock) : IIdentityStore
{
    private int _blocked;
    public TaskCompletionSource Reached { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public Task<IdentityRow?> ReadAsync(string key, CancellationToken cancellationToken) =>
        inner.ReadAsync(key, cancellationToken);

    public async Task<bool> TryCommitAsync(IReadOnlyList<IdentityWrite> writes, CancellationToken cancellationToken)
    {
        if (shouldBlock(writes) && Interlocked.CompareExchange(ref _blocked, 1, 0) == 0)
        {
            Reached.TrySetResult();
            await Release.Task.WaitAsync(TimeSpan.FromSeconds(10), cancellationToken);
        }
        return await inner.TryCommitAsync(writes, cancellationToken);
    }
}
