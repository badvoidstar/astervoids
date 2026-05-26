using System.Runtime.CompilerServices;
using System.Threading.Channels;
using AstervoidsWeb.Configuration;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;

namespace AstervoidsWeb.Services;

/// <summary>
/// Cosmos DB-backed implementation of <see cref="ISessionDirectory"/>.
///
/// Partition key: <c>/regionId</c>.
/// TTL is enabled on the container (default -1 = immortal; documents get a short TTL
/// when soft-eviction is desired).
///
/// Change feed is consumed via a processor with one lease container per app instance.
/// </summary>
public sealed class CosmosSessionDirectory : ISessionDirectory, IAsyncDisposable
{
    private readonly CosmosClient _client;
    private readonly string _databaseId;
    private readonly string _containerId;
    private readonly ILogger<CosmosSessionDirectory> _logger;

    private Container? _container;
    private Container? _leaseContainer;
    private ChangeFeedProcessor? _processor;
    private readonly List<ChannelWriter<SessionDirectoryChange>> _subscribers = new();
    private readonly object _subscriberLock = new();

    private const int ChannelCapacity = 128;
    private const string LeaseContainerId = "sessions-leases";

    public CosmosSessionDirectory(IOptions<DirectoryOptions> options, ILogger<CosmosSessionDirectory> logger)
    {
        var cfg = options.Value.Cosmos;
        _client = new CosmosClient(cfg.ConnectionString);
        _databaseId = cfg.DatabaseId;
        _containerId = cfg.ContainerId;
        _logger = logger;
    }

    /// <summary>
    /// Initialises the database, containers, and change feed processor.
    /// Call once at startup (e.g. from a hosted service or DI extension).
    /// </summary>
    public async Task InitializeAsync(CancellationToken ct = default)
    {
        var database = await _client.CreateDatabaseIfNotExistsAsync(_databaseId, cancellationToken: ct);

        // Sessions container with TTL enabled; partition key /regionId
        var containerResponse = await database.Database.CreateContainerIfNotExistsAsync(
            new ContainerProperties
            {
                Id = _containerId,
                PartitionKeyPath = "/regionId",
                DefaultTimeToLive = -1   // -1 = immortal by default; per-doc TTL opt-in
            },
            cancellationToken: ct);
        _container = containerResponse.Container;

        // Lease container for the change feed processor
        var leaseResponse = await database.Database.CreateContainerIfNotExistsAsync(
            new ContainerProperties
            {
                Id = LeaseContainerId,
                PartitionKeyPath = "/id"
            },
            cancellationToken: ct);
        _leaseContainer = leaseResponse.Container;

        // One processor instance per app instance, uniquely named
        var instanceName = $"{Environment.MachineName}-{Guid.NewGuid():N}";

        _processor = _container
            .GetChangeFeedProcessorBuilder<CosmosSessionDocument>(
                processorName: "sessions-mirror",
                onChangesDelegate: HandleChangesAsync)
            .WithInstanceName(instanceName)
            .WithLeaseContainer(_leaseContainer)
            .Build();

        await _processor.StartAsync();
    }

    public async Task UpsertAsync(SessionDirectoryEntry entry, CancellationToken ct = default)
    {
        EnsureInitialized();
        var doc = CosmosSessionDocument.FromEntry(entry);
        await _container!.UpsertItemAsync(doc, new PartitionKey(doc.RegionId), cancellationToken: ct);
    }

    public async Task RemoveAsync(Guid sessionId, CancellationToken ct = default)
    {
        EnsureInitialized();
        // Cross-partition query: we don't have the regionId (partition key) at this call site.
        // This is acceptable for the low-rate lifecycle path (removes happen on session destroy,
        // not per-frame). Phase 3 may evolve the interface to accept regionId to enable a
        // point-delete instead.
        var query = new QueryDefinition("SELECT * FROM c WHERE c.id = @id")
            .WithParameter("@id", sessionId.ToString("D"));
        using var iter = _container!.GetItemQueryIterator<CosmosSessionDocument>(
            query, requestOptions: new QueryRequestOptions { MaxItemCount = 1 });

        while (iter.HasMoreResults)
        {
            var page = await iter.ReadNextAsync(ct);
            foreach (var doc in page)
            {
                await _container!.DeleteItemAsync<CosmosSessionDocument>(
                    doc.Id, new PartitionKey(doc.RegionId), cancellationToken: ct);
            }
        }
    }

    public async Task<IReadOnlyList<SessionDirectoryEntry>> ListAsync(CancellationToken ct = default)
    {
        EnsureInitialized();
        var results = new List<SessionDirectoryEntry>();
        var query = new QueryDefinition("SELECT * FROM c");
        using var iter = _container!.GetItemQueryIterator<CosmosSessionDocument>(query);
        while (iter.HasMoreResults)
        {
            var page = await iter.ReadNextAsync(ct);
            results.AddRange(page.Select(d => d.ToEntry()));
        }
        return results;
    }

    public async IAsyncEnumerable<SessionDirectoryChange> SubscribeAsync(
        [EnumeratorCancellation] CancellationToken ct)
    {
        var channel = Channel.CreateBounded<SessionDirectoryChange>(
            new BoundedChannelOptions(ChannelCapacity)
            {
                FullMode = BoundedChannelFullMode.DropOldest,
                SingleReader = true,
                SingleWriter = false
            });

        lock (_subscriberLock)
        {
            _subscribers.Add(channel.Writer);
        }

        try
        {
            await foreach (var change in channel.Reader.ReadAllAsync(ct))
            {
                yield return change;
            }
        }
        finally
        {
            lock (_subscriberLock)
            {
                _subscribers.Remove(channel.Writer);
            }
            channel.Writer.TryComplete();
        }
    }

    private async Task HandleChangesAsync(
        ChangeFeedProcessorContext context,
        IReadOnlyCollection<CosmosSessionDocument> changes,
        CancellationToken ct)
    {
        List<ChannelWriter<SessionDirectoryChange>> snapshot;
        lock (_subscriberLock)
        {
            snapshot = new List<ChannelWriter<SessionDirectoryChange>>(_subscribers);
        }

        foreach (var doc in changes)
        {
            // Cosmos TTL-expired docs arrive as deletes via the change feed.
            // A TTL expiry appears as a regular change with the document still present;
            // we treat all change-feed events as Upserted and rely on RemoveAsync for
            // explicit removals (which set TTL=0 or delete directly).
            var change = new SessionDirectoryChange(
                SessionDirectoryChangeKind.Upserted,
                doc.ToEntry());

            foreach (var writer in snapshot)
            {
                writer.TryWrite(change);
            }
        }

        await Task.CompletedTask;
    }

    private void EnsureInitialized()
    {
        if (_container == null)
            throw new InvalidOperationException(
                "CosmosSessionDirectory has not been initialized. Call InitializeAsync first.");
    }

    public async ValueTask DisposeAsync()
    {
        if (_processor != null)
        {
            try { await _processor.StopAsync(); }
            catch (Exception ex) { _logger.LogWarning(ex, "Error stopping Cosmos change feed processor"); }
        }
        _client.Dispose();
    }

    // ── Internal Cosmos document shape ──────────────────────────────────

    private sealed class CosmosSessionDocument
    {
        [System.Text.Json.Serialization.JsonPropertyName("id")]
        public string Id { get; set; } = "";

        [System.Text.Json.Serialization.JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [System.Text.Json.Serialization.JsonPropertyName("regionId")]
        public string RegionId { get; set; } = "";

        [System.Text.Json.Serialization.JsonPropertyName("memberCount")]
        public int MemberCount { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("maxMembers")]
        public int MaxMembers { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("createdAt")]
        public DateTime CreatedAt { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("ttl")]
        public int? Ttl { get; set; }

        public static CosmosSessionDocument FromEntry(SessionDirectoryEntry entry) => new()
        {
            Id = entry.SessionId.ToString("D"),
            Name = entry.Name,
            RegionId = entry.RegionId,
            MemberCount = entry.MemberCount,
            MaxMembers = entry.MaxMembers,
            CreatedAt = entry.CreatedAt
        };

        public SessionDirectoryEntry ToEntry() => new(
            Guid.Parse(Id),
            Name,
            RegionId,
            MemberCount,
            MaxMembers,
            CreatedAt);
    }
}
